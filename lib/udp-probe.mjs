// UDP 直连：先以随机 probeId 的 SYN/ACK 验证双向可达，再复用同一 socket 承载可靠 E2E 业务帧。
// 通过现有 attach 控制帧交换 STUN 候选；打洞或可靠通道失败时保留中继并回放未确认业务帧。
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { randomBytes } from 'node:crypto'
import { ReliableUdpChannel } from './reliable-udp.mjs'

const COOKIE = 0x2112a442
const DEFAULT_STUN = [
  ['stun.l.google.com', 19302],
  ['stun.miwifi.com', 3478],
  ['stun.freeswitch.org', 3478]
]

const stunRequest = () => {
  const packet = Buffer.alloc(20)
  packet.writeUInt16BE(0x0001, 0)
  packet.writeUInt32BE(COOKIE, 4)
  randomBytes(12).copy(packet, 8)
  return packet
}

const parseStunAddress = (packet) => {
  if (packet.length < 20 || packet.readUInt16BE(0) !== 0x0101 || packet.readUInt32BE(4) !== COOKIE) return null
  const end = Math.min(packet.length, 20 + packet.readUInt16BE(2))
  let offset = 20
  while (offset + 4 <= end) {
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 2)
    const value = offset + 4
    if (value + length > end) break
    if (length >= 8 && (type === 0x0020 || type === 0x0001) && packet[value + 1] === 0x01) {
      const port = packet.readUInt16BE(value + 2) ^ (type === 0x0020 ? (COOKIE >>> 16) : 0)
      const raw = packet.readUInt32BE(value + 4) ^ (type === 0x0020 ? COOKIE : 0)
      return { ip: [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.'), port }
    }
    offset = value + length + ((4 - (length % 4)) % 4)
  }
  return null
}

// 仅保存在进程内：跨 attach 学习运营商 NAT 的端口分配习惯，不写盘、不额外外发。
const peerMappingHistory = new Map()

function rememberMappingHistory (candidates) {
  for (const { ip, port } of candidates) {
    if (!peerMappingHistory.has(ip)) {
      if (peerMappingHistory.size >= 8) peerMappingHistory.delete(peerMappingHistory.keys().next().value)
      peerMappingHistory.set(ip, [])
    }
    const history = peerMappingHistory.get(ip)
    if (!history.includes(port)) history.push(port)
    while (history.length > 32) history.shift()
  }
}

function mappingHistoryFor (candidates) {
  const ips = new Set(candidates.map(item => item.ip))
  const result = []
  for (const ip of ips) {
    for (const port of peerMappingHistory.get(ip) || []) result.push({ ip, port })
  }
  return result
}

// 同一 NAT 的多次 STUN 映射若呈现稳定间隔，下一个目的地址常会沿用该步长。
// 历史样本允许学习 +1/+11 等小步长；每个 IP 最多 32 项，相邻映射前后各外推 4 项。
export function mappingPredictionTargets (candidates, maxDistance = 4, history = []) {
  const byIp = new Map()
  for (const item of [...candidates, ...history]) {
    if (!item || typeof item.ip !== 'string' || !Number.isInteger(item.port)) continue
    const list = byIp.get(item.ip) || []
    if (!list.includes(item.port)) list.push(item.port)
    byIp.set(item.ip, list)
  }
  const result = new Map()
  for (const [ip, ports] of byIp) {
    ports.sort((a, b) => a - b)
    for (let i = 0; i + 1 < ports.length; i++) {
      const step = ports[i + 1] - ports[i]
      if (step < 1 || step > 16384) continue
      for (let distance = 1; distance <= maxDistance; distance++) {
        for (const port of [ports[i] - step * distance, ports[i + 1] + step * distance]) {
          if (port > 0 && port <= 65535) result.set(`${ip}:${port}`, { ip, port })
        }
      }
    }
  }
  return [...result.values()]
}

export class UdpProbe {
  constructor (opts) {
    this.attachId = opts.attachId
    this.sendRelay = opts.sendRelay
    this.onFrame = opts.onFrame || (() => {})
    this.onDirect = opts.onDirect || (() => {})
    this.onDown = opts.onDown || (() => {})
    this.log = opts.log || (() => {})
    this.stunServers = opts.stunServers || DEFAULT_STUN
    this.localCandidate = opts.localCandidate || null
    this.discoveryMs = opts.discoveryMs ?? 1600
    this.probeIntervalMs = opts.probeIntervalMs ?? 250
    this.lifetimeMs = opts.lifetimeMs ?? 7000
    this.probeId = randomBytes(12).toString('hex')
    this.candidates = new Map()
    this.peerCandidates = []
    this.peerProbeId = ''
    this.socket = null
    this.reliable = null
    this.remote = null
    this.dead = false
    this.synSeen = false
    this.ackSeen = false
    this.synTicks = 0
  }

  async start () {
    this.socket = dgram.createSocket('udp4')
    this.socket.on('message', (packet, remote) => this._onMessage(packet, remote))
    this.socket.on('error', (error) => this.log(`UDP 探针 socket 错误: ${error.message}`))
    await new Promise((resolve) => this.socket.bind(0, '0.0.0.0', resolve))
    if (this.dead) return
    this.localPort = this.socket.address().port
    if (this.localCandidate) this._addCandidate(this.localCandidate.ip, this.localCandidate.port || this.localPort)
    this.log(`UDP 探针启动 local=${this.localPort} probe=${this.probeId.slice(0, 8)}`)
    for (const [host, port] of this.stunServers) {
      try {
        const { address } = await dns.lookup(host, { family: 4 })
        if (!this.dead) this.socket.send(stunRequest(), port, address)
      } catch (error) {
        this.log(`UDP STUN 解析失败 ${host}: ${error.message}`)
      }
    }
    this.advertiseTimer = setTimeout(() => this._advertise(), this.discoveryMs)
    this.probeStartTimer = setTimeout(() => {
      this.probeTimer = setInterval(() => this._sendSyn(), this.probeIntervalMs)
    }, this.discoveryMs + 100)
    this.stopTimer = setTimeout(() => this.stop(), this.lifetimeMs)
  }

  _addCandidate (ip, port) {
    if (!ip || !port) return
    this.candidates.set(`${ip}:${port}`, { ip, port })
  }

  _advertise () {
    if (this.dead) return
    const candidates = [...this.candidates.values()]
    if (!candidates.length) {
      this.log('UDP 探针未获得 STUN 公网候选')
      return
    }
    this.log(`UDP 候选 ${candidates.map(({ ip, port }) => `${ip}:${port}`).join(', ')}`)
    this.sendRelay({ type: 'udp-candidate', attachId: this.attachId, probeId: this.probeId, candidates })
  }

  onPeer (frame) {
    if (this.dead || frame.attachId !== this.attachId || typeof frame.probeId !== 'string' || !Array.isArray(frame.candidates)) return
    this.peerProbeId = frame.probeId
    this.peerCandidates = frame.candidates.filter((item) => item && typeof item.ip === 'string' && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535)
    rememberMappingHistory(this.peerCandidates)
    this.log(`UDP 对端候选 ${this.peerCandidates.map(({ ip, port }) => `${ip}:${port}`).join(', ') || '空'}`)
  }

  _onMessage (packet, remote) {
    if (this.dead) return
    if (this.reliable && this.remote && remote.address === this.remote.ip && remote.port === this.remote.port && this.reliable.handlePacket(packet)) return
    const mapped = parseStunAddress(packet)
    if (mapped) {
      this._addCandidate(mapped.ip, mapped.port)
      return
    }
    let frame
    try { frame = JSON.parse(packet.toString('utf8')) } catch { return }
    if (!frame || frame.type !== 'udp-probe' || frame.attachId !== this.attachId || typeof frame.probeId !== 'string') return
    if (frame.step === 'syn') {
      if (!this.peerProbeId || frame.probeId !== this.peerProbeId) return
      if (!this.synSeen) {
        this.synSeen = true
        this.log(`UDP 探针收到对端 SYN（入站可达）source=${remote.address}:${remote.port}`)
      }
      this._send({ type: 'udp-probe', attachId: this.attachId, probeId: frame.probeId, step: 'ack' }, remote.address, remote.port)
    } else if (frame.step === 'ack' && frame.probeId === this.probeId) {
      if (!this.ackSeen) {
        this.ackSeen = true
        this.log(`UDP 探针双向成功 ✅ source=${remote.address}:${remote.port}`)
      }
      this._establish(remote.address, remote.port)
    }
  }

  _establish (ip, port) {
    if (this.dead || this.reliable || !this.socket) return
    this.remote = { ip, port }
    clearTimeout(this.advertiseTimer)
    clearTimeout(this.probeStartTimer)
    clearInterval(this.probeTimer)
    clearTimeout(this.stopTimer)
    const channel = new ReliableUdpChannel({
      sendPacket: (packet) => {
        if (!this.dead && this.socket && this.remote) this.socket.send(packet, this.remote.port, this.remote.ip)
      },
      onFrame: this.onFrame,
      onFail: (pending) => {
        if (this.reliable !== channel) return
        this.reliable = null
        this.onDirect(false)
        this.sendRelay({ type: 'punch-revert', attachId: this.attachId })
        this.onDown(pending)
        this.stop()
      },
      log: this.log
    })
    this.reliable = channel
    this.log(`UDP 业务直连建立 ✅ remote=${ip}:${port}`)
    this.sendRelay({ type: 'punch-ok', attachId: this.attachId })
    this.onDirect(true)
  }

  isDirect () {
    return this.reliable?.active === true
  }

  send (frame) {
    return this.reliable?.send(frame) === true
  }

  _sendSyn () {
    if (this.dead || this.reliable || !this.peerProbeId || !this.peerCandidates.length) return
    const frame = { type: 'udp-probe', attachId: this.attachId, probeId: this.probeId, step: 'syn' }
    const tick = this.synTicks++
    for (const target of this.peerCandidates) this._send(frame, target.ip, target.port)
    // 双端协同补偿：先按 STUN 映射步长外推，再小范围轮换附近端口；均有界。
    if (tick < 4) return
    if (tick === 4) this.log(`UDP 正常候选未打通，启动双端协同端口预测（近端 ±96，历史映射 ${mappingHistoryFor(this.peerCandidates).length} 项，步长外推 4 步）`)
    for (const target of mappingPredictionTargets(this.peerCandidates, 4, mappingHistoryFor(this.peerCandidates))) this._send(frame, target.ip, target.port)
    const start = (tick - 4) * 8
    for (const target of this.peerCandidates) {
      for (let i = 0; i < 8; i++) {
        const step = start + i
        const magnitude = Math.floor(step / 2) + 1
        if (magnitude > 96) continue
        const port = target.port + (step % 2 === 0 ? magnitude : -magnitude)
        if (port > 0 && port <= 65535) this._send(frame, target.ip, port)
      }
    }
  }

  _send (frame, ip, port) {
    if (this.dead || !this.socket) return
    try { this.socket.send(Buffer.from(JSON.stringify(frame)), port, ip) } catch { /* 诊断失败由超时结果表达 */ }
  }

  stop () {
    if (this.dead) return
    this.dead = true
    clearTimeout(this.advertiseTimer)
    clearTimeout(this.probeStartTimer)
    clearInterval(this.probeTimer)
    clearTimeout(this.stopTimer)
    this.reliable?.stop()
    this.reliable = null
    try { this.socket?.close() } catch { /* 已关闭 */ }
    if (!this.ackSeen) this.log(`UDP 探针结束：双向未成功（synSeen=${this.synSeen}）`)
  }
}
