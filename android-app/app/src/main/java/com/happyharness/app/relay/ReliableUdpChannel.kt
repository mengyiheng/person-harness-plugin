/** 轻量可靠 UDP：分片、ACK、重传、保序；业务帧加密仍由原 E2E 负责。 */
package com.happyharness.app.relay

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val RUDP_HEADER = 14
private const val RUDP_PAYLOAD = 1000
private const val RUDP_DATA = 1
private const val RUDP_ACK = 2
private const val RUDP_PING = 3
private const val RUDP_PONG = 4
private const val RUDP_IN_FLIGHT = 4
private const val RUDP_RETRANSMIT_MS = 400L
private const val RUDP_MAX_RETRIES = 30
private const val RUDP_KEEPALIVE_MS = 2000L
private const val RUDP_IDLE_MS = 12000L
private val RUDP_MAGIC = byteArrayOf(72, 72, 82, 49) // HHR1

class ReliableUdpChannel(
    private val channelId: String,
    private val sendPacket: (ByteArray) -> Unit,
    private val onFrame: (JSONObject) -> Unit,
    private val onFail: (List<JSONObject>) -> Unit,
    private val log: (String) -> Unit
) {
    private data class OutMessage(
        val id: Int,
        val frame: JSONObject,
        val chunks: List<ByteArray>,
        val acked: BooleanArray,
        val lastSent: LongArray,
        val retries: IntArray
    )
    private data class InMessage(val chunks: Array<ByteArray?>, var received: Int = 0)

    @Volatile private var active = true
    private var nextMessageId = 1
    private var nextReceiveId = 1
    private val pending = LinkedHashMap<Int, OutMessage>()
    private val queue = ArrayList<JSONObject>()
    private val incoming = HashMap<Int, InMessage>()
    private val completed = HashMap<Int, JSONObject>()
    @Volatile private var lastReceived = System.currentTimeMillis()
    private val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "hh-rudp-timer").apply { isDaemon = true }
    }

    init {
        scheduler.scheduleAtFixedRate({ retransmit() }, 200, 200, TimeUnit.MILLISECONDS)
        scheduler.scheduleAtFixedRate({ keepalive() }, RUDP_KEEPALIVE_MS, RUDP_KEEPALIVE_MS, TimeUnit.MILLISECONDS)
    }

    fun isActive(): Boolean = active

    @Synchronized
    fun send(frame: JSONObject): Boolean {
        if (!active) return false
        queue.add(frame)
        pump()
        return true
    }

    private fun pump() {
        while (active && pending.size < RUDP_IN_FLIGHT && queue.isNotEmpty()) {
            val original = queue.removeAt(0)
            val id = nextMessageId++
            val frame = JSONObject(original.toString())
            if (!frame.has("udpId")) frame.put("udpId", "$channelId:$id")
            val bytes = frame.toString().toByteArray(Charsets.UTF_8)
            val count = (bytes.size + RUDP_PAYLOAD - 1) / RUDP_PAYLOAD
            if (count <= 0 || count > 65535) {
                log("UDP 业务帧大小不支持: ${bytes.size}")
                continue
            }
            val chunks = (0 until count).map { index ->
                bytes.copyOfRange(index * RUDP_PAYLOAD, minOf(bytes.size, (index + 1) * RUDP_PAYLOAD))
            }
            val message = OutMessage(id, frame, chunks, BooleanArray(count), LongArray(count), IntArray(count))
            pending[id] = message
            for (index in 0 until count) sendFragment(message, index)
        }
    }

    private fun sendFragment(message: OutMessage, index: Int) {
        if (!active || message.acked[index]) return
        val chunk = message.chunks[index]
        val packet = ByteBuffer.allocate(RUDP_HEADER + chunk.size).order(ByteOrder.BIG_ENDIAN)
        packet.put(RUDP_MAGIC)
        packet.put(RUDP_DATA.toByte())
        packet.put(0)
        packet.putInt(message.id)
        packet.putShort(index.toShort())
        packet.putShort(message.chunks.size.toShort())
        packet.put(chunk)
        message.lastSent[index] = System.currentTimeMillis()
        sendPacket(packet.array())
    }

    private fun control(type: Int, messageId: Int = 0, fragmentIndex: Int = 0) {
        if (!active) return
        val packet = ByteBuffer.allocate(RUDP_HEADER).order(ByteOrder.BIG_ENDIAN)
        packet.put(RUDP_MAGIC)
        packet.put(type.toByte())
        packet.put(0)
        packet.putInt(messageId)
        packet.putShort(fragmentIndex.toShort())
        packet.putShort(0)
        sendPacket(packet.array())
    }

    @Synchronized
    fun handlePacket(packet: ByteArray): Boolean {
        if (!active || packet.size < RUDP_HEADER || !packet.copyOfRange(0, 4).contentEquals(RUDP_MAGIC)) return false
        lastReceived = System.currentTimeMillis()
        val buffer = ByteBuffer.wrap(packet).order(ByteOrder.BIG_ENDIAN)
        val type = buffer.get(4).toInt() and 255
        val messageId = buffer.getInt(6)
        val fragmentIndex = buffer.getShort(10).toInt() and 0xffff
        val fragmentCount = buffer.getShort(12).toInt() and 0xffff
        when (type) {
            RUDP_PING -> { control(RUDP_PONG); return true }
            RUDP_PONG -> return true
            RUDP_ACK -> {
                val message = pending[messageId] ?: return true
                if (fragmentIndex >= message.chunks.size) return true
                message.acked[fragmentIndex] = true
                if (message.acked.all { it }) {
                    pending.remove(messageId)
                    pump()
                }
                return true
            }
        }
        if (type != RUDP_DATA || fragmentCount <= 0 || fragmentIndex >= fragmentCount || fragmentCount > 4096) return true
        if (messageId < nextReceiveId || completed.containsKey(messageId)) {
            control(RUDP_ACK, messageId, fragmentIndex)
            return true
        }
        val message = incoming.getOrPut(messageId) { InMessage(arrayOfNulls(fragmentCount)) }
        if (message.chunks.size != fragmentCount) {
            incoming.remove(messageId)
            return true
        }
        if (message.chunks[fragmentIndex] == null) {
            message.chunks[fragmentIndex] = packet.copyOfRange(RUDP_HEADER, packet.size)
            message.received++
        }
        control(RUDP_ACK, messageId, fragmentIndex)
        if (message.received == fragmentCount) {
            incoming.remove(messageId)
            try {
                val bytes = message.chunks.fold(ByteArray(0)) { acc, chunk -> acc + (chunk ?: ByteArray(0)) }
                completed[messageId] = JSONObject(String(bytes, Charsets.UTF_8))
            } catch (e: Exception) {
                log("UDP 业务帧解码失败: ${e.message}")
            }
            deliverOrdered()
        }
        return true
    }

    private fun deliverOrdered() {
        while (completed.containsKey(nextReceiveId)) {
            val frame = completed.remove(nextReceiveId) ?: break
            nextReceiveId++
            onFrame(frame)
        }
    }

    @Synchronized
    private fun retransmit() {
        if (!active) return
        val now = System.currentTimeMillis()
        for (message in pending.values) {
            for (index in message.chunks.indices) {
                if (message.acked[index] || now - message.lastSent[index] < RUDP_RETRANSMIT_MS) continue
                message.retries[index]++
                if (message.retries[index] > RUDP_MAX_RETRIES) {
                    fail("UDP 分片重传超限 msg=${message.id} fragment=$index")
                    return
                }
                sendFragment(message, index)
            }
        }
    }

    private fun keepalive() {
        if (!active) return
        if (System.currentTimeMillis() - lastReceived > RUDP_IDLE_MS) {
            fail("UDP 直连空闲超时")
            return
        }
        control(RUDP_PING)
    }

    @Synchronized
    private fun fail(reason: String) {
        if (!active) return
        val frames = pending.values.sortedBy { it.id }.map { it.frame } + queue
        log("UDP 可靠通道失败：$reason，回落中继（待回放 ${frames.size} 帧）")
        stop()
        onFail(frames)
    }

    @Synchronized
    fun stop() {
        if (!active) return
        active = false
        scheduler.shutdownNow()
        pending.clear()
        queue.clear()
        incoming.clear()
        completed.clear()
    }
}
