// 配对对端 NAT 过滤诊断：两个 UDP socket 提供主/备用回包源，候选经原中继交换。
// 只响应手机诊断 STUN 请求，不承载聊天业务，30 秒自动关闭。
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

const COOKIE = 0x2112a442

function request () {
  const packet = Buffer.alloc(20)
  packet.writeUInt16BE(0x0001, 0)
  packet.writeUInt32BE(COOKIE, 4)
  randomBytes(12).copy(packet, 8)
  return packet
}

function mappedAddress (packet) {
  if (packet.length < 20 || packet.readUInt16BE(0) !== 0x0101 || packet.readUInt32BE(4) !== COOKIE) return null
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2))
  for (let offset = 20; offset + 12 <= end;) {
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 2)
    const value = offset + 4
    if (value + length > end) break
    if ((type === 0x0020 || type === 0x0001) && length >= 8 && packet[value + 1] === 1) {
      const port = packet.readUInt16BE(value + 2) ^ (type === 0x0020 ? 0x2112 : 0)
      const raw = packet.readUInt32BE(value + 4) ^ (type === 0x0020 ? COOKIE : 0)
      return { ip: [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.'), port }
    }
    offset = value + length + ((4 - (length % 4)) % 4)
  }
  return null
}

function writeAddress (packet, offset, type, ip, port, xor) {
  packet.writeUInt16BE(type, offset)
  packet.writeUInt16BE(8, offset + 2)
  packet[offset + 5] = 1
  packet.writeUInt16BE(port ^ (xor ? 0x2112 : 0), offset + 6)
  const p = ip.split('.').map(Number)
  const raw = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
  packet.writeUInt32BE((raw ^ (xor ? COOKIE : 0)) >>> 0, offset + 8)
}

export class NatFilterResponder {
  constructor ({ attachId, requestId, phoneCandidate = null, sendRelay, log = () => {} }) {
    this.attachId = attachId
    this.requestId = requestId
    this.phoneCandidate = phoneCandidate
    this.sendRelay = sendRelay
    this.log = log
    this.dead = false
    this.primary = null
    this.alternate = null
    this.primaryCandidate = null
    this.alternateCandidate = null
    this.timer = setTimeout(() => this.stop(), 30000)
  }

  async start () {
    this.primary = await this.bindSocket('primary')
    this.alternate = await this.bindSocket('alternate')
    await Promise.all([
      this.discover(this.primary, candidate => { this.primaryCandidate = candidate }),
      this.discover(this.alternate, candidate => { this.alternateCandidate = candidate })
    ])
    if (this.dead) return
    if (!this.primaryCandidate || !this.alternateCandidate) {
      this.log('NAT_FILTER PC 未获得双 UDP 公网候选')
      this.stop()
      return
    }
    this.sendRelay({
      type: 'nat-filter-offer', attachId: this.attachId, requestId: this.requestId,
      primary: this.primaryCandidate, alternate: this.alternateCandidate
    })
    this.log(`NAT_FILTER PC 候选 primary=${this.primaryCandidate.ip}:${this.primaryCandidate.port} alternate=${this.alternateCandidate.ip}:${this.alternateCandidate.port}`)
    for (const delay of [0, 200, 500, 1000, 2000]) {
      setTimeout(() => this.punchToPhone(), delay)
    }
  }

  punchToPhone () {
    if (this.dead || !this.phoneCandidate) return
    for (const socket of [this.primary, this.alternate]) {
      socket?.send(request(), this.phoneCandidate.port, this.phoneCandidate.ip)
    }
    this.log(`NAT_FILTER PC 双端口向手机候选发包 target=${this.phoneCandidate.ip}:${this.phoneCandidate.port}`)
  }

  async bindSocket (role) {
    const socket = dgram.createSocket('udp4')
    socket.on('message', (packet, remote) => this.onMessage(role, packet, remote))
    socket.on('error', error => this.log(`NAT_FILTER PC ${role} socket: ${error.message}`))
    await new Promise(resolve => socket.bind(0, '0.0.0.0', resolve))
    return socket
  }

  async discover (socket, assign) {
    const timer = setTimeout(() => {}, 0)
    clearTimeout(timer)
    const { address } = await dns.lookup('stun.l.google.com', { family: 4 })
    return new Promise(resolve => {
      const timeout = setTimeout(resolve, 2500)
      const onPacket = packet => {
        const candidate = mappedAddress(packet)
        if (!candidate) return
        clearTimeout(timeout)
        socket.off('message', onPacket)
        assign(candidate)
        resolve()
      }
      socket.on('message', onPacket)
      socket.send(request(), 19302, address)
    })
  }

  onMessage (role, packet, remote) {
    if (this.dead || role !== 'primary' || !this.alternateCandidate || packet.length < 20) return
    if (packet.readUInt16BE(0) !== 0x0001 || packet.readUInt32BE(4) !== COOKIE) return
    let changePort = false
    const end = Math.min(packet.length, 20 + packet.readUInt16BE(2))
    for (let offset = 20; offset + 8 <= end;) {
      const type = packet.readUInt16BE(offset)
      const length = packet.readUInt16BE(offset + 2)
      if (type === 0x0003 && length >= 4) changePort = (packet.readUInt32BE(offset + 4) & 0x02) !== 0
      offset += 4 + length + ((4 - (length % 4)) % 4)
    }
    const out = Buffer.alloc(44)
    out.writeUInt16BE(0x0101, 0)
    out.writeUInt16BE(24, 2)
    out.writeUInt32BE(COOKIE, 4)
    packet.subarray(8, 20).copy(out, 8)
    writeAddress(out, 20, 0x0020, remote.address, remote.port, true)
    writeAddress(out, 32, 0x8023, this.alternateCandidate.ip, this.alternateCandidate.port, false)
    const sender = changePort ? this.alternate : this.primary
    sender.send(out, remote.port, remote.address)
    this.log(`NAT_FILTER PC 收到手机请求 source=${remote.address}:${remote.port} changePort=${changePort}`)
  }

  stop () {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.timer)
    for (const socket of [this.primary, this.alternate]) {
      try { socket?.close() } catch { /* 已关闭 */ }
    }
  }
}
