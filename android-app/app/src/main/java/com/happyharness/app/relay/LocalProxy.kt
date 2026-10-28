/**
 * LocalProxy —— WebView 完整模式的本地回环代理 —— 对齐 ArkTS chat/LocalProxy.ets。
 *
 * 职责：监听 127.0.0.1:9411（被占自动 +1 重试到 +4），把 WebView 的全部流量转进 v2 E2E 隧道：
 *   - HTTP（静态资源 + /api/ 前缀）→ relay.httpCallBin（二进制安全，响应头透传）
 *   - WebSocket（/api/remote.mux）→ relay.openMux 文本帧双向透传
 * Cookie 由 companion 侧注入（自签 owner Cookie），App 本地零凭证、零登录态。
 *
 * 🔴 踩坑纪律（交接 §4 / §1.2）：
 *   - 响应头剥离 hop 头时必须连带 content-encoding：companion 的 Node fetch 已自动解压，
 *     保留 content-encoding 会让 WebView ERR_CONTENT_DECODING_FAILED。
 *   - stop() 不只停监听，必须掐断全部存量 keep-alive 连接（僵尸代理元凶）；
 *     换 relay 重激活时上层必须先 stop 旧代理再建新的（relay 引用一致性检查）。
 */
package com.happyharness.app.relay

import android.util.Log
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "HHProxy"
private const val BASE_PORT = 9411
private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

/** 剥离的 hop 头 + 代理重写头（比 ArkTS 版多 content-encoding：Node fetch 已解压） */
private val HOP_HEADERS = setOf(
    "connection", "transfer-encoding", "keep-alive", "content-length", "upgrade",
    "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
    "sec-websocket-protocol", "host", "content-encoding"
)

fun reasonOf(status: Int): String = when (status) {
    200 -> "OK"; 101 -> "Switching Protocols"; 204 -> "No Content"
    301 -> "Moved Permanently"; 302 -> "Found"; 303 -> "See Other"; 304 -> "Not Modified"
    400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"; 404 -> "Not Found"
    500 -> "Internal Server Error"; 502 -> "Bad Gateway"
    else -> "Status"
}

class HttpReqInfo(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: ByteArray,
    val totalLen: Int,
    val wantUpgrade: Boolean,
    val wsKey: String
)

/** 解析一条完整 HTTP 请求；数据不足返回 null */
fun parseHttp(buf: ByteArray): HttpReqInfo? {
    if (buf.size > (1 shl 20)) return null
    val headText = B64u.fromUtf8(buf)
    val headerEnd = headText.indexOf("\r\n\r\n")
    if (headerEnd < 0) return null
    val lines = headText.substring(0, headerEnd).split("\r\n")
    val reqLine = lines[0].split(" ")
    if (reqLine.size < 2) return null
    val headers = HashMap<String, String>()
    for (i in 1 until lines.size) {
        val idx = lines[i].indexOf(':')
        if (idx > 0) {
            headers[lines[i].substring(0, idx).trim().lowercase()] = lines[i].substring(idx + 1).trim()
        }
    }
    val bodyStart = headerEnd + 4
    val contentLen = headers["content-length"]?.toIntOrNull() ?: 0
    val totalLen = bodyStart + contentLen
    if (buf.size < totalLen) return null
    return HttpReqInfo(
        method = reqLine[0],
        path = reqLine[1],
        headers = headers,
        body = buf.copyOfRange(bodyStart, totalLen),
        totalLen = totalLen,
        wantUpgrade = (headers["upgrade"] ?: "").lowercase() == "websocket",
        wsKey = headers["sec-websocket-key"] ?: ""
    )
}

fun buildHttpResponse(status: Int, respHeaders: Map<String, String>, body: ByteArray): ByteArray {
    val sb = StringBuilder()
    sb.append("HTTP/1.1 $status ${reasonOf(status)}\r\n")
    respHeaders.forEach { (k, v) ->
        if (k.lowercase() !in HOP_HEADERS) {
            sb.append("$k: $v\r\n")
        }
    }
    sb.append("Content-Length: ${body.size}\r\n")
    sb.append("Connection: keep-alive\r\n\r\n")
    return B64u.concat(listOf(B64u.utf8(sb.toString()), body))
}

/** SSE 流式响应头（无 Content-Length，chunked）（2026-10-24 对齐 ArkTS buildChunkedHead） */
fun buildChunkedHead(status: Int, respHeaders: Map<String, String>): ByteArray {
    val sb = StringBuilder()
    sb.append("HTTP/1.1 $status ${reasonOf(status)}\r\n")
    respHeaders.forEach { (k, v) ->
        if (k.lowercase() !in HOP_HEADERS) {
            sb.append("$k: $v\r\n")
        }
    }
    sb.append("Transfer-Encoding: chunked\r\n")
    sb.append("Connection: keep-alive\r\n\r\n")
    return B64u.utf8(sb.toString())
}

/** 一个 HTTP chunk 分块（hex 长度 + 数据 + CRLF） */
fun httpChunk(bytes: ByteArray): ByteArray {
    val prefix = B64u.utf8(bytes.size.toString(16) + "\r\n")
    return B64u.concat(listOf(prefix, bytes, B64u.utf8("\r\n")))
}

fun wsAcceptKey(key: String): String {
    val md = MessageDigest.getInstance("SHA-1")
    val digest = md.digest(B64u.utf8(key + WS_GUID))
    return Base64.getEncoder().encodeToString(digest)
}

/** 服务端→客户端 WS 帧（不带掩码） */
fun wsEncodeFrame(op: Int, payload: ByteArray): ByteArray {
    val len = payload.size
    val headerLen = when {
        len < 126 -> 2
        len < 65536 -> 4
        else -> 10
    }
    val out = ByteArray(headerLen + len)
    out[0] = (0x80 or op).toByte()
    var i = 2
    when {
        len < 126 -> out[1] = len.toByte()
        len < 65536 -> {
            out[1] = 126
            out[2] = ((len shr 8) and 0xFF).toByte()
            out[3] = (len and 0xFF).toByte()
        }
        else -> {
            out[1] = 127
            var v = len.toLong()
            for (j in 9 downTo 2) {
                out[j] = (v and 0xFF).toByte()
                v = v shr 8
            }
        }
    }
    System.arraycopy(payload, 0, out, headerLen, len)
    return out
}

class WsFrameInfo(val op: Int, val payload: ByteArray)

/** 客户端（WebView）→ 服务端 WS 帧流式解析器（处理掩码与 16/64 位长度） */
class WsParser {
    private var buf = ByteArray(0)

    fun feed(data: ByteArray): List<WsFrameInfo> {
        buf = B64u.concat(listOf(buf, data))
        val frames = ArrayList<WsFrameInfo>()
        loop@ while (true) {
            if (buf.size < 2) break
            val op = buf[0].toInt() and 0x0F
            val masked = (buf[1].toInt() and 0x80) != 0
            var len = buf[1].toInt() and 0x7F
            var p = 2
            when (len) {
                126 -> {
                    if (buf.size < 4) break@loop
                    len = ((buf[2].toInt() and 0xFF) shl 8) or (buf[3].toInt() and 0xFF)
                    p = 4
                }
                127 -> {
                    if (buf.size < 10) break@loop
                    len = 0
                    for (i in 2 until 10) len = len * 256 + (buf[i].toInt() and 0xFF)
                    p = 10
                }
            }
            var mask: ByteArray? = null
            if (masked) {
                if (buf.size < p + 4) break@loop
                mask = buf.copyOfRange(p, p + 4)
                p += 4
            }
            if (buf.size < p + len) break@loop
            var payload = buf.copyOfRange(p, p + len)
            mask?.let { m ->
                for (i in 0 until len) payload[i] = (payload[i].toInt() xor m[i and 3].toInt()).toByte()
            }
            frames.add(WsFrameInfo(op, payload))
            buf = buf.copyOfRange(p + len, buf.size)
        }
        return frames
    }
}

/** 单个 TCP 连接状态 */
private class ConnState {
    var buf = ByteArray(0)
    var wsMode = false
    val wsParser = WsParser()
    val pendingMuxTexts = ArrayList<String>() // UDP 低延迟下，快照可能先于本地 101 握手到达
    var mux: MuxChannel? = null
    @Volatile var closed = false
    val lock = Object() // keep-alive 顺序处理锁
}

class LocalProxy(val relay: RelayClient) {
    private var server: ServerSocket? = null
    private val clients = ConcurrentHashMap<Socket, Boolean>()
    private val pool: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "hh-proxy").apply { isDaemon = true }
    }
    private val stopped = AtomicBoolean(false)

    var ready: Boolean = false
        private set
    var url: String = ""
        private set

    /** 端口被占自动向后尝试（旧实例占着 9411 时新实例静默回退） */
    fun start(): String {
        var lastErr: Exception? = null
        for (idx in 0..4) {
            val port = BASE_PORT + idx
            try {
                val ss = ServerSocket(port, 50, InetAddress.getByName("127.0.0.1"))
                server = ss
                ready = true
                url = "http://127.0.0.1:$port/"
                stopped.set(false)
                Log.i(TAG, "本地代理已监听 $url")
                Thread({
                    acceptLoop(ss)
                }, "hh-proxy-accept").apply { isDaemon = true }.start()
                return url
            } catch (e: Exception) {
                lastErr = e
            }
        }
        throw RuntimeException("listen 失败: ${lastErr?.message}")
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (!ss.isClosed && !stopped.get()) {
            try {
                val sock = ss.accept()
                sock.tcpNoDelay = true
                clients[sock] = true
                pool.execute { handleConn(sock) }
            } catch (e: Exception) {
                if (!stopped.get()) break
            }
        }
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        ready = false
        // 🔴 只停监听不够：keep-alive 存量连接会继续由本（即将作废的）代理对象服务，
        //    绑着已 stop 的 relay → 全部请求"中继未就绪"。换 relay 重激活必须全掐断。
        clients.keys().toList().forEach { c ->
            try { c.close() } catch (e: Exception) {}
        }
        clients.clear()
        try { server?.close() } catch (e: Exception) {}
        server = null
    }

    private fun rawSend(sock: Socket, bytes: ByteArray) {
        synchronized(sock) {
            try {
                val out = sock.getOutputStream()
                out.write(bytes)
                out.flush()
            } catch (e: Exception) {
                // 连接已断，忽略
            }
        }
    }

    private fun handleConn(sock: Socket) {
        val st = ConnState()
        val input = try { sock.getInputStream() } catch (e: Exception) { return }
        try {
            val reader = ChunkedReader(input)
            while (!st.closed && !sock.isClosed) {
                val data = reader.readSome() ?: break
                st.buf = B64u.concat(listOf(st.buf, data))
                if (st.wsMode) {
                    handleWsBytes(sock, st)
                    continue
                }
                // HTTP 模式：顺序处理（防 keep-alive 流水线并发错乱）
                synchronized(st.lock) {
                    pumpHttp(sock, st)
                }
            }
        } catch (e: Exception) {
            // 读异常视作连接结束
        } finally {
            clients.remove(sock)
            st.closed = true
            st.mux?.close()
            try { sock.close() } catch (e: Exception) {}
        }
    }

    /** 逐条解析并转发 buf 里的完整 HTTP 请求 */
    private fun pumpHttp(sock: Socket, st: ConnState) {
        while (!st.closed && !st.wsMode) {
            val req = parseHttp(st.buf) ?: return
            st.buf = st.buf.copyOfRange(req.totalLen, st.buf.size)
            if (req.wantUpgrade) {
                upgradeWs(sock, st, req)
                return
            }
            forwardHttp(sock, st, req)
        }
    }

    private fun forwardHttp(sock: Socket, st: ConnState, req: HttpReqInfo) {
        try {
            val hasBody = req.body.isNotEmpty()
            // 🔴 流式透传（2026-10-24，opencode SSE）：/global/event 等 text/event-stream 是
            //    永不结束的长连接——攒完整响应会让 WebView 的事件流永久挂住（UI 无实时更新）。
            //    SSE 响应改 chunked 边收边发；普通响应保持缓冲（Content-Length 语义不变）。
            var streaming = false
            var bufferedStatus = 0
            var bufferedHeaders: Map<String, String> = HashMap()
            val chunks = ArrayList<ByteArray>()
            kotlinx.coroutines.runBlocking {
                relay.httpCallStream(
                    req.method,
                    req.path,
                    if (hasBody) req.body else null,
                    if (hasBody) (req.headers["content-type"] ?: "application/octet-stream") else "",
                    { status, headers ->
                        val ct = (headers["content-type"] ?: "").lowercase()
                        if (ct.contains("text/event-stream") && !st.closed) {
                            streaming = true
                            rawSend(sock, buildChunkedHead(status, headers))
                        } else {
                            bufferedStatus = status
                            bufferedHeaders = headers
                        }
                    },
                    { bytes ->
                        if (st.closed) return@httpCallStream
                        if (streaming) {
                            rawSend(sock, httpChunk(bytes))
                        } else {
                            synchronized(chunks) { chunks.add(bytes) }
                        }
                    }
                )
            }
            if (st.closed) return
            if (streaming) {
                rawSend(sock, B64u.utf8("0\r\n\r\n")) // chunked 结束
                Log.i(TAG, "HTTP(SSE-fin) ${req.method} ${req.path}")
                return
            }
            val body = synchronized(chunks) { B64u.concat(chunks) }
            rawSend(sock, buildHttpResponse(bufferedStatus, bufferedHeaders, body))
            Log.i(TAG, "HTTP ${req.method} ${req.path} → $bufferedStatus (${body.size}B)")
        } catch (e: Exception) {
            Log.w(TAG, "转发失败 ${req.method} ${req.path}: ${e.message}")
            if (!st.closed) {
                // 🔴 自愈错误页（2026-10-24 事故：断窗期 502 被 WebView 缓存，中继恢复后页面永远僵死）
                //    meta refresh 3s：中继恢复后页面自动重载，无需用户干预
                val html = "<meta http-equiv=\"refresh\" content=\"3\">" +
                    "<p style=\"font-family:system-ui;padding:24px;color:#444\">⚠️ 连接中断（" +
                    (e.message ?: "$e") + "）… 3 秒后自动重试</p>"
                rawSend(
                    sock,
                    buildHttpResponse(502, mapOf("Content-Type" to "text/html; charset=utf-8"), B64u.utf8(html))
                )
            }
        }
    }

    private fun upgradeWs(sock: Socket, st: ConnState, req: HttpReqInfo) {
        if (req.wsKey.isEmpty()) {
            rawSend(sock, buildHttpResponse(400, mapOf("Content-Type" to "text/plain"), B64u.utf8("missing ws key")))
            return
        }
        try {
            val accept = wsAcceptKey(req.wsKey)
            // 回显客户端请求的 subprotocol（浏览器规范：请求带协议头而服务端不回选 → 直接掐断）
            val proto = req.headers["sec-websocket-protocol"] ?: ""
            var resp = "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: $accept\r\n"
            if (proto.isNotEmpty()) {
                resp += "Sec-WebSocket-Protocol: ${proto.split(",")[0].trim()}\r\n"
            }
            resp += "\r\n"
            // 打开隧道侧 mux（按原始 path 透传：dsh GUI=/api/remote.mux，第三方 target 的 WS=/t/<name>/...），
            // 文本帧双向透传
            val mux = kotlinx.coroutines.runBlocking {
                relay.openMux(
                    { text ->
                        synchronized(st) {
                            if (!st.closed) {
                                if (st.wsMode) rawSend(sock, wsEncodeFrame(1, B64u.utf8(text)))
                                else st.pendingMuxTexts.add(text)
                            }
                        }
                    },
                    { reason ->
                        Log.i(TAG, "mux 下行断开: $reason")
                        if (!st.closed) {
                            rawSend(sock, wsEncodeFrame(8, B64u.utf8("relay closed")))
                            try { sock.close() } catch (e: Exception) {}
                        }
                    },
                    req.path
                )
            }
            synchronized(st) {
                st.mux = mux
                rawSend(sock, B64u.utf8(resp))
                st.wsMode = true
                st.pendingMuxTexts.forEach { text -> rawSend(sock, wsEncodeFrame(1, B64u.utf8(text))) }
                st.pendingMuxTexts.clear()
            }
            Log.i(TAG, "WS 升级完成 ${req.path} → mux")
            // 升级前 buf 里可能已带 WS 帧（浏览器紧跟发帧）
            handleWsBytes(sock, st)
        } catch (e: Exception) {
            Log.e(TAG, "WS 升级失败: ${e.message}")
            if (!st.closed) {
                rawSend(sock, buildHttpResponse(502, mapOf("Content-Type" to "text/plain"), B64u.utf8("ws upgrade failed")))
            }
        }
    }

    private fun handleWsBytes(sock: Socket, st: ConnState) {
        val frames = st.wsParser.feed(st.buf)
        st.buf = ByteArray(0)
        for (f in frames) {
            val mux = st.mux ?: continue
            when (f.op) {
                1, 2 -> mux.send(B64u.fromUtf8(f.payload))
                8 -> {
                    val code = if (f.payload.size >= 2) ((f.payload[0].toInt() and 255) shl 8) or (f.payload[1].toInt() and 255) else -1
                    val reason = if (f.payload.size > 2) B64u.fromUtf8(f.payload.copyOfRange(2, f.payload.size)) else ""
                    Log.i(TAG, "WS 对端关闭 code=$code reason=$reason")
                    mux.close()
                    st.mux = null
                    try { sock.close() } catch (e: Exception) {}
                }
                9 -> rawSend(sock, wsEncodeFrame(10, f.payload))
            }
        }
    }
}

/** 阻塞读取辅助：一次 read 尽量多拿（SO_RCVBUF 内），超时 30ms 返回空标记继续等 */
private class ChunkedReader(private val input: InputStream) {
    private val tmp = ByteArray(64 * 1024)

    fun readSome(): ByteArray? {
        return try {
            val n = input.read(tmp)
            if (n < 0) null else tmp.copyOfRange(0, n)
        } catch (e: SocketTimeoutException) {
            ByteArray(0)
        } catch (e: Exception) {
            null
        }
    }
}
