// 出站隧道客户端（自 companion-v2/src/relay-client.mjs 精简移植）：
// ws → 云端 /api/v1/tunnel（Bearer deviceToken）→ hello → 等手机 attach → 每 attach 一个 AttachSession
import { AttachSession } from './adapter.mjs'

const PING_INTERVAL_MS = 25000
const RECONNECT_MAX_MS = 30000

export class TunnelClient {
  // opts: { relayUrl, identity, deps: { getOrigin, mintCookie, log } }
  constructor (opts) {
    this.relayUrl = opts.relayUrl
    this.identity = opts.identity
    this.deps = opts.deps
    this.ws = null
    this.sessions = new Map()
    this.connected = false
    this.backoffMs = 1000
    this.stopping = false
    this._pingTimer = null
    this._lastPong = Date.now()
  }

  start () {
    this.stopping = false
    this._connect()
  }

  stop () {
    this.stopping = true
    clearInterval(this._pingTimer)
    try { this.ws?.close() } catch (e) { /* 忽略 */ }
    for (const [id, s] of this.sessions) { s.detach(); this.sessions.delete(id) }
  }

  _connect () {
    const ws = new WebSocket(this.relayUrl, { headers: { Authorization: `Bearer ${this.identity.deviceToken}` } })
    this.ws = ws
    ws.onopen = () => {
      this.deps.log('中继已连接:', this.relayUrl)
      this.backoffMs = 1000
      ws.send(JSON.stringify({ type: 'hello', protocol: 1 }))
    }
    ws.onmessage = (ev) => this._onFrame(String(ev.data))
    ws.onclose = () => this._down('closed')
    ws.onerror = () => { /* onclose 跟随 */ }
  }

  _onFrame (text) {
    let frame
    try { frame = JSON.parse(text) } catch { return }
    if (frame.type === 'hello-ack') {
      this.connected = true
      this._lastPong = Date.now()
      clearInterval(this._pingTimer)
      this._pingTimer = setInterval(() => {
        if (Date.now() - this._lastPong > 75000) { this.ws?.close(); return }
        if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping' }))
      }, PING_INTERVAL_MS)
      return
    }
    if (frame.type === 'pong') { this._lastPong = Date.now(); return }
    if (frame.type === 'attached') return this._onAttached(frame)
    if (frame.type === 'link-ack') {
      const p = this._linkPending && this._linkPending.get(frame.id)
      if (p) { clearTimeout(p.timer); this._linkPending.delete(frame.id); p.resolve(frame) }
      return
    }
    if (frame.type === 'detach') {
      const s = this.sessions.get(frame.attachId)
      this.sessions.delete(frame.attachId)
      s?.detach(frame.reason || 'detach')
      return
    }
    const s = frame.attachId && this.sessions.get(frame.attachId)
    if (s) s.handle(frame).catch((e) => this.deps.log(`attach ${frame.attachId} 处理异常: ${e.message}`))
  }

  /** V4 远程登录：手机授权经 E2E 到达 adapter → 此处转发云端并等 ack */
  _linkPending = new Map()
  sendLinkApprove (id, from) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._linkPending.delete(id); reject(new Error('云端 link-approve 超时')) }, 10000)
      this._linkPending.set(id, { resolve, timer })
      this._send({ type: 'link-approve', id, from })
    })
  }

  _onAttached (frame) {
    this.deps.log(`手机已附着: attach=${frame.attachId} 对端=${frame.peer?.deviceId}`)
    const session = new AttachSession(frame, {
      getOrigin: this.deps.getOrigin,
      mintCookie: this.deps.mintCookie,
      identity: this.identity,
      send: (f) => this._send(f),
      log: this.deps.log
    })
    this.sessions.set(frame.attachId, session)
    session.startE2EHandshake()
  }

  _send (frame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame))
  }

  _down (why) {
    if (!this.connected && !this.ws) return
    this.connected = false
    clearInterval(this._pingTimer)
    for (const [id, s] of this.sessions) { s.detach(); this.sessions.delete(id) }
    if (this.stopping) return
    this.deps.log(`中继断开（${why}），${this.backoffMs / 1000}s 后重连`)
    setTimeout(() => { if (!this.stopping) this._connect() }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS)
  }
}
