// 轻量可靠 UDP 通道：业务帧本身已有 E2E；本层只负责分片、ACK、重传、保序与去重回放。
// 包头 14B：HHR1 | type u8 | reserved u8 | messageId u32 | fragmentIndex u16 | fragmentCount u16。
import { randomBytes } from 'node:crypto'

const MAGIC = Buffer.from('HHR1')
const DATA = 1
const ACK = 2
const PING = 3
const PONG = 4
const HEADER = 14
const PAYLOAD = 1000
const MAX_IN_FLIGHT = 4
const RETRANSMIT_MS = 400
const MAX_RETRIES = 30
const KEEPALIVE_MS = 2000
const IDLE_MS = 12000

export class ReliableUdpChannel {
  constructor (opts) {
    this.channelId = opts.channelId || randomBytes(8).toString('hex')
    this.sendPacket = opts.sendPacket // (Buffer) => void
    this.onFrame = opts.onFrame
    this.onFail = opts.onFail // (pendingFrames) => void
    this.log = opts.log || (() => {})
    this.active = true
    this.nextMessageId = 1
    this.nextReceiveId = 1
    this.pending = new Map()
    this.queue = []
    this.incoming = new Map()
    this.completed = new Map()
    this.lastReceived = Date.now()
    this.retransmitTimer = setInterval(() => this._retransmit(), 200)
    this.keepaliveTimer = setInterval(() => this._keepalive(), KEEPALIVE_MS)
  }

  send (frame) {
    if (!this.active) return false
    this.queue.push(frame)
    this._pump()
    return true
  }

  _pump () {
    while (this.active && this.pending.size < MAX_IN_FLIGHT && this.queue.length) {
      const original = this.queue.shift()
      const id = this.nextMessageId++
      const frame = { ...original, udpId: original.udpId || `${this.channelId}:${id}` }
      const bytes = Buffer.from(JSON.stringify(frame), 'utf8')
      const count = Math.ceil(bytes.length / PAYLOAD)
      if (!count || count > 65535) {
        this.log(`UDP 业务帧大小不支持: ${bytes.length}`)
        continue
      }
      const chunks = []
      for (let index = 0; index < count; index++) chunks.push(bytes.subarray(index * PAYLOAD, Math.min(bytes.length, (index + 1) * PAYLOAD)))
      const message = { id, frame, chunks, acked: new Array(count).fill(false), lastSent: new Array(count).fill(0), retries: new Array(count).fill(0) }
      this.pending.set(id, message)
      for (let index = 0; index < count; index++) this._sendFragment(message, index)
    }
  }

  _sendFragment (message, index) {
    if (!this.active || message.acked[index]) return
    const packet = Buffer.allocUnsafe(HEADER + message.chunks[index].length)
    MAGIC.copy(packet, 0)
    packet[4] = DATA
    packet[5] = 0
    packet.writeUInt32BE(message.id, 6)
    packet.writeUInt16BE(index, 10)
    packet.writeUInt16BE(message.chunks.length, 12)
    message.chunks[index].copy(packet, HEADER)
    message.lastSent[index] = Date.now()
    this.sendPacket(packet)
  }

  _control (type, messageId = 0, fragmentIndex = 0) {
    if (!this.active) return
    const packet = Buffer.alloc(HEADER)
    MAGIC.copy(packet, 0)
    packet[4] = type
    packet.writeUInt32BE(messageId, 6)
    packet.writeUInt16BE(fragmentIndex, 10)
    this.sendPacket(packet)
  }

  handlePacket (packet) {
    if (!this.active || packet.length < HEADER || !packet.subarray(0, 4).equals(MAGIC)) return false
    this.lastReceived = Date.now()
    const type = packet[4]
    const messageId = packet.readUInt32BE(6)
    const fragmentIndex = packet.readUInt16BE(10)
    const fragmentCount = packet.readUInt16BE(12)
    if (type === PING) { this._control(PONG); return true }
    if (type === PONG) return true
    if (type === ACK) {
      const message = this.pending.get(messageId)
      if (!message || fragmentIndex >= message.chunks.length) return true
      message.acked[fragmentIndex] = true
      if (message.acked.every(Boolean)) {
        this.pending.delete(messageId)
        this._pump()
      }
      return true
    }
    if (type !== DATA || !fragmentCount || fragmentIndex >= fragmentCount || fragmentCount > 4096) return true
    // 已交付或已组包、正等待前序消息的数据仍只 ACK，不能重新创建分片状态。
    if (messageId < this.nextReceiveId || this.completed.has(messageId)) {
      this._control(ACK, messageId, fragmentIndex)
      return true
    }
    let message = this.incoming.get(messageId)
    if (!message) {
      message = { chunks: new Array(fragmentCount), received: 0 }
      this.incoming.set(messageId, message)
    }
    if (message.chunks.length !== fragmentCount) { this.incoming.delete(messageId); return true }
    if (!message.chunks[fragmentIndex]) {
      message.chunks[fragmentIndex] = packet.subarray(HEADER)
      message.received++
    }
    this._control(ACK, messageId, fragmentIndex)
    if (message.received === fragmentCount) {
      this.incoming.delete(messageId)
      try {
        const frame = JSON.parse(Buffer.concat(message.chunks).toString('utf8'))
        this.completed.set(messageId, frame)
      } catch (error) {
        this.log(`UDP 业务帧解码失败: ${error.message}`)
      }
      this._deliverOrdered()
    }
    return true
  }

  _deliverOrdered () {
    while (this.completed.has(this.nextReceiveId)) {
      const frame = this.completed.get(this.nextReceiveId)
      this.completed.delete(this.nextReceiveId)
      this.nextReceiveId++
      this.onFrame(frame)
    }
  }

  _retransmit () {
    if (!this.active) return
    const now = Date.now()
    for (const message of this.pending.values()) {
      for (let index = 0; index < message.chunks.length; index++) {
        if (message.acked[index] || now - message.lastSent[index] < RETRANSMIT_MS) continue
        message.retries[index]++
        if (message.retries[index] > MAX_RETRIES) {
          this._fail(`UDP 分片重传超限 msg=${message.id} fragment=${index}`)
          return
        }
        this._sendFragment(message, index)
      }
    }
  }

  _keepalive () {
    if (!this.active) return
    if (Date.now() - this.lastReceived > IDLE_MS) {
      this._fail('UDP 直连空闲超时')
      return
    }
    this._control(PING)
  }

  _fail (reason) {
    if (!this.active) return
    const frames = [...this.pending.values()].sort((a, b) => a.id - b.id).map((message) => message.frame)
    frames.push(...this.queue)
    this.log(`UDP 可靠通道失败：${reason}，回落中继（待回放 ${frames.length} 帧）`)
    this.stop()
    this.onFail?.(frames)
  }

  stop () {
    if (!this.active) return
    this.active = false
    clearInterval(this.retransmitTimer)
    clearInterval(this.keepaliveTimer)
    this.pending.clear()
    this.queue = []
    this.incoming.clear()
    this.completed.clear()
  }
}
