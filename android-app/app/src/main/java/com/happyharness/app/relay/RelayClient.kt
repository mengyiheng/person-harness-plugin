/**
 * 中继连接层（协议 v2.0 §2-§6，手机侧）—— 对齐 ArkTS chat/RelayClient.ets。
 * 单条 WS 文本帧隧道：hello → attached → e2e offer/accept/confirm → 密文业务帧。
 *   - HTTP 一元调用：open(kind=http) + data(fin) → http-head + data* + close
 *   - WS 流：open(kind=ws, /api/remote.mux) → 101 → data 帧透明承载 mux 文本
 * 断线重连：指数退避 1→30s；重连后所有 stream 视为已死，经 onReset 通知上层重建。
 *
 * 关键机制（对齐 交接文档 §4，勿回退）：
 *   1. sendChain / openChain：加解密虽是同步 CPU 运算，仍保留 FIFO 串行队列，
 *      保证与 ArkTS 版相同的发送/接收保序语义（大响应多块乱序 = 乱码）。
 *   2. eph 未就绪竞态：generate 期间到达的 e2e 帧进 pendingE2E，就绪后按序回放。
 *      （Kotlin 侧 X25519 生成是同步的，竞态概率为零，但保留队列防御将来换异步实现。）
 *   3. 大负载分块：协议 data 上限 64KB/帧；参照 ArkWS 24KB + 8ms 节流纪律，
 *      本端发送大 body 时按 24KB 分块 + 8ms 间隔，防中继/对端队列 burst 丢帧。
 */
package com.happyharness.app.relay

import android.util.Log
import com.happyharness.app.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.min
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

private const val TAG = "HHRelay"
private const val PING_INTERVAL_MS = 25000L
private const val RECONNECT_MAX_MS = 30000L
private const val HANDSHAKE_TIMEOUT_MS = 20000L

/** 🔴 发送分块纪律：24KB/块 + 8ms 节流（对齐 companion/插件，勿调大） */
private const val CHUNK_SIZE = 24 * 1024
private const val CHUNK_INTERVAL_MS = 8L

/** 密文内层包装：{rest:{...业务帧}} */
private const val SEALED_INNER_KEY = "rest"

class HttpResult(val status: Int, val bodyText: String)

/** 二进制安全 HTTP 响应（WebView 完整模式：资源字节级透传 + 响应头） */
class HttpBinResult(
    val status: Int,
    val headers: Map<String, String>,
    val body: ByteArray
)

/** 一条中继业务流（phone 发起）：缓存事件，支持按谓词等待 */
private class RelayStream(val streamId: String) {
    /** 逐帧流式消费（SSE 用）：push 时先回调，不等 wait（对齐 ArkTS sink） */
    var sink: ((JSONObject) -> Unit)? = null

    private val lock = Object()
    private val events = ArrayList<JSONObject>()
    private val waiters = ArrayList<Pair<(JSONObject) -> Boolean, CompletableDeferred<JSONObject>>>()
    private var closed = false

    fun push(f: JSONObject) {
        runCatching { sink?.invoke(f) }
        val matched = ArrayList<CompletableDeferred<JSONObject>>()
        synchronized(lock) {
            if (f.optString("type") == "close") closed = true
            val it = waiters.iterator()
            while (it.hasNext()) {
                val (pred, deferred) = it.next()
                if (pred(f)) {
                    matched.add(deferred)
                    it.remove()
                }
            }
            events.add(f)
            lock.notifyAll()
        }
        matched.forEach { it.complete(f) }
    }

    /** 等到第一个满足谓词的帧（先查缓存），timeoutMs 超时抛错 */
    suspend fun wait(pred: (JSONObject) -> Boolean, timeoutMs: Long = 15000): JSONObject {
        synchronized(lock) {
            events.firstOrNull(pred)?.let { return it }
            if (closed) throw RuntimeException("stream $streamId 已关闭")
        }
        val deferred = CompletableDeferred<JSONObject>()
        try {
            synchronized(lock) {
                // 双检：登记前可能已有新事件
                events.firstOrNull(pred)?.let { return it }
                waiters.add(pred to deferred)
            }
            // 锁外等待：push 需要拿锁才能分发，持锁 await 会死锁
            withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            synchronized(lock) { waiters.removeAll { it.second === deferred } }
            throw RuntimeException("stream 事件超时: $streamId")
        } finally {
            synchronized(lock) { waiters.removeAll { it.second === deferred } }
        }
        return deferred.await()
    }

    fun dataChunks(): ByteArray {
        synchronized(lock) {
            val parts = events.filter { it.optString("type") == "data" && it.has("data") }
                .map { B64u.decode(it.getString("data")) }
            return B64u.concat(parts)
        }
    }

    fun hasDataFin(): Boolean {
        synchronized(lock) {
            return events.any { it.optString("type") == "data" && it.optBoolean("fin", false) }
        }
    }
}

/** mux 通道（承载 /api/remote.mux 文本帧） */
class MuxChannel internal constructor(
    private val client: RelayClient,
    val clientId: String,
    val onText: (String) -> Unit,
    val onDown: (String) -> Unit
) {
    /** 发一条 mux 文本帧（自动 data + fin + base64url） */
    fun send(text: String) {
        client.sendData(clientId, B64u.encode(B64u.utf8(text)), true)
    }

    fun close() {
        client.closeStream(clientId)
    }
}

class RelayClient(
    private val relayUrl: String,
    private val credential: String,
    private val identity: IdentityKey
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(0, TimeUnit.MILLISECONDS) // 应用层 ping，不用 WS 控制帧
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private var ws: WebSocket? = null
    private var attachId = ""
    private var pcPub = ""
    private var peerEph = ""
    private var eph: EphemeralKey? = null
    private var box: E2EBox? = null
    private val opened = AtomicBoolean(false)
    private val ready = AtomicBoolean(false)

    private val streams = ConcurrentHashMap<String, RelayStream>()
    private val muxes = ConcurrentHashMap<String, MuxChannel>()

    private val wantConnected = AtomicBoolean(false)
    private val reconnecting = AtomicBoolean(false)
    private val backoffMs = AtomicInteger(1000)
    private val pendingE2E = ArrayList<JSONObject>()

    private var pingFuture: java.util.concurrent.ScheduledFuture<*>? = null
    @Volatile private var lastPongAt: Long = 0L // 🔴 半开死链看门狗：最近一次收到对端任何帧的时间
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "hh-relay-ping").apply { isDaemon = true }
    }

    /** 密文帧发送队列：保证 FIFO（与 ArkTS sendChain 对齐） */
    private val sendExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "hh-relay-send").apply { isDaemon = true }
    }
    /** 接收帧解密/分发队列：保证按到达顺序 dispatch（与 ArkTS openChain 对齐） */
    private val openExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "hh-relay-recv").apply { isDaemon = true }
    }

    /** 握手完成钩子（connectOnce 期间挂接） */
    private val readyHook = java.util.concurrent.atomic.AtomicReference<CompletableDeferred<Unit>?>(null)

    var onReset: ((String) -> Unit)? = null
    var onReady: (() -> Unit)? = null
    var onDirectChanged: ((Boolean) -> Unit)? = null
    private var punch: PunchClient? = null
    private var udpProbe: UdpProbeClient? = null
    @Volatile private var punchDirect = false
    @Volatile private var udpDirect = false
    private val udpSeen = LinkedHashMap<String, Boolean>()

    fun isReady(): Boolean = ready.get()
    fun isDirect(): Boolean = punchDirect || udpDirect

    fun debugDropUdpTraffic() {
        if (!BuildConfig.DEBUG) return
        udpProbe?.debugDropTraffic()
    }

    private fun updateDirectState() {
        onDirectChanged?.invoke(punchDirect || udpDirect)
    }

    private fun clearDirectState() {
        punchDirect = false
        udpDirect = false
        updateDirectState()
    }

    private fun isDuplicateUdp(frame: JSONObject): Boolean {
        val id = frame.optString("udpId")
        if (id.isEmpty()) return false
        synchronized(udpSeen) {
            if (udpSeen.containsKey(id)) return true
            udpSeen[id] = true
            while (udpSeen.size > 4096) {
                val oldest = udpSeen.keys.iterator()
                if (oldest.hasNext()) {
                    oldest.next()
                    oldest.remove()
                }
            }
        }
        return false
    }

    // ---------------- 连接生命周期 ----------------

    /** 建立隧道并完成 E2E 握手；返回 = E2E 就绪。断线自动重连（指数退避）。 */
    suspend fun start() {
        wantConnected.set(true)
        connectOnce()
    }

    fun stop() {
        wantConnected.set(false)
        pingFuture?.cancel(false)
        pingFuture = null
        punch?.stop()
        punch = null
        udpProbe?.stop()
        udpProbe = null
        clearDirectState()
        synchronized(udpSeen) { udpSeen.clear() }
        killStreams("本地主动断开")
        ready.set(false)
        opened.set(false)
        ws?.close(1000, "client stop")
        ws = null
    }

    private suspend fun connectOnce() {
        if (!wantConnected.get()) return
        punch?.stop()
        punch = null
        udpProbe?.stop()
        udpProbe = null
        clearDirectState()
        synchronized(udpSeen) { udpSeen.clear() }
        killStreams("重连")
        ready.set(false)
        box = null
        peerEph = ""
        synchronized(pendingE2E) { pendingE2E.clear() }

        val handshake = CompletableDeferred<Unit>()
        readyHook.set(handshake)
        val failed = AtomicBoolean(false)
        val timeoutJob = scheduler.schedule({
            if (failed.compareAndSet(false, true)) {
                handshake.completeExceptionally(RuntimeException("ERR_TIMEOUT: 中继连接/E2E 握手超时"))
                ws?.close(1000, "timeout")
                scheduleReconnect()
            }
        }, HANDSHAKE_TIMEOUT_MS, TimeUnit.MILLISECONDS)

        val request = Request.Builder()
            .url(relayUrl)
            .header("Authorization", "Bearer $credential")
            .build()

        Log.i(TAG, "connect 开始: $relayUrl")
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(web: WebSocket, response: Response) {
                opened.set(true)
                web.send(JSONObject().put("type", "hello").toString())
            }

            override fun onMessage(web: WebSocket, text: String) {
                onFrameText(text)
            }

            override fun onClosed(web: WebSocket, code: Int, reason: String) {
                onCloseCommon(code)
            }

            override fun onFailure(web: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "隧道 WS 错误详情: ${t.message}")
                onCloseCommon(-1)
            }
        })

        try {
            withTimeout(HANDSHAKE_TIMEOUT_MS + 2000) { handshake.await() }
            timeoutJob.cancel(false)
            if (failed.compareAndSet(false, true)) {
                backoffMs.set(1000)
                startPing()
            }
        } catch (e: TimeoutCancellationException) {
            if (failed.compareAndSet(false, true)) {
                ws?.close(1000, "timeout")
                scheduleReconnect()
                throw RuntimeException("ERR_TIMEOUT: 中继连接/E2E 握手超时")
            }
        } catch (e: Exception) {
            if (failed.compareAndSet(false, true)) {
                scheduleReconnect()
                throw e
            }
        }
    }

    private fun onCloseCommon(code: Int) {
        val wasReady = ready.get()
        opened.set(false)
        ready.set(false)
        pingFuture?.cancel(false)
        pingFuture = null
        punch?.stop()
        punch = null
        udpProbe?.stop()
        udpProbe = null
        clearDirectState()
        synchronized(udpSeen) { udpSeen.clear() }
        killStreams("中继连接断开")
        Log.w(TAG, "隧道关闭 code=$code wasReady=$wasReady")
        readyHook.getAndSet(null)?.let { hook ->
            if (hook.isActive && !hook.isCompleted) {
                hook.completeExceptionally(RuntimeException("ERR_NETWORK: 中继连接被关闭"))
            }
        }
        if (wasReady && wantConnected.get()) {
            onReset?.invoke("中继连接断开")
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (!wantConnected.get() || !reconnecting.compareAndSet(false, true)) return
        val delay = backoffMs.get().toLong()
        backoffMs.set(min(backoffMs.get() * 2, RECONNECT_MAX_MS.toInt()))
        Log.i(TAG, "${delay}ms 后重连中继")
        scheduler.schedule({
            reconnecting.set(false)
            if (wantConnected.get()) {
                // 异步重连：失败由下一轮 scheduleReconnect 接管
                Thread {
                    try {
                        kotlinx.coroutines.runBlocking { connectOnce() }
                    } catch (e: Exception) {
                        Log.w(TAG, "重连失败: ${e.message}")
                    }
                }.start()
            }
        }, delay, TimeUnit.MILLISECONDS)
    }

    private fun startPing() {
        stopPing()
        lastPongAt = System.currentTimeMillis()
        pingFuture = scheduler.scheduleAtFixedRate({
            if (opened.get()) {
                // 🔴 半开 TCP 看门狗（2026-10-26 对齐 ArkTS 修复）：超过 2 个 ping 周期 + 5s
                // 没有任何入帧，判定死链，主动 cancel 走 onFailure → 重连路径
                val silent = System.currentTimeMillis() - lastPongAt
                if (silent > PING_INTERVAL_MS * 2 + 5000) {
                    Log.w(TAG, "pong 超时（${silent}ms 无入帧），判定半开死链，强制重连")
                    ready.set(false)
                    stopPing()
                    killStreams("pong 超时，判定死链")
                    onReset?.invoke("中继链路失去响应")
                    runCatching { ws?.cancel() }
                    return@scheduleAtFixedRate
                }
                sendRaw(JSONObject().put("type", "ping").toString())
            }
        }, PING_INTERVAL_MS, PING_INTERVAL_MS, TimeUnit.MILLISECONDS)
    }

    private fun stopPing() {
        pingFuture?.cancel(false)
        pingFuture = null
    }

    private fun killStreams(reason: String) {
        streams.clear()
        // 对齐 ArkTS：mux 通道一律回调 onDown（本地 stop / 重连 / 对端离开都要让上层感知流已死）
        val old = muxes.values.toList()
        muxes.clear()
        old.forEach { m -> runCatching { m.onDown(reason) } }
    }

    // ---------------- 帧收发 ----------------

    private fun sendRaw(text: String) {
        val frame = try { JSONObject(text) } catch (_: Exception) { null }
        if (frame != null && frame.has("e2e") && frame.optString("attachId") == attachId) {
            val udp = udpProbe
            if (udp?.isDirect() == true && udp.send(frame)) return
            val p = punch
            if (p?.isEstablished() == true) {
                p.send(frame)
                return
            }
        }
        val w = ws ?: return
        if (!opened.get()) return
        try {
            if (!w.send(text)) {
                Log.e(TAG, "帧发送失败（队列满/已断），主动断开触发重连")
                ready.set(false)
                runCatching { w.cancel() }
            }
        } catch (e: Exception) {
            Log.e(TAG, "帧发送异常: ${e.message}，主动断开触发重连")
            ready.set(false)
            runCatching { w.cancel() }
        }
    }

    private fun startPunch() {
        try {
            val uri = java.net.URI(relayUrl)
            val p = PunchClient(
                uri.host,
                (if (uri.port > 0) uri.port else 80) + 5,
                attachId,
                credential,
                { frame -> sendRaw(frame.toString()) },
                { frame -> onFrameText(frame.toString()) },
                { direct -> punchDirect = direct; updateDirectState() }
            )
            punch = p
            p.start()
        } catch (e: Exception) {
            Log.w(TAG, "punch 初始化失败，继续使用中继: ${e.message}")
        }
    }

    private fun startUdpProbe() {
        udpProbe?.stop()
        val probe = UdpProbeClient(
            attachId = attachId,
            sendRelay = { frame -> sendRaw(frame.toString()) },
            onFrame = { frame -> onFrameText(frame.toString()) },
            onDirect = { direct -> udpDirect = direct; updateDirectState() },
            onDown = { frames -> frames.forEach { frame -> sendRaw(frame.toString()) } }
        )
        udpProbe = probe
        probe.start()
    }

    /** 密文业务帧：明文={rest:业务帧}（不含 attachId/e2e），封包 {type,attachId,streamId,fin?,e2e} */
    private fun sendSealed(frame: JSONObject) {
        val b = box
        val att = frame.optString("attachId", "")
        if (b == null || att.isEmpty()) {
            Log.e(TAG, "sendSealed 前置不满足（box/attachId）")
            return
        }
        val streamId = frame.optString("streamId", "-")
        val type = frame.optString("type")
        val fin = frame.optBoolean("fin", false)
        sendExecutor.execute {
            try {
                val inner = JSONObject().put(SEALED_INNER_KEY, frame)
                val sealed = b.seal(streamId, type, inner.toString())
                val wire = JSONObject()
                    .put("type", type)
                    .put("attachId", att)
                    .put("streamId", streamId)
                if (fin) wire.put("fin", true)
                wire.put("e2e", JSONObject().put("nonce", sealed.nonce).put("ct", sealed.ct))
                sendRaw(wire.toString())
            } catch (e: Exception) {
                Log.e(TAG, "seal 失败: ${e.message}")
            }
        }
    }

    private fun onFrameText(text: String) {
        val frame = try {
            JSONObject(text)
        } catch (e: Exception) {
            Log.w(TAG, "非 JSON 帧（丢弃）: ${text.take(60)}")
            return
        }
        if (isDuplicateUdp(frame)) return
        lastPongAt = System.currentTimeMillis() // 任何入帧都证明链路活着（含 pong/业务帧）
        when (frame.optString("type")) {
            "hello-ack", "pong" -> return
            "error" -> {
                Log.e(TAG, "中继错误帧: ${text.take(120)}")
                return
            }
            "detach" -> {
                Log.w(TAG, "对端离开: ${frame.optString("reason")}")
                ready.set(false)
                killStreams("对端已断开")
                onReset?.invoke("电脑端已断开")
                // 🔴 detach 后主动断开走重连（2026-10-26 对齐 ArkTS 修复）：
                // 否则 hello 只发一次，PC 回来后手机永不再附着（另一种永久假死）
                stopPing()
                runCatching { ws?.cancel() }
                return
            }
            "attached" -> {
                attachId = frame.optString("attachId")
                pcPub = frame.optJSONObject("peer")?.optString("publicKey") ?: ""
                Log.i(TAG, "已附着 attachId=$attachId pcPubLen=${pcPub.length}")
                startPunch()
                startUdpProbe()
                beginE2E()
                return
            }
            "punch-match" -> {
                punch?.onMatch(frame.optJSONObject("peer"))
                return
            }
            "punch-local" -> {
                punch?.onLocal(frame)
                return
            }
            "udp-candidate" -> {
                udpProbe?.onPeer(frame)
                return
            }
            "e2e" -> {
                onE2EFrame(frame)
                return
            }
        }
        // 业务帧（密文）
        val b = box
        val sealed = frame.optJSONObject("e2e")
        if (b != null && sealed != null) {
            val streamId = frame.optString("streamId", "-")
            val type = frame.optString("type")
            val fin = frame.optBoolean("fin", false)
            openExecutor.execute {
                try {
                    val plain = b.open(streamId, type, SealedPayload(sealed.getString("nonce"), sealed.getString("ct")))
                    val inner = JSONObject(plain)
                    val biz = inner.optJSONObject(SEALED_INNER_KEY) ?: JSONObject().put("type", type)
                    biz.put("type", type)
                    biz.put("streamId", streamId)
                    if (fin) biz.put("fin", true)
                    dispatchBiz(biz)
                } catch (e: Exception) {
                    Log.e(TAG, "解密失败 type=$type: ${e.message}")
                }
            }
            return
        }
        Log.w(TAG, "未知/未加密帧 type=${frame.optString("type")}（丢弃）")
    }

    private fun dispatchBiz(f: JSONObject) {
        val streamId = f.optString("streamId", "-")
        when (f.optString("type")) {
            "data" -> {
                val mux = muxes[streamId]
                if (mux != null && f.has("data")) {
                    mux.onText(B64u.fromUtf8(B64u.decode(f.getString("data"))))
                    return
                }
            }
            "close" -> {
                val mux = muxes.remove(streamId)
                if (mux != null) {
                    mux.onDown(f.optString("reason", "流已关闭"))
                    return
                }
            }
        }
        val st = streams[streamId]
        if (st != null) {
            st.push(f)
        } else if (f.optString("type") != "close") {
            // close 可能晚于本地流清理（无害竞态），其余才值得告警
            Log.w(TAG, "无主流的帧 streamId=$streamId type=${f.optString("type")}")
        }
    }

    // ---------------- E2E 握手 ----------------

    private fun beginE2E() {
        val e = EphemeralKey().also { it.generate() }
        eph = e
        synchronized(pendingE2E) { pendingE2E.clear() }
        // Kotlin 侧 generate 是同步的，竞态天然消除；保留"队列+回放"结构仅作防御。
        val offer = JSONObject()
            .put("type", "e2e")
            .put("step", "offer")
            .put("ephemeral", e.publicKeyB64)
            .put("attachId", attachId)
        sendRaw(offer.toString())
    }

    private fun onE2EFrame(frame: JSONObject) {
        val e = eph ?: return
        when (frame.optString("step")) {
            "offer" -> {
                peerEph = frame.optString("ephemeral")
                val sig = identity.sign(transcript(attachId, e.publicKeyB64, peerEph))
                val accept = JSONObject()
                    .put("type", "e2e")
                    .put("step", "accept")
                    .put("ephemeral", e.publicKeyB64)
                    .put("signature", sig)
                    .put("attachId", attachId)
                sendRaw(accept.toString())
            }
            "accept" -> {
                val pcEph = frame.optString("ephemeral")
                peerEph = pcEph
                // 🔴 PC 的 accept 签的是 transcript(attachId, pcEph, phoneEph)——
                //   参数顺序与 ArkTS 一致（selfEph 位传 pcEph）；旧实现传反导致验签必败（2026-10-27 定罪）
                val ok = verifyE2E(pcPub, frame.optString("signature"), attachId, peerEph, e.publicKeyB64)
                if (!ok) {
                    Log.e(TAG, "PC 侧 accept 验签失败: pcPubLen=${pcPub.length} pcEphLen=${pcEph.length} myEphLen=${e.publicKeyB64.length}")
                    return
                }
                val sig = identity.sign(transcript(attachId, e.publicKeyB64, peerEph))
                val confirm = JSONObject()
                    .put("type", "e2e")
                    .put("step", "confirm")
                    .put("signature", sig)
                    .put("attachId", attachId)
                sendRaw(confirm.toString())
                box = E2EBox.create(e, peerEph, attachId)
                ready.set(true)
                Log.i(TAG, "E2E 就绪（accept 验签通过，confirm 已发）")
                onReady?.invoke()
                readyHook.getAndSet(null)?.complete(Unit)
            }
            "confirm" -> {
                // PC 签的是 transcript(attachId, pcEph, phoneEph)
                val ok = verifyE2E(pcPub, frame.optString("signature"), attachId, peerEph, e.publicKeyB64)
                Log.i(TAG, "confirm 验签=$ok")
            }
        }
    }

    // ---------------- 业务 API ----------------

    private fun sendOpen(frame: JSONObject) {
        frame.put("attachId", attachId)
        sendSealed(frame)
    }

    /** 发 data 帧；超 24KB 自动分块 + 8ms 节流（在 send 线程内执行，保持顺序） */
    private fun sendDataInternal(streamId: String, payload: ByteArray, fin: Boolean) {
        if (payload.isEmpty()) {
            val f = JSONObject().put("type", "data").put("streamId", streamId).put("data", "")
            if (fin) f.put("fin", true)
            sendOpen(f)
            return
        }
        var off = 0
        while (off < payload.size) {
            val len = min(CHUNK_SIZE, payload.size - off)
            val chunk = payload.copyOfRange(off, off + len)
            off += len
            val f = JSONObject()
                .put("type", "data")
                .put("streamId", streamId)
                .put("data", B64u.encode(chunk))
            if (fin && off >= payload.size) f.put("fin", true)
            sendOpen(f)
            if (off < payload.size) {
                try { Thread.sleep(CHUNK_INTERVAL_MS) } catch (e: InterruptedException) { Thread.currentThread().interrupt() }
            }
        }
    }

    fun sendData(streamId: String, dataB64: String, fin: Boolean) {
        sendExecutor.execute { sendDataInternal(streamId, B64u.decode(dataB64), fin) }
    }

    fun closeStream(streamId: String) {
        muxes.remove(streamId)
        streams.remove(streamId)
        sendExecutor.execute {
            val f = JSONObject().put("type", "close").put("streamId", streamId)
            sendOpen(f)
        }
    }

    private fun newStreamId(prefix: String): String =
        "${prefix}${System.currentTimeMillis()}-${(0..999999).random()}"

    /** HTTP 一元调用：返回 {status, bodyText}；E2E 未就绪直接抛错 */
    suspend fun httpCall(method: String, path: String, bodyJson: String): HttpResult {
        if (!ready.get() || box == null) {
            throw RuntimeException("ERR_NETWORK: 中继未就绪（E2E 握手未完成）")
        }
        val sid = newStreamId("h")
        val st = RelayStream(sid)
        streams[sid] = st
        val open = JSONObject()
            .put("type", "open")
            .put("streamId", sid)
            .put("kind", "http")
            .put("method", method)
            .put("path", path)
            .put("headers", JSONObject().put("content-type", "application/json"))
        sendOpen(open)
        sendData(sid, B64u.encode(B64u.utf8(bodyJson)), true)
        val head = st.wait(pred = { it.optString("type") == "http-head" })
        while (!st.hasDataFin()) {
            st.wait({ it.optString("type") == "data" && it.optBoolean("fin", false) }, 30000)
        }
        closeStream(sid)
        return HttpResult(head.optInt("status", 0), B64u.fromUtf8(st.dataChunks()))
    }

    /**
     * 二进制安全 HTTP 调用（WebView 完整模式用）：
     * 静态资源（JS/图片/字体）必须字节级透传，Content-Type 从响应头带回。
     * fin 等待上限 120s：隧道侧大资源（MB 级分块）传输可能超过常规 30s。
     */
    suspend fun httpCallBin(method: String, path: String, bodyBytes: ByteArray?, contentType: String): HttpBinResult {
        if (!ready.get() || box == null) {
            throw RuntimeException("ERR_NETWORK: 中继未就绪（E2E 握手未完成）")
        }
        val sid = newStreamId("h")
        val st = RelayStream(sid)
        streams[sid] = st
        val headers = JSONObject()
        if (bodyBytes != null && contentType.isNotEmpty()) {
            headers.put("content-type", contentType)
        }
        val open = JSONObject()
            .put("type", "open")
            .put("streamId", sid)
            .put("kind", "http")
            .put("method", method)
            .put("path", path)
            .put("headers", headers)
        sendOpen(open)
        val payload = if (bodyBytes != null && bodyBytes.isNotEmpty()) bodyBytes else ByteArray(0)
        sendExecutor.execute {
            sendDataInternal(sid, payload, true)
        }
        val head = st.wait({ it.optString("type") == "http-head" }, 30000)
        while (!st.hasDataFin()) {
            st.wait({ it.optString("type") == "data" && it.optBoolean("fin", false) }, 120000)
        }
        closeStream(sid)
        @Suppress("UNCHECKED_CAST")
        val respHeaders = HashMap<String, String>()
        head.optJSONObject("headers")?.let { h ->
            h.keys().forEach { k -> respHeaders[k] = h.optString(k) }
        }
        return HttpBinResult(head.optInt("status", 0), respHeaders, st.dataChunks())
    }

    /**
     * 流式 HTTP 调用（2026-10-24，opencode SSE 用）：逐帧回调不缓冲。
     * onHead 收到响应头（一次），onChunk 收到每个数据块（字节级，可能多次），
     * 协程在 close 帧后返回。SSE 长连接的 close 可能很久才来（或永不来，直到断开），
     * 与 ArkTS 一致不设短超时（12h 等价语义：等 close/error 帧）。
     */
    suspend fun httpCallStream(
        method: String,
        path: String,
        bodyBytes: ByteArray?,
        contentType: String,
        onHead: (status: Int, headers: Map<String, String>) -> Unit,
        onChunk: (bytes: ByteArray) -> Unit
    ) {
        if (!ready.get() || box == null) {
            throw RuntimeException("ERR_NETWORK: 中继未就绪（E2E 握手未完成）")
        }
        val sid = newStreamId("h")
        val st = RelayStream(sid)
        var headSent = false
        st.sink = { f ->
            val t = f.optString("type")
            if (t == "http-head" && !headSent) {
                headSent = true
                val hs = HashMap<String, String>()
                f.optJSONObject("headers")?.let { h ->
                    h.keys().forEach { k -> hs[k] = h.optString(k) }
                }
                onHead(f.optInt("status", 0), hs)
            } else if (t == "data" && f.has("data")) {
                onChunk(B64u.decode(f.getString("data")))
            }
        }
        streams[sid] = st
        val headers = JSONObject()
        if (bodyBytes != null && contentType.isNotEmpty()) {
            headers.put("content-type", contentType)
        }
        val open = JSONObject()
            .put("type", "open")
            .put("streamId", sid)
            .put("kind", "http")
            .put("method", method)
            .put("path", path)
            .put("headers", headers)
        sendOpen(open)
        sendExecutor.execute { sendDataInternal(sid, bodyBytes ?: ByteArray(0), true) }
        // 🔴 先等响应头（30s 超时，2026-10-26 对齐 ArkTS 修复）：死链/上游无响应时尽快抛错，
        // 让 LocalProxy 的 502 自愈页生效，否则 WebView 请求永久挂起（假死主通道）
        val headOrEnd = st.wait(
            { it.optString("type") == "http-head" || it.optString("type") == "close" || it.optString("type") == "error" },
            30_000L
        )
        if (headOrEnd.optString("type") != "http-head") {
            closeStream(sid)
            throw RuntimeException("ERR_NETWORK: 上游未返回响应头即结束（${headOrEnd.optString("type")}）")
        }
        // close 帧（或 PC 侧 error 帧）才结束；SSE 期间长时间无帧属正常，不设短超时
        val end = st.wait({ it.optString("type") == "close" || it.optString("type") == "error" }, 12 * 3600 * 1000L)
        closeStream(sid)
        if (end.optString("type") == "error") {
            throw RuntimeException("上游流错误: ${end.optString("code")} ${end.optString("reason")}")
        }
    }

    /** 打开 mux 通道（默认 /api/remote.mux；第三方 target 的 WS 透传按原始 path）；返回 = 升级成功（101） */
    suspend fun openMux(onText: (String) -> Unit, onDown: (String) -> Unit, path: String = "/api/remote.mux"): MuxChannel {
        if (!ready.get() || box == null) {
            throw RuntimeException("ERR_NETWORK: 中继未就绪（E2E 握手未完成）")
        }
        val sid = newStreamId("w")
        val st = RelayStream(sid)
        streams[sid] = st
        val ch = MuxChannel(this, sid, onText, onDown)
        // 先注册 mux 再发 open：UDP 下 http-head 后的首个 data 可能先于协程恢复到达。
        muxes[sid] = ch
        val open = JSONObject()
            .put("type", "open")
            .put("streamId", sid)
            .put("kind", "ws")
            .put("path", path)
            .put("headers", JSONObject())
        sendOpen(open)
        val head = st.wait(pred = {
            val type = it.optString("type")
            type == "http-head" || type == "close" || type == "error"
        })
        if (head.optString("type") != "http-head" || head.optInt("status", 0) != 101) {
            closeStream(sid)
            throw RuntimeException("mux 升级失败 HTTP ${head.optInt("status", 0)}")
        }
        return ch
    }
}
