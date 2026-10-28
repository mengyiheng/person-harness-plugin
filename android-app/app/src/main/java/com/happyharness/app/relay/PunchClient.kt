/**
 * TCP 同时打开打洞（与 PC lib/punch.mjs 对齐）。
 * 云端只登记公网映射并经中继发 punch-match；业务帧仍逐帧 E2E 加密。
 * 直连失败或空闲死亡只切回中继，不改变配对、会话和审批协议。
 */
package com.happyharness.app.relay

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val PUNCH_TAG = "HHPunch"
private const val OPEN_RETRIES = 6
private const val OPEN_RETRY_MS = 400
private const val PUNCH_BUDGET_MS = 3000L
private const val DIRECT_IDLE_MS = 12000L
private const val HEARTBEAT_MS = 5000L

class PunchClient(
    private val host: String,
    private val regPort: Int,
    private val attachId: String,
    private val token: String,
    private val sendRelay: (JSONObject) -> Unit,
    private val onFrame: (JSONObject) -> Unit,
    private val onState: (Boolean) -> Unit
) {
    private val dead = AtomicBoolean(false)
    @Volatile private var established = false
    @Volatile private var localPort = 0
    @Volatile private var lastDataAt = System.currentTimeMillis()
    private var regSock: Socket? = null
    private var directSock: Socket? = null
    private var listener: ServerSocket? = null
    private var peer: InetSocketAddress? = null
    private var heartbeat: ScheduledFuture<*>? = null
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "hh-punch-timer").apply { isDaemon = true }
    }
    private val io = Executors.newCachedThreadPool { r ->
        Thread(r, "hh-punch-io").apply { isDaemon = true }
    }

    fun isEstablished(): Boolean = established

    fun start() {
        io.execute {
            try {
                val sock = Socket()
                // 登记 socket 也必须先开复用；否则关闭后遗留的 TCP 状态会让打洞 socket 无法绑定同源端口。
                sock.reuseAddress = true
                sock.tcpNoDelay = true
                sock.connect(InetSocketAddress(host, regPort), OPEN_RETRY_MS)
                if (dead.get()) { sock.close(); return@execute }
                regSock = sock
                localPort = sock.localPort
                writeLine(sock, JSONObject()
                    .put("type", "punch-reg")
                    .put("attachId", attachId)
                    .put("role", "phone")
                    .put("token", token))
                Log.i(PUNCH_TAG, "punch 登记本地端口=$localPort")
                readRegistration(sock)
            } catch (e: Exception) {
                Log.w(PUNCH_TAG, "punch 登记失败: ${e.message}")
                giveUp()
            }
        }
        scheduler.schedule({ if (!established) giveUp() }, PUNCH_BUDGET_MS, TimeUnit.MILLISECONDS)
    }

    private fun readRegistration(sock: Socket) {
        try {
            val reader = BufferedReader(InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8))
            while (!dead.get() && !sock.isClosed) {
                val line = reader.readLine() ?: break
                if (line.isBlank()) continue
                val frame = JSONObject(line)
                if (frame.optBoolean("ok", false)) Log.i(PUNCH_TAG, "punch 登记成功")
                if (frame.has("ok") && !frame.optBoolean("ok")) {
                    Log.w(PUNCH_TAG, "punch 登记被拒")
                    giveUp()
                    break
                }
            }
        } catch (_: Exception) {
            // 同时打开前主动关闭登记 socket，读线程退出是正常流程。
        }
    }

    fun onMatch(peerFrame: JSONObject?) {
        val ip = peerFrame?.optString("ip") ?: ""
        val port = peerFrame?.optInt("port", 0) ?: 0
        if (dead.get() || established || ip.isEmpty() || localPort <= 0 || port <= 0) return
        peer = InetSocketAddress(ip, port)
        Log.i(PUNCH_TAG, "punch match $ip:$port local=$localPort")
        runCatching { regSock?.close() }
        // 公网打洞必须使用登记时的源端口，否则 NAT 不会命中已登记的映射。
        scheduler.schedule({ openPeer(0, InetSocketAddress(ip, port), true) }, 150, TimeUnit.MILLISECONDS)
    }

    fun onLocal(frame: JSONObject) {
        // punch-local 与云端 punch-match 走不同来源，允许 LAN 候选先到，不能把它丢弃。
        if (dead.get() || established) return
        val port = frame.optInt("port", 0)
        val addresses = frame.optJSONArray("addresses") ?: return
        if (port <= 0) return
        for (index in 0 until addresses.length()) {
            val ip = addresses.optString(index)
            if (ip.isNotEmpty()) {
                Log.i(PUNCH_TAG, "punch 尝试 LAN $ip:$port")
                openPeer(0, InetSocketAddress(ip, port), false)
            }
        }
    }

    private fun openPeer(attempt: Int, target: InetSocketAddress, preserveLocalPort: Boolean) {
        if (dead.get() || established) return
        io.execute {
            var sock: Socket? = null
            try {
                sock = Socket()
                sock.reuseAddress = true
                if (preserveLocalPort) sock.bind(InetSocketAddress(localPort))
                sock.tcpNoDelay = true
                sock.connect(target, OPEN_RETRY_MS)
                if (dead.get() || established) { sock.close(); return@execute }
                Log.i(PUNCH_TAG, "punch 第${attempt + 1}次连接成功 peer=$target local=${sock.localPort}")
                wire(sock)
            } catch (e: Exception) {
                runCatching { sock?.close() }
                Log.w(PUNCH_TAG, "punch 第${attempt + 1}次连接失败 peer=$target: ${e.javaClass.simpleName}: ${e.message}")
                if (!dead.get() && !established && attempt + 1 < OPEN_RETRIES) {
                    scheduler.schedule({ openPeer(attempt + 1, target, preserveLocalPort) }, 60, TimeUnit.MILLISECONDS)
                }
            }
        }
    }

    private fun wire(sock: Socket) {
        synchronized(this) {
            if (dead.get() || established) { runCatching { sock.close() }; return
            }
            runCatching { directSock?.close() }
            directSock = sock
        }
        lastDataAt = System.currentTimeMillis()
        writeLine(sock, JSONObject().put("type", "punch-syn").put("attachId", attachId))
        io.execute { readDirect(sock) }
    }

    private fun readDirect(sock: Socket) {
        try {
            val reader = BufferedReader(InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8))
            while (!dead.get() && directSock === sock && !sock.isClosed) {
                val line = reader.readLine() ?: break
                lastDataAt = System.currentTimeMillis()
                if (line.isBlank()) continue
                val frame = JSONObject(line)
                when (frame.optString("type")) {
                    "punch-syn" -> markEstablished(sock)
                    "punch-ping" -> Unit
                    else -> onFrame(frame)
                }
            }
        } catch (_: Exception) {
        } finally {
            if (directSock === sock) directDown()
        }
    }

    private fun markEstablished(sock: Socket) {
        synchronized(this) {
            if (dead.get() || established || directSock !== sock) return
            established = true
        }
        runCatching { listener?.close() }
        Log.i(PUNCH_TAG, "punch 直连建立 ✅")
        sendRelay(JSONObject().put("type", "punch-ok").put("attachId", attachId))
        onState(true)
        heartbeat = scheduler.scheduleAtFixedRate({
            if (!established || dead.get()) return@scheduleAtFixedRate
            if (System.currentTimeMillis() - lastDataAt > DIRECT_IDLE_MS) {
                Log.w(PUNCH_TAG, "punch 直连空闲超时，回落中继")
                directDown()
            } else {
                send(JSONObject().put("type", "punch-ping"))
            }
        }, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS)
    }

    fun send(frame: JSONObject) {
        val sock = directSock ?: return
        if (!established || sock.isClosed) return
        try { writeLine(sock, frame) } catch (e: Exception) {
            Log.w(PUNCH_TAG, "punch 发送失败: ${e.message}")
            directDown()
        }
    }

    private fun writeLine(sock: Socket, frame: JSONObject) {
        val bytes = (frame.toString() + "\n").toByteArray(StandardCharsets.UTF_8)
        synchronized(sock) {
            val out = sock.getOutputStream()
            out.write(bytes)
            out.flush()
        }
    }

    private fun directDown() {
        synchronized(this) {
            if (!established) return
            established = false
        }
        heartbeat?.cancel(false)
        heartbeat = null
        runCatching { directSock?.close() }
        directSock = null
        sendRelay(JSONObject().put("type", "punch-revert").put("attachId", attachId))
        onState(false)
    }

    private fun giveUp() {
        if (!dead.compareAndSet(false, true)) return
        runCatching { regSock?.close() }
        runCatching { directSock?.close() }
        runCatching { listener?.close() }
        heartbeat?.cancel(false)
        Log.w(PUNCH_TAG, "punch 放弃，继续使用中继")
    }

    fun stop() {
        dead.set(true)
        established = false
        heartbeat?.cancel(false)
        heartbeat = null
        runCatching { regSock?.close() }
        runCatching { directSock?.close() }
        runCatching { listener?.close() }
        scheduler.shutdownNow()
        io.shutdownNow()
        onState(false)
    }
}
