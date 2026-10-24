// RemoteLink（V4 远程登录）：本机插件扮演"手机"角色，连到另一台被授权 PC 的隧道，
// 本地起反向代理（127.0.0.1:<port>），浏览器打开即那台 PC 的完整 dsh GUI。
// 复用现有协议：attach/E2E(offer/accept/confirm)/open/data/close —— 对端插件零改动。
// 客户端逻辑源自 companion-v2/test/sim-plugin-e2e.mjs（已验证的手机角色实现）。
import http from 'node:http'
import { genEphemeral, signE2E, verifyE2E, deriveKeys, E2EBox } from './e2e.mjs'
import { WsLite } from './ws-lite.mjs'
import { Punch } from './punch.mjs'

const HOP_BY_HOP = new Set(['host', 'cookie', 'authorization', 'content-length', 'connection', 'upgrade'])

/** 手机角色隧道客户端（对目标 PC attach + E2E + 业务流） */
export class RemoteLinkClient {
  // opts: { relayUrl, identity(插件自己的 Ed25519 身份), pcPub(目标 PC 公钥), log }
  constructor (opts) {
    this.relayUrl = opts.relayUrl
    this.identity = opts.identity // { privateKeyPem, publicKeyB64 }
    this.pcPub = opts.pcPub
    this.log = opts.log
    this.ws = null
    this.attachId = ''
    this.box = null
    this.eph = null
    this.pcEph = ''
    this.onReady = null
    this.streams = new Map() // streamId -> { head, chunks, resolveHead }
    this._closed = false
  }

  start () {
    const ws = new WebSocket(this.relayUrl, { headers: { Authorization: `Bearer ${this.credential}` } })
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 1 }))
    ws.onmessage = (ev) => this._onFrame(String(ev.data))
    ws.onclose = () => { this.log('remote-link 隧道断开'); this._closed = true; this.onDown?.('relay closed') }
    ws.onerror = () => {}
  }

  /** 云端发放的一次性 link 凭证（attach 鉴权用） */
  setCredential (credential) { this.credential = credential }

  _send (obj) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)) }

  /** 发一条密文业务帧（open/data/close）—— V5：直连建立后走直连 */
  sendBiz (frame) {
    if (!this.box) throw new Error('E2E 未就绪')
    const wire = { type: frame.type, attachId: this.attachId, streamId: frame.streamId ?? '-' }
    if (frame.fin) wire.fin = true
    wire.e2e = this.box.seal(frame.streamId ?? '-', frame.type, JSON.stringify({ rest: frame }))
    if (this.punch && this.punch.established) {
      this.punch.send(wire)
    } else {
      this._send(wire)
    }
  }

  /** V5 P2P：attach 后登记打洞（role=phone，凭证同隧道） */
  _startPunch () {
    try {
      const u = new URL(this.relayUrl)
      const p = new Punch({
        host: u.hostname, regPort: Number(u.port || 80) + 5, attachId: this.attachId,
        role: 'phone', token: this.credential,
        sendRelay: (f) => this._send(f),
        log: (...a) => this.log('[link] ' + a.join(' ')),
        onDirect: () => {},
        onFail: () => {}
      })
      p.onFrame((f) => this._onFrame(JSON.stringify(f)))
      this.punch = p
      p.start()
    } catch (e) {
      this.log('punch 初始化失败（走中继）: ' + e.message)
    }
  }

  _onFrame (text) {
    let f
    try { f = JSON.parse(text) } catch { return }
    if (f.type === 'error') { this.log('remote-link 中继错误: ' + (f.code ?? '')); return }
    if (f.type === 'attached') { this.attachId = f.attachId; this._startPunch(); return }
    if (f.type === 'punch-match') { this.punch?.onMatch(f.peer); return }
    if (f.type === 'e2e' && f.step === 'offer') {
      // 对端(PC) offer：回 accept（签名 transcript(attachId, 己方eph, 对方eph)）
      this.pcEph = f.ephemeral
      this.eph = genEphemeral()
      const sig = signE2E(this.identity.privateKey, this.attachId, this.eph.publicKeyB64, this.pcEph)
      this._send({ type: 'e2e', step: 'accept', attachId: this.attachId, ephemeral: this.eph.publicKeyB64, signature: sig })
      return
    }
    if (f.type === 'e2e' && f.step === 'accept') { this.pcEph = f.ephemeral; return }
    if (f.type === 'e2e' && f.step === 'confirm') {
      const ok = verifyE2E(this.pcPub, f.signature, this.attachId, this.pcEph, this.eph.publicKeyB64)
      if (!ok) { this.log('remote-link: PC confirm 验签失败'); return }
      this.box = new E2EBox(deriveKeys(this.eph.privateKey, this.pcEph, this.attachId, 'phone'), this.attachId)
      this.log('remote-link: E2E 就绪')
      this.onReady?.()
      return
    }
    if (f.e2e && this.box) {
      let biz
      try {
        biz = JSON.parse(this.box.open(f.streamId ?? '-', f.type, f.e2e)).rest
      } catch (e) {
        this.log('remote-link 解密失败: ' + e.message)
        return
      }
      const st = this.streams.get(f.streamId ?? '-')
      if (st) st.push(biz)
    }
  }

  /** 一元 HTTP：经隧道到对端 PC 的 dsh（对端插件已代铸 Cookie） */
  async httpCall (method, path, bodyBuf, contentType) {
    const sid = 'h' + Date.now() + Math.random().toString(36).slice(2, 6)
    const st = newStream()
    this.streams.set(sid, st)
    const headers = {}
    if (bodyBuf && contentType) headers['content-type'] = contentType
    this.sendBiz({ type: 'open', streamId: sid, kind: 'http', method, path, headers })
    this.sendBiz({ type: 'data', streamId: sid, data: (bodyBuf ?? Buffer.alloc(0)).toString('base64'), fin: true })
    const head = await st.waitHead(30000)
    const body = await st.waitBody(120000)
    this.sendBiz({ type: 'close', streamId: sid })
    this.streams.delete(sid)
    return { status: head.status ?? 0, headers: head.headers ?? {}, body }
  }

  /** mux WS：升级回调（onOpen 后双向文本透传） */
  openMux (onText, onDown) {
    const sid = 'w' + Date.now() + Math.random().toString(36).slice(2, 6)
    const st = newStream()
    this.streams.set(sid, st)
    this.sendBiz({ type: 'open', streamId: sid, kind: 'ws', path: '/api/remote.mux', headers: {} })
    // ws 流的 data 帧 = mux 文本；close = 断开
    st.onText = onText
    st.onDown = onDown
    return {
      send: (text) => this.sendBiz({ type: 'data', streamId: sid, data: Buffer.from(text, 'utf8').toString('base64'), fin: true }),
      close: () => { this.sendBiz({ type: 'close', streamId: sid }); this.streams.delete(sid) }
    }
  }
}

function newStream () {
  return {
    head: null, chunks: [], bodyDone: false, _waiters: [],
    onText: null, onDown: null,
    push (biz) {
      if (biz.type === 'http-head') this.head = biz
      if (biz.type === 'data' && biz.data) this.chunks.push(biz.data)
      if (biz.type === 'data' && biz.fin) this.bodyDone = true
      if (biz.type === 'close') { this.bodyDone = true; this.onDown?.(biz.reason ?? '') }
      if (biz.type === 'data' && this.onText && biz.data) {
        this.onText(Buffer.from(biz.data, 'base64').toString('utf8'))
      }
      this._wake()
    },
    _wake () { this._waiters = this._waiters.filter((w) => !w()) },
    waitHead (timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('http-head 超时')), timeoutMs)
        const check = () => { if (this.head) { clearTimeout(t); resolve(this.head); return true } return false }
        if (check()) return
        this._waiters.push(check)
      })
    },
    waitBody (timeoutMs) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('响应体超时')), timeoutMs)
        const check = () => { if (this.bodyDone) { clearTimeout(t); resolve(Buffer.from(this.chunks.join(''), 'base64')); return true } return false }
        if (check()) return
        this._waiters.push(check)
      })
    }
  }
}

/** 本地反向代理：127.0.0.1:<port> → 隧道。HTTP 透传 + /api/remote.mux WS 升级。 */
export function startLocalProxy (client, port, log) {
  const muxChans = new Map() // TCP连接上的 ws → mux handle
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = chunks.length ? Buffer.concat(chunks) : null
      const ct = req.headers['content-type']
      const r = await client.httpCall(req.method ?? 'GET', req.url ?? '/', body, body ? (Array.isArray(ct) ? ct[0] : ct) : '')
      const headers = { ...r.headers }
      delete headers['content-encoding']
      delete headers['content-length']
      delete headers['transfer-encoding']
      res.writeHead(r.status, headers)
      res.end(r.body)
    } catch (e) {
      log('代理转发失败 ' + req.url + ': ' + e.message)
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('proxy error: ' + e.message)
    }
  })
  // 浏览器 → mux WS：文本帧双向透传到隧道 ws 流
  new WsLite(server, '/api/remote.mux', (ws) => {
    let mux = null
    ws.ontext = (text) => mux?.send(text)
    ws.onclose = () => mux?.close()
    mux = client.openMux(
      (text) => { if (ws.readyState === 1) ws.send(text) },
      (reason) => { log('mux 下行断开: ' + reason); if (ws.readyState === 1) ws.close(1000, 'relay closed') }
    )
    muxChans.set(ws, mux)
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      log('remote-link 本地代理: http://127.0.0.1:' + port + '/')
      resolve({ server, url: 'http://127.0.0.1:' + port + '/' })
    })
  })
}
