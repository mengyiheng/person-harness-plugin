/**
 * UDP 直连：随机 probeId 的 SYN/ACK 成功后，复用同一 socket 承载可靠 E2E 业务帧。
 * 通过 attach 控制帧交换 STUN 候选；打洞或可靠通道失败时保留中继并回放未确认帧。
 */
package com.happyharness.app.relay

import android.util.Log
import com.happyharness.app.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val UDP_TAG = "HHUdpProbe"
private const val STUN_COOKIE = 0x2112A442
private const val DISCOVERY_MS = 1600L
private const val PROBE_INTERVAL_MS = 250L
private const val PROBE_LIFETIME_MS = 7000L

class UdpProbeClient(
    private val attachId: String,
    private val sendRelay: (JSONObject) -> Unit,
    private val onFrame: (JSONObject) -> Unit = {},
    private val onDirect: (Boolean) -> Unit = {},
    private val onDown: (List<JSONObject>) -> Unit = {}
) {
    internal data class Candidate(val ip: String, val port: Int)

    private val dead = AtomicBoolean(false)
    private val probeId = ByteArray(12).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val candidates = ConcurrentHashMap<String, Candidate>()
    @Volatile private var peerCandidates: List<Candidate> = emptyList()
    @Volatile private var peerProbeId = ""
    @Volatile private var socket: DatagramSocket? = null
    @Volatile private var reliable: ReliableUdpChannel? = null
    @Volatile private var remote: Candidate? = null
    @Volatile private var synSeen = false
    @Volatile private var ackSeen = false
    @Volatile private var dropTrafficForTest = false
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "hh-udp-probe-timer").apply { isDaemon = true }
    }
    private val io = Executors.newCachedThreadPool { r ->
        Thread(r, "hh-udp-probe-io").apply { isDaemon = true }
    }

    /** 仅调试包：模拟 UDP 收发全部丢失，保留中继，让可靠层按真实超时路径回落。 */
    fun debugDropTraffic() {
        if (!BuildConfig.DEBUG) return
        if (dead.get() || reliable == null) {
            Log.w(UDP_TAG, "DEBUG UDP 故障注入忽略：当前没有业务直连")
            return
        }
        dropTrafficForTest = true
        Log.w(UDP_TAG, "DEBUG UDP 故障注入：丢弃双向 UDP 流量，中继保持")
    }

    fun start() {
        io.execute {
            try {
                val sock = DatagramSocket()
                sock.reuseAddress = true
                sock.soTimeout = 100
                socket = sock
                Log.i(UDP_TAG, "UDP 探针启动 local=${sock.localPort} probe=${probeId.take(8)}")
                io.execute { receiveLoop(sock) }
                val servers = listOf(
                    Triple("stun.l.google.com", 19302, "google"),
                    Triple("stun.miwifi.com", 3478, "miwifi"),
                    Triple("stun.freeswitch.org", 3478, "freeswitch")
                )
                for ((host, port, name) in servers) {
                    try {
                        val address = InetAddress.getByName(host)
                        if (!dead.get()) sendBytes(sock, stunRequest(), Candidate(address.hostAddress ?: host, port))
                    } catch (e: Exception) {
                        Log.w(UDP_TAG, "UDP STUN $name 发送失败: ${e.message}")
                    }
                }
                scheduler.schedule({ advertise() }, DISCOVERY_MS, TimeUnit.MILLISECONDS)
                scheduler.schedule({
                    if (!dead.get()) scheduler.scheduleAtFixedRate({ sendSyn() }, 0, PROBE_INTERVAL_MS, TimeUnit.MILLISECONDS)
                }, DISCOVERY_MS + 100, TimeUnit.MILLISECONDS)
                scheduler.schedule({ stop() }, PROBE_LIFETIME_MS, TimeUnit.MILLISECONDS)
            } catch (e: Exception) {
                Log.w(UDP_TAG, "UDP 探针启动失败: ${e.message}")
                stop()
            }
        }
    }

    private fun advertise() {
        if (dead.get()) return
        val list = candidates.values.toList()
        if (list.isEmpty()) {
            Log.w(UDP_TAG, "UDP 探针未获得 STUN 公网候选")
            return
        }
        Log.i(UDP_TAG, "UDP 候选 ${list.joinToString { "${it.ip}:${it.port}" }}")
        val array = JSONArray()
        list.forEach { array.put(JSONObject().put("ip", it.ip).put("port", it.port)) }
        sendRelay(JSONObject()
            .put("type", "udp-candidate")
            .put("attachId", attachId)
            .put("probeId", probeId)
            .put("candidates", array))
    }

    fun onPeer(frame: JSONObject) {
        if (dead.get() || frame.optString("attachId") != attachId) return
        val id = frame.optString("probeId")
        val array = frame.optJSONArray("candidates") ?: return
        if (id.isEmpty()) return
        val list = ArrayList<Candidate>()
        for (index in 0 until array.length()) {
            val item = array.optJSONObject(index) ?: continue
            val ip = item.optString("ip")
            val port = item.optInt("port")
            if (ip.isNotEmpty() && port in 1..65535) list.add(Candidate(ip, port))
        }
        peerProbeId = id
        peerCandidates = list
        Log.i(UDP_TAG, "UDP 对端候选 ${list.joinToString { "${it.ip}:${it.port}" }.ifEmpty { "空" }}")
    }

    private fun receiveLoop(sock: DatagramSocket) {
        while (!dead.get() && socket === sock && !sock.isClosed) {
            val packet = DatagramPacket(ByteArray(2048), 2048)
            try {
                sock.receive(packet)
            } catch (_: SocketTimeoutException) {
                continue
            } catch (_: Exception) {
                break
            }
            if (dropTrafficForTest) continue
            val bytes = packet.data.copyOfRange(packet.offset, packet.offset + packet.length)
            val source = Candidate(packet.address.hostAddress ?: continue, packet.port)
            val channel = reliable
            if (channel != null && remote == source && channel.handlePacket(bytes)) continue
            val mapped = parseStunAddress(bytes)
            if (mapped != null) {
                candidates["${mapped.ip}:${mapped.port}"] = mapped
                continue
            }
            try {
                onPacket(JSONObject(String(bytes, Charsets.UTF_8)), source)
            } catch (_: Exception) {
            }
        }
    }

    private fun onPacket(frame: JSONObject, source: Candidate) {
        if (frame.optString("type") != "udp-probe" || frame.optString("attachId") != attachId) return
        val id = frame.optString("probeId")
        when (frame.optString("step")) {
            "syn" -> {
                if (peerProbeId.isEmpty() || id != peerProbeId) return
                if (!synSeen) {
                    synSeen = true
                    Log.i(UDP_TAG, "UDP 探针收到对端 SYN（入站可达）source=${source.ip}:${source.port}")
                }
                val sock = socket ?: return
                sendBytes(sock, JSONObject()
                    .put("type", "udp-probe")
                    .put("attachId", attachId)
                    .put("probeId", id)
                    .put("step", "ack"), source)
            }
            "ack" -> {
                if (id != probeId) return
                if (!ackSeen) {
                    ackSeen = true
                    Log.i(UDP_TAG, "UDP 探针双向成功 ✅ source=${source.ip}:${source.port}")
                }
                establish(source)
            }
        }
    }

    @Synchronized
    private fun establish(source: Candidate) {
        if (dead.get() || reliable != null) return
        remote = source
        scheduler.shutdownNow() // 取消 7 秒探针停止任务和后续 SYN；业务保活由可靠层负责。
        val channel = ReliableUdpChannel(
            channelId = "phone-${probeId.take(16)}",
            sendPacket = { packet ->
                val sock = socket
                val target = remote
                if (!dead.get() && sock != null && target != null) sendBytes(sock, packet, target)
            },
            onFrame = onFrame,
            onFail = { pending ->
                if (reliable == null) return@ReliableUdpChannel
                reliable = null
                onDirect(false)
                sendRelay(JSONObject().put("type", "punch-revert").put("attachId", attachId))
                onDown(pending)
                stop()
            },
            log = { message -> Log.w(UDP_TAG, message) }
        )
        reliable = channel
        Log.i(UDP_TAG, "UDP 业务直连建立 ✅ remote=${source.ip}:${source.port}")
        sendRelay(JSONObject().put("type", "punch-ok").put("attachId", attachId))
        onDirect(true)
    }

    fun isDirect(): Boolean = reliable?.isActive() == true

    fun send(frame: JSONObject): Boolean = reliable?.send(frame) == true

    private fun sendSyn() {
        if (dead.get() || reliable != null || peerProbeId.isEmpty()) return
        val sock = socket ?: return
        val packet = JSONObject()
            .put("type", "udp-probe")
            .put("attachId", attachId)
            .put("probeId", probeId)
            .put("step", "syn")
        peerCandidates.forEach { sendBytes(sock, packet, it) }
    }

    private fun sendBytes(sock: DatagramSocket, frame: JSONObject, target: Candidate) {
        sendBytes(sock, frame.toString().toByteArray(Charsets.UTF_8), target)
    }

    private fun sendBytes(sock: DatagramSocket, bytes: ByteArray, target: Candidate) {
        if (dead.get() || dropTrafficForTest) return
        try {
            val address = InetAddress.getByName(target.ip)
            sock.send(DatagramPacket(bytes, bytes.size, address, target.port))
        } catch (_: Exception) {
        }
    }

    fun stop() {
        if (!dead.compareAndSet(false, true)) return
        reliable?.stop()
        reliable = null
        runCatching { socket?.close() }
        scheduler.shutdownNow()
        io.shutdownNow()
        if (!ackSeen) Log.w(UDP_TAG, "UDP 探针结束：双向未成功（synSeen=$synSeen）")
    }
}

private fun stunRequest(): ByteArray {
    val random = ByteArray(12).also { SecureRandom().nextBytes(it) }
    return ByteBuffer.allocate(20).order(ByteOrder.BIG_ENDIAN)
        .putShort(0x0001)
        .putShort(0)
        .putInt(STUN_COOKIE)
        .put(random)
        .array()
}

private fun parseStunAddress(packet: ByteArray): UdpProbeClient.Candidate? {
    if (packet.size < 20) return null
    val buffer = ByteBuffer.wrap(packet).order(ByteOrder.BIG_ENDIAN)
    if ((buffer.getShort(0).toInt() and 0xffff) != 0x0101 || buffer.getInt(4) != STUN_COOKIE) return null
    val declared = buffer.getShort(2).toInt() and 0xffff
    val end = minOf(packet.size, 20 + declared)
    var offset = 20
    while (offset + 4 <= end) {
        val type = buffer.getShort(offset).toInt() and 0xffff
        val length = buffer.getShort(offset + 2).toInt() and 0xffff
        val value = offset + 4
        if (value + length > end) break
        if (length >= 8 && (type == 0x0020 || type == 0x0001) && packet[value + 1].toInt() == 0x01) {
            val port = (buffer.getShort(value + 2).toInt() and 0xffff) xor (if (type == 0x0020) 0x2112 else 0)
            val raw = buffer.getInt(value + 4) xor (if (type == 0x0020) STUN_COOKIE else 0)
            val ip = listOf(24, 16, 8, 0).joinToString(".") { ((raw ushr it) and 255).toString() }
            return UdpProbeClient.Candidate(ip, port)
        }
        offset = value + length + ((4 - (length % 4)) % 4)
    }
    return null
}
