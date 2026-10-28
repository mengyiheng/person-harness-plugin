/** DEBUG 专用 RFC 5780 只读 NAT 过滤诊断；不改聊天路由，不申请端口映射。 */
package com.happyharness.app.relay

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

private const val NAT_TAG = "HHNatFilter"
private const val NAT_COOKIE = 0x2112A442

object NatFilterProbe {
    private data class Endpoint(val ip: String, val port: Int)
    private data class Pending(val server: String, val mode: String, val ip: String, val port: Int)
    private data class ProbeResult(
        var primary: Boolean = false,
        var supported: Boolean = false,
        var changePort: Boolean = false,
        var changeIpPort: Boolean = false
    )

    @Volatile private var running = false

    fun start() {
        if (running) {
            Log.w(NAT_TAG, "NAT_FILTER 已在运行，忽略重复触发")
            return
        }
        running = true
        Thread({
            try {
                execute()
            } catch (e: Exception) {
                Log.w(NAT_TAG, "NAT_FILTER 执行失败: ${e.message}")
            } finally {
                running = false
            }
        }, "hh-nat-filter").apply { isDaemon = true }.start()
    }

    private fun execute() {
        val socket = DatagramSocket()
        socket.reuseAddress = true
        socket.soTimeout = 100
        val pending = ConcurrentHashMap<String, Pending>()
        try {
            Log.i(NAT_TAG, "NAT_FILTER 开始 local=${socket.localPort}（RFC 5780，只读）")
            probeServer(socket, pending, "internetcalls", "stun.internetcalls.com", 3478)
            probeServer(socket, pending, "voipstunt", "stun.voipstunt.com", 3478)
            Log.i(NAT_TAG, "NAT_FILTER 完成")
        } finally {
            socket.close()
        }
    }

    private fun probeServer(
        socket: DatagramSocket,
        pending: ConcurrentHashMap<String, Pending>,
        name: String,
        host: String,
        port: Int
    ) {
        val result = ProbeResult()
        try {
            val address = InetAddress.getAllByName(host).firstOrNull { it is Inet4Address }
            if (address == null) {
                Log.w(NAT_TAG, "NAT_FILTER $name 无 IPv4 地址")
                return
            }
            val primary = Endpoint(address.hostAddress ?: host, port)
            val request = stunRequest(0)
            pending[transactionId(request)] = Pending(name, "primary", primary.ip, primary.port)
            send(socket, request, primary)
            receiveFor(socket, pending, result, 300)
            send(socket, request, primary)
            receiveFor(socket, pending, result, 1100)
            val other = resultOtherAddress(result)
            if (!result.supported || other == null) {
                Log.w(NAT_TAG, "NAT_FILTER $name 无 RFC 5780 OTHER-ADDRESS，无法分类")
                logResult(name, result)
                return
            }
            Log.i(NAT_TAG, "NAT_FILTER $name 主响应成功 other=${other.ip}:${other.port}")
            val changePort = stunRequest(0x02)
            val changeIpPort = stunRequest(0x06)
            pending[transactionId(changePort)] = Pending(name, "changePort", primary.ip, other.port)
            pending[transactionId(changeIpPort)] = Pending(name, "changeIpPort", other.ip, other.port)
            send(socket, changePort, primary)
            send(socket, changeIpPort, primary)
            receiveFor(socket, pending, result, 300)
            send(socket, changePort, primary)
            send(socket, changeIpPort, primary)
            receiveFor(socket, pending, result, 1200)
            logResult(name, result)
        } catch (e: Exception) {
            Log.w(NAT_TAG, "NAT_FILTER $name 失败: ${e.message}")
        }
    }

    private val otherAddresses = ConcurrentHashMap<String, Endpoint>()

    private fun resultOtherAddress(result: ProbeResult): Endpoint? = otherAddresses.remove(result.hashCode().toString())

    private fun receiveFor(
        socket: DatagramSocket,
        pending: ConcurrentHashMap<String, Pending>,
        result: ProbeResult,
        durationMs: Long
    ) {
        val deadline = System.currentTimeMillis() + durationMs
        while (System.currentTimeMillis() < deadline) {
            val packet = DatagramPacket(ByteArray(2048), 2048)
            try {
                socket.receive(packet)
            } catch (_: SocketTimeoutException) {
                continue
            }
            val bytes = packet.data.copyOfRange(packet.offset, packet.offset + packet.length)
            val sourceIp = packet.address.hostAddress ?: continue
            val item = pending[transactionId(bytes)] ?: continue
            if (item.ip != sourceIp || item.port != packet.port) continue
            when (item.mode) {
                "primary" -> {
                    result.primary = true
                    val other = addressAttribute(bytes, 0x8023) ?: addressAttribute(bytes, 0x0005)
                    if (other != null) {
                        result.supported = true
                        otherAddresses[result.hashCode().toString()] = other
                    }
                }
                "changePort" -> {
                    if (!result.changePort) Log.i(NAT_TAG, "NAT_FILTER ${item.server} 同 IP 换端口回包通过")
                    result.changePort = true
                }
                "changeIpPort" -> {
                    if (!result.changeIpPort) Log.i(NAT_TAG, "NAT_FILTER ${item.server} 换 IP+端口回包通过")
                    result.changeIpPort = true
                }
            }
        }
    }

    private fun logResult(name: String, result: ProbeResult) {
        val filtering = when {
            result.changeIpPort -> "endpoint-independent"
            result.changePort -> "address-dependent"
            result.supported -> "address-and-port-dependent-or-blocked"
            else -> "unknown-no-rfc5780-server"
        }
        Log.i(NAT_TAG, "NAT_FILTER_RESULT server=$name primary=${result.primary.flag()} " +
            "rfc5780=${result.supported.flag()} changePort=${result.changePort.flag()} " +
            "changeIpPort=${result.changeIpPort.flag()} filtering=$filtering")
    }

    private fun Boolean.flag(): Int = if (this) 1 else 0

    private fun stunRequest(changeFlags: Int): ByteArray {
        val bytes = ByteArray(if (changeFlags > 0) 28 else 20)
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        buffer.putShort(0, 1)
        buffer.putInt(4, NAT_COOKIE)
        val random = ByteArray(12)
        SecureRandom().nextBytes(random)
        System.arraycopy(random, 0, bytes, 8, 12)
        if (changeFlags > 0) {
            buffer.putShort(2, 8)
            buffer.putShort(20, 3)
            buffer.putShort(22, 4)
            buffer.putInt(24, changeFlags)
        }
        return bytes
    }

    private fun transactionId(packet: ByteArray): String {
        if (packet.size < 20) return ""
        return packet.copyOfRange(8, 20).joinToString("") { "%02x".format(it) }
    }

    private fun addressAttribute(packet: ByteArray, wanted: Int): Endpoint? {
        if (packet.size < 20 || u16(packet, 0) != 0x0101 || u32(packet, 4) != NAT_COOKIE.toLong()) return null
        val end = minOf(packet.size, 20 + u16(packet, 2))
        var offset = 20
        while (offset + 4 <= end) {
            val type = u16(packet, offset)
            val length = u16(packet, offset + 2)
            val value = offset + 4
            if (value + length > end) break
            if (type == wanted && length >= 8 && packet[value + 1].toInt() == 1) {
                val ip = (value + 4 until value + 8).joinToString(".") { (packet[it].toInt() and 255).toString() }
                return Endpoint(ip, u16(packet, value + 2))
            }
            offset = value + length + ((4 - length % 4) % 4)
        }
        return null
    }

    private fun u16(packet: ByteArray, offset: Int): Int =
        ((packet[offset].toInt() and 255) shl 8) or (packet[offset + 1].toInt() and 255)

    private fun u32(packet: ByteArray, offset: Int): Long =
        ((packet[offset].toLong() and 255) shl 24) or ((packet[offset + 1].toLong() and 255) shl 16) or
            ((packet[offset + 2].toLong() and 255) shl 8) or (packet[offset + 3].toLong() and 255)

    private fun send(socket: DatagramSocket, bytes: ByteArray, endpoint: Endpoint) {
        socket.send(DatagramPacket(bytes, bytes.size, InetAddress.getByName(endpoint.ip), endpoint.port))
    }
}
