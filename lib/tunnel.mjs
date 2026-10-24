// 出站隧道客户端（自 companion-v2/src/relay-client.mjs 精简移植）：
// ws → 云端 /api/v1/tunnel（Bearer deviceToken）→ hello → 等手机 attach → 每 attach 一个 AttachSession
import { AttachSession } from './adapter.mjs'
import { Punch } from './punch.mjs'
import { bridgeToolbarHtml } from './bridge-toolbar.mjs'

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
    // 🔴 防僵尸（2026-10-23 事故）：patchReload: live 热重载会再次 apply()，
    //    若 cleanup 未执行/异常，旧 TunnelClient 与新客户端并存互相踢（云端 last-wins）。
    //    按 relayUrl 全局登记，start 时先停掉同地址旧客户端。
    const prev = TunnelClient._registry.get(this.relayUrl)
    if (prev && prev !== this) {
      try { prev.stop() } catch (e) { /* 忽略 */ }
    }
    TunnelClient._registry.set(this.relayUrl, this)
    this._connect()
  }

  static _registry = new Map()

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
        // 🔴 半开连接自愈（2026-10-23 事故）：TCP 静默死亡不触发 close——
        //    插件自认"已连接"而云端早无此隧道（手机持续 pc-offline）。
        //    socket 非 OPEN / pong 超窗 60s → 强制走 _down 重连。
        if (!this.ws || this.ws.readyState !== 1) { this._down('socket not open'); return }
        if (Date.now() - this._lastPong > 60000) { this._down('pong 超时（半开连接）'); return }
        this.ws.send(JSON.stringify({ type: 'ping' }))
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
    if (frame.type === 'web-login-ack') {
      const p = this._linkPending && this._linkPending.get('web:' + frame.id)
      if (p) { clearTimeout(p.timer); this._linkPending.delete('web:' + frame.id); p.resolve(frame) }
      return
    }
    if (frame.type === 'bridge-req') return this._onBridgeReq(frame)
    if (frame.type === 'bridge-ws-open') return this._onBridgeWsOpen(frame)
    if (frame.type === 'bridge-ws-data') {
      const ws = this._bridgeWs && this._bridgeWs.get(frame.chanId)
      // 观测点（2026-10-24 僵尸画面排查）：每帧记方向+大小+摘要，200ms 限频防刷屏
      const c = (this._bwsDown = this._bwsDown || new Map())
      const n = (c.get(frame.chanId) || 0) + 1
      c.set(frame.chanId, n)
      const t = Date.now()
      if (t - (c.get(frame.chanId + ':t') || 0) > 200) {
        c.set(frame.chanId + ':t', t)
        this.deps.log(`bridge mux ↓#${n} ${frame.text.length}B ${frame.text.slice(0, 80).replace(/\n/g, ' ')}`)
      }
      if (ws && ws.readyState === 1) ws.send(frame.text)
      return
    }
    if (frame.type === 'bridge-ws-close') {
      const ws = this._bridgeWs && this._bridgeWs.get(frame.chanId)
      if (ws) { this._bridgeWs.delete(frame.chanId); try { ws.close(1000, 'browser closed') } catch (e) { /* 忽略 */ } }
      return
    }
    if (frame.type === 'punch-match') {
      const p = this._punches && this._punches.get(frame.attachId)
      if (p) p.onMatch(frame.peer)
      return
    }
    if (frame.type === 'detach') {
      const s = this.sessions.get(frame.attachId)
      this.sessions.delete(frame.attachId)
      this._punches?.get(frame.attachId)?.stop()
      this._punches?.delete(frame.attachId)
      const oc = this._openConns?.get(frame.attachId)
      if (oc) {
        this._openConns.delete(frame.attachId)
        this.deps.onConnEvent?.({ ev: 'close', attachId: frame.attachId, peer: oc.peer, seq: oc.seq, path: this._directs.has(frame.attachId) ? 'direct' : 'relay', reason: frame.reason })
      }
      s?.detach(frame.reason || 'detach')
      return
    }
    const s = frame.attachId && this.sessions.get(frame.attachId)
    if (s) s.handle(frame).catch((e) => this.deps.log(`attach ${frame.attachId} 处理异常: ${e.message}`))
  }

  /** V5 P2P：按 attach 维度的直连 socket；发送优先直连，死亡自动回落中继 */
  _directs = new Map() // attachId -> net.Socket
  _punches = new Map() // attachId -> Punch
  _openConns = new Map() // V4.3 连接历史：attachId -> {peer, seq}（open 未 close 的连接）
  _punchTarget () {
    try {
      const u = new URL(this.relayUrl)
      return { host: u.hostname, regPort: Number(u.port || 80) + 5 }
    } catch (e) { return null }
  }
  _sendAttach (attachId, frame) {
    const d = this._directs.get(attachId)
    if (d && !d.destroyed && d.writable) {
      d.write(JSON.stringify(frame) + '\n')
    } else {
      this._directs.delete(attachId)
      this._send(frame)
    }
  }

  /** V4 远程登录：手机授权经 E2E 到达 adapter → 此处转发云端并等 ack */
  _linkPending = new Map()
  sendLinkApprove (id, from, mode) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._linkPending.delete(id); reject(new Error('云端 link-approve 超时')) }, 10000)
      this._linkPending.set(id, { resolve, timer })
      this._send({ type: 'link-approve', id, from, mode: mode || undefined })
    })
  }

  /** V4.1 浏览器远程登录：手机确认经 E2E 到达 adapter → 转发云端开桥接并等 ack（mode: temp=2h / long=30d） */
  sendWebLoginApprove (id, mode) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._linkPending.delete('web:' + id); reject(new Error('云端 web-login-approve 超时')) }, 10000)
      this._linkPending.set('web:' + id, { resolve, timer })
      this._send({ type: 'web-login-approve', id, mode: mode || undefined })
    })
  }

  // ---- V4.1 浏览器桥接：代浏览器访问本机 dsh（现铸 v1 Cookie） ----
  _bridgeWs = new Map() // chanId -> WebSocket（本机 mux）

  async _onBridgeReq (frame) {
    try {
      const origin = this.deps.getOrigin()
      const cookie = await this.deps.mintCookie()
      // 🔴 剥掉 origin/referer（2026-10-24 僵尸画面根因）：dsh 有 Host/Origin 栅栏
      //    （client-connection isSameAuthorityOrigin），浏览器带的 Origin=云端桥接地址
      //    与 dsh authority 不同源 → 所有 POST 403、GUI 只剩静态壳。
      //    手机原生 HTTP 客户端不发 Origin 所以从未触发。鉴权已由 v1 cookie 承担。
      const fwd = {}
      for (const [k, v] of Object.entries(frame.headers || {})) {
        const lk = k.toLowerCase()
        if (lk === 'origin' || lk === 'referer') continue
        fwd[k] = v
      }
      // 通用壳：/r/<key>/__happy/* → 插件内部端点（不经 dsh）——访问端浏览器工具栏的数据通道
      if (frame.path.startsWith('/__happy/')) {
        const body = frame.bodyB64 ? Buffer.from(frame.bodyB64, 'base64') : Buffer.alloc(0)
        const r = await this.deps.onInternalRequest(frame.path, frame.method || 'GET', body)
        const payload = Buffer.from(JSON.stringify(r?.body ?? { error: 'not found' }), 'utf8')
        return this._send({
          type: 'bridge-res', key: frame.key, seq: frame.seq, status: r?.status ?? 404,
          headers: { 'content-type': 'application/json' },
          bodyB64: payload.toString('base64')
        })
      }
      const res = await fetch(origin + frame.path, {
        method: frame.method || 'GET',
        headers: { ...fwd, Cookie: cookie },
        body: frame.bodyB64 ? Buffer.from(frame.bodyB64, 'base64') : undefined
      })
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      delete headers['content-encoding'] // fetch 已自动解压
      delete headers['content-length']
      let body = Buffer.from(await res.arrayBuffer())
      // 通用壳：桥接页面注入工具栏（访问端浏览器获得手机 App 的截图/剪贴板/窗口实况能力）
      const ct = (headers['content-type'] || '')
      if (frame.method !== 'POST' && ct.includes('text/html') && body.includes('</body>') && !body.includes('happy-bridge-toolbar')) {
        body = Buffer.from(body.toString('utf8').replace('</body>', bridgeToolbarHtml + '</body>'), 'utf8')
      }
      this._send({
        type: 'bridge-res', key: frame.key, seq: frame.seq, status: res.status, headers,
        bodyB64: body.toString('base64')
      })
    } catch (e) {
      this.deps.log('bridge 请求失败 ' + frame.path + ': ' + e.message)
      this._send({ type: 'bridge-res', key: frame.key, seq: frame.seq, status: 502, headers: {}, bodyB64: Buffer.from('bridge error: ' + e.message).toString('base64') })
    }
  }

  _onBridgeWsOpen (frame) {
    this.deps.log(`bridge mux ws open chan=${frame.chanId} path=${frame.path}`) // 2026-10-24 观测点：僵尸画面排查
    const origin = this.deps.getOrigin().replace(/^http/, 'ws')
    const chanId = frame.chanId
    const send = this._send.bind(this)
    this.deps.mintCookie().then((cookie) => {
      const ws = new WebSocket(origin + frame.path, { headers: { Cookie: cookie } })
      this._bridgeWs.set(chanId, ws)
      let dataCount = 0
      ws.onopen = () => this.deps.log(`bridge mux 本地已连接 chan=${chanId} → ${origin}${frame.path}`) // 观测点
      ws.onmessage = (ev) => {
        dataCount++
        const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
        const t = Date.now()
        if (t - (this._bwsUpT || 0) > 200) {
          this._bwsUpT = t
          this.deps.log(`bridge mux ↑#${dataCount} ${text.length}B ${text.slice(0, 80).replace(/\n/g, ' ')}`) // 观测点
        }
        send({ type: 'bridge-ws-data', chanId, text })
      }
      ws.onclose = () => { this._bridgeWs.delete(chanId); send({ type: 'bridge-ws-close', chanId }) }
      ws.onerror = () => { this.deps.log('bridge mux ws error chan=' + chanId) }
    }).catch((e) => this.deps.log('bridge ws open 失败: ' + e.message))
  }

  _onAttached (frame) {
    this.deps.log(`手机已附着: attach=${frame.attachId} 对端=${frame.peer?.deviceId}`)
    this._openConns.set(frame.attachId, { peer: frame.peer?.deviceId, seq: frame.peer?.seq })
    this.deps.onConnEvent?.({ ev: 'open', attachId: frame.attachId, peer: frame.peer?.deviceId, seq: frame.peer?.seq, path: 'relay' })
    const session = new AttachSession(frame, {
      getOrigin: this.deps.getOrigin,
      mintCookie: this.deps.mintCookie,
      targets: this.deps.targets, // 通用壳 P1：/t/<name>/ 目标路由
      onInternalRequest: this.deps.onInternalRequest, // 🔴 V4.1 起就漏传（2026-10-24 排查实锤）：缺失时手机所有 /__happy/* 请求 404 not found——远程登录批准、文件互传、截图、窗口实况全灭
      identity: this.identity,
      send: (f) => this._sendAttach(frame.attachId, f), // V5：优先直连
      log: this.deps.log
    })
    this.sessions.set(frame.attachId, session)
    session.startE2EHandshake()
    // V5 P2P：登记打洞（成功→直连承载；失败→无感走中继）
    const t = this._punchTarget()
    if (t) {
      const punch = new Punch({
        host: t.host, regPort: t.regPort, attachId: frame.attachId, role: 'pc',
        token: this.identity.deviceToken,
        sendRelay: (f) => this._send(f),
        log: (...a) => this.deps.log(`[pc] ${a.join(' ')}`),
        onDirect: (sock) => this._directs.set(frame.attachId, sock),
        onFail: () => {}
      })
      punch.onFrame((f) => {
        const s = this.sessions.get(frame.attachId)
        if (s) s.handle(f).catch((e) => this.deps.log(`attach ${frame.attachId} 直连帧处理异常: ${e.message}`))
      })
      punch.onDown = () => this._directs.delete(frame.attachId)
      this._punches.set(frame.attachId, punch)
      punch.start()
    }
  }

  _send (frame) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(frame))
  }

  _down (why) {
    if (!this.connected && !this.ws) return
    this.connected = false
    clearInterval(this._pingTimer)
    for (const [id, s] of this.sessions) { s.detach(); this.sessions.delete(id) }
    // V4.3 连接历史：隧道断开 = 所有未闭合连接以 abnormal 收尾
    if (this._openConns && this._openConns.size) {
      for (const [id, oc] of this._openConns) {
        this.deps.onConnEvent?.({ ev: 'close', attachId: id, peer: oc.peer, seq: oc.seq, path: this._directs.has(id) ? 'direct' : 'relay', reason: '连接中断' })
      }
      this._openConns.clear()
    }
    if (this.stopping) return
    this.deps.log(`中继断开（${why}），${this.backoffMs / 1000}s 后重连`)
    setTimeout(() => { if (!this.stopping) this._connect() }, this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS)
  }
}
