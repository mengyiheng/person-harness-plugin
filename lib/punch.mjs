// V5 P2P 打洞客户端（TCP 同时打开法）——见《PC端P2P打洞方案-V5.md》
// 用法（PC 侧 TunnelClient / 手机角色 RemoteLinkClient 同款）：
//   const p = new Punch({ host, regPort, attachId, role, token, sendRelay, log,
//                         onDirect: (sock) => ..., onFail: () => {} })
//   p.start()                        // 向云端登记 NAT 映射
//   p.onMatch(peer)                  // 收到 punch-match（经中继）后同时打开
//   p.send(frame)                    // 直连建立后经直连发帧（JSON 行式）
//   失败/死亡：静默回落中继（调用方把路由切回 relay 并 sendRelay({type:'punch-revert'})）
import net from 'node:net'
import os from 'node:os'

const localIPv4 = () => [...new Set(Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address))]

const OPEN_RETRIES = 6
const OPEN_RETRY_MS = 400
const PUNCH_BUDGET_MS = 3000
const DIRECT_IDLE_MS = 12000
const HEARTBEAT_MS = 5000

export class Punch {
  constructor (opts) {
    this.host = opts.host
    this.regPort = opts.regPort
    this.attachId = opts.attachId
    this.role = opts.role
    this.token = opts.token
    this.sendRelay = opts.sendRelay // (frame) => void，经中继控制信道发
    this.log = opts.log
    this.onDirect = opts.onDirect // (sock) => void：直连可用（可 send/handle）
    this.onFail = opts.onFail
    this.regSock = null
    this.localPort = 0
    this.sock = null // 直连 socket
    this._established = false
    this._lastData = Date.now()
    this._buf = ''
    this._hb = null
    this._dead = false
  }

  get established () { return this._established }

  start () {
    const t0 = Date.now()
    const sock = net.connect(this.regPort, this.host)
    this.regSock = sock
    sock.setNoDelay(true)
    sock.on('connect', () => {
      this.localPort = sock.localPort
      sock.write(JSON.stringify({ type: 'punch-reg', attachId: this.attachId, role: this.role, token: this.token }) + '\n')
    })
    sock.on('data', (d) => {
      // 登记应答（后续 match 走中继，此 socket 只保映射）
      const t = d.toString('utf8').trim()
      if (t.includes('"ok":true')) {
        this.log(`punch 登记成功（本地端口 ${this.localPort}）`)
      } else if (t.includes('"ok":false')) {
        this.log('punch 登记被拒: ' + t.slice(0, 80))
        this._giveUp()
      }
    })
    sock.on('error', () => { if (!this._established) this._giveUp() })
    // 总预算：3 秒内没直连成功就放弃
    setTimeout(() => { if (!this._established) this._giveUp() }, PUNCH_BUDGET_MS + (Date.now() - t0))
  }

  /** 云端经中继送达 punch-match：监听自己的登记端口 + 同时向对方打开（双路并行） */
  onMatch (peer) {
    if (this._dead || this._established) return
    this.peer = peer
    this.log(`punch match ${peer.ip}:${peer.port} local=${this.localPort}`)
    this._listenPeer()
    this._openPeer(0)
  }

  /** 监听自己的登记端口：对端连进来即直连（真实 NAT 下亦可兜住部分场景） */
  _listenPeer () {
    if (this._listener) return
    const srv = net.createServer((sock) => {
      if (this._established || this._dead) { sock.destroy(); return }
      sock.setNoDelay(true)
      this.log('punch 对端连入 ✅')
      this._wire(sock)
      sock.write(JSON.stringify({ type: 'punch-syn', attachId: this.attachId }) + '\n')
    })
    srv.on('error', () => { /* EADDRINUSE 等：静默，连接侧仍会尝试 */ })
    srv.listen(this.localPort, () => {
      this.log(`punch 本地监听 :${this.localPort}`)
      // 公网打洞之外并行尝试 LAN；控制帧只到本次已配对 attach，不暴露 HTTP 轻壳。
      this.sendRelay({ type: 'punch-local', attachId: this.attachId, port: this.localPort, addresses: localIPv4() })
    })
    this._listener = srv
  }

  _openPeer (attempt) {
    if (this._dead || this._established) return
    // 关登记连接释放本地端口（NAT 映射短时间内仍在）
    if (this.regSock && !this.regSock.destroyed) {
      this.regSock.destroy()
      setTimeout(() => this._connectPeer(attempt), 150)
      return
    }
    this._connectPeer(attempt)
  }

  _connectPeer (attempt) {
    if (this._dead || this._established) return
    const sock = net.connect({ host: this.peer.ip, port: this.peer.port, localPort: this.localPort })
    sock.setNoDelay(true)
    const failTimer = setTimeout(() => { if (!this._established) { sock.destroy(); this._retry(attempt, 'timeout') } }, OPEN_RETRY_MS)
    sock.on('connect', () => {
      clearTimeout(failTimer)
      this.log(`punch 第${attempt + 1}次连接对端成功`)
      this._wire(sock)
      sock.write(JSON.stringify({ type: 'punch-syn', attachId: this.attachId }) + '\n')
    })
    sock.on('error', (e) => { clearTimeout(failTimer); this._retry(attempt, e.code + ': ' + e.message) })
  }

  _retry (attempt, why) {
    if (this._dead || this._established) return
    this.log(`punch 尝试${attempt + 1}失败（${why}）`)
    if (attempt + 1 >= OPEN_RETRIES) { this._giveUp(); return }
    setTimeout(() => this._connectPeer(attempt + 1), 60)
  }

  /** 直连 socket 通用接线：punch-syn 握手 + 行式 JSON 双向 + 心跳/死亡检测 */
  _wire (sock) {
    if (this.sock) { try { this.sock.destroy() } catch (e) { /* 忽略 */ } }
    this.sock = sock
    this._buf = ''
    this._lastData = Date.now()
    sock.on('data', (d) => {
      if (this.sock !== sock || this._dead) return
      this._lastData = Date.now()
      this._buf += d.toString('utf8')
      let nl
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl); this._buf = this._buf.slice(nl + 1)
        if (!line.trim()) continue
        let f
        try { f = JSON.parse(line) } catch { continue }
        if (f.type === 'punch-syn') { this._markEstablished(); continue }
        if (f.type === 'punch-ping') { continue }
        if (this._frameSink) this._frameSink(f)
      }
    })
    sock.on('close', () => { if (this.sock === sock) this._onDirectDown() })
    sock.on('error', () => { try { sock.destroy() } catch (e) { /* 忽略 */ } })
  }

  _markEstablished () {
    if (this._established) return
    this._established = true
    this.log('punch 直连建立 ✅')
    this.sendRelay({ type: 'punch-ok', attachId: this.attachId })
    this.onDirect?.(this.sock)
    this._hb = setInterval(() => {
      if (Date.now() - this._lastData > DIRECT_IDLE_MS) { this.log('punch 直连空闲超时，回落中继'); this._onDirectDown(); return }
      this.send(JSON.stringify({ type: 'punch-ping' }))
    }, HEARTBEAT_MS)
  }

  /** 收到对端业务帧的回调注册（直连帧与本来的中继帧汇入同一处理） */
  onFrame (sink) { this._frameSink = sink }

  send (objOrLine) {
    const line = typeof objOrLine === 'string' ? objOrLine : JSON.stringify(objOrLine)
    if (this.sock && !this.sock.destroyed && this.sock.writable) this.sock.write(line.endsWith('\n') ? line : line + '\n')
  }

  _onDirectDown () {
    if (!this._established) return
    this._established = false
    if (this._hb) { clearInterval(this._hb); this._hb = null }
    try { this.sock?.destroy() } catch (e) { /* 忽略 */ }
    this.sock = null
    this.sendRelay({ type: 'punch-revert', attachId: this.attachId })
    this.onDown?.()
  }

  /** 直连死亡（切回中继）回调 */
  onDown = null

  _giveUp () {
    if (this._dead || this._established) return
    this._dead = true
    try { this.regSock?.destroy() } catch (e) { /* 忽略 */ }
    try { this._listener?.close() } catch (e) { /* 忽略 */ }
    this.onFail?.('punch 放弃（回落中继，无感）')
  }

  stop () {
    this._dead = true
    if (this._hb) clearInterval(this._hb)
    try { this.regSock?.destroy() } catch (e) { /* 忽略 */ }
    try { this.sock?.destroy() } catch (e) { /* 忽略 */ }
    try { this._listener?.close() } catch (e) { /* 忽略 */ }
  }
}
