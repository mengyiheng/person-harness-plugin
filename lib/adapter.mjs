// Attach 会话适配（自 companion-v2/src/protocol-adapter.mjs 移植，2026-10-23）：
//   手机侧 open/data/close 协议 ↔ dsh。差异：进程内运行——
//   - dsh 地址取自 webServer.getOrigin()（实例发现问题不复存在）
//   - Cookie 进程内现铸：connection.publishPeer('answer') + browserAuth.secret 自签 v2 peer Cookie
//   - 401（peer 被 WS 断开吊销）→ 进程内重发 peer 秒级重试
import { E2EBox, genEphemeral, signE2E, verifyE2E, deriveKeys } from './e2e.mjs'
import { indexHtml } from './targets.mjs'

const HOP_BY_HOP = new Set(['host', 'cookie', 'authorization', 'content-length', 'connection', 'upgrade'])

function downgradeCode (code) {
  return (code >= 1005 && code <= 1006) ? 1000 : (code || 1000)
}

function b64u (buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

export class AttachSession {
  // deps: { getOrigin(), mintCookie(), identity, send(frame), log(...) }
  constructor (attached, deps) {
    this.attachId = attached.attachId
    this.peer = attached.peer // {deviceId, publicKey}
    this.deps = deps
    this.streams = new Map()
    this.e2e = null
    this._eph = null
    this._peerEph = null
    this._closed = false
  }

  sendFrame (frame) {
    const out = { ...frame, attachId: this.attachId }
    if (this.e2e && ['open', 'http-head', 'data', 'close', 'error'].includes(out.type)) {
      const plaintext = JSON.stringify({ rest: out })
      out.e2e = this.e2e.seal(out.streamId ?? '-', out.type, plaintext)
      for (const k of Object.keys(out)) {
        if (!['type', 'attachId', 'streamId', 'fin', 'e2e'].includes(k)) delete out[k]
      }
    }
    this.deps.send(out)
  }

  startE2EHandshake () {
    this._eph = genEphemeral()
    this.deps.log(`attach ${this.attachId}: e2e offer 发送（eph ${this._eph.publicKeyB64.length}B）`)
    this.sendFrame({ type: 'e2e', step: 'offer', ephemeral: this._eph.publicKeyB64 })
  }

  _transcriptVerify (sigB64, selfEphB64, peerEphB64) {
    return verifyE2E(this.peer.publicKey, sigB64, this.attachId, selfEphB64, peerEphB64)
  }

  async _onE2E (frame) {
    // 🔴 2026-10-23 E2E 卡点排查：三步握手每帧收发必打日志（attachId + ephemeral/signature 长度），
    //   真机握手环未闭环时据此判断"手机的 offer 是否到达插件"。
    this.deps.log(`attach ${this.attachId}: e2e ${frame.step ?? '?'} 收到` +
      `（eph=${(frame.ephemeral ?? '').length}B sig=${(frame.signature ?? '').length}B）`)
    if (frame.step === 'offer') {
      if (!frame.ephemeral) {
        // 手机在 eph.generate() 完成前收到我方 offer 时会回空 ephemeral（时序竞态特征）——
        // 明确记录，等待手机端修复（重连后重握手），不做半吊子应答
        this.deps.log(`attach ${this.attachId}: ⚠️ 手机 offer 带空 ephemeral（eph 未就绪竞态），忽略`)
        return
      }
      this._peerEph = frame.ephemeral
      const sig = signE2E(this.deps.identity.privateKey, this.attachId, this._eph.publicKeyB64, this._peerEph)
      this.deps.log(`attach ${this.attachId}: e2e accept 发送（对手机 offer 的响应）`)
      this.sendFrame({ type: 'e2e', step: 'accept', ephemeral: this._eph.publicKeyB64, signature: sig })
      return
    }
    if (frame.step === 'accept') {
      const peerEph = frame.ephemeral
      if (!peerEph) {
        this.deps.log(`attach ${this.attachId}: ⚠️ 手机 accept 带空 ephemeral（eph 未就绪竞态特征），丢弃`)
        return
      }
      const ok = this._transcriptVerify(frame.signature, peerEph, this._eph.publicKeyB64)
      if (!ok) { this.deps.log(`attach ${this.attachId} E2E 验签失败（accept）`); return }
      const keys = deriveKeys(this._eph.privateKey, peerEph, this.attachId, 'pc')
      this.e2e = new E2EBox(keys, this.attachId)
      const sig = signE2E(this.deps.identity.privateKey, this.attachId, this._eph.publicKeyB64, peerEph)
      this.deps.log(`attach ${this.attachId}: e2e confirm 发送`)
      this.sendFrame({ type: 'e2e', step: 'confirm', signature: sig })
      this.deps.log(`attach ${this.attachId}: E2E 就绪（对端 ${this.peer.deviceId}）`)
      return
    }
    if (frame.step === 'confirm') {
      const ok = this._transcriptVerify(frame.signature, this._peerEph, this._eph.publicKeyB64)
      if (!ok) this.deps.log(`attach ${this.attachId} E2E 验签失败（confirm）`)
      return
    }
  }

  async handle (frame) {
    if (this._closed) return
    if (frame.type === 'e2e') return this._onE2E(frame)
    if (!this.e2e || !frame.e2e) return
    const inner = JSON.parse(this.e2e.open(frame.streamId ?? '-', frame.type, frame.e2e))
    const msg = { type: frame.type, streamId: frame.streamId, fin: frame.fin, ...inner.rest }
    if (msg.type === 'open') return this._onOpen(msg)
    if (msg.type === 'data') return this._onData(msg)
    if (msg.type === 'close') return this._onClose(msg)
    if (msg.type === 'error') { this.deps.log(`attach ${this.attachId} 对端错误: ${msg.code}`); return }
  }

  async _onOpen (frame) {
    const { streamId, kind } = frame
    if (this.streams.has(streamId)) return this._error(streamId, 'dup-stream', '')
    if (kind === 'http') return this._httpOpenPending(frame)
    if (kind === 'ws') return this._openWs(frame)
    return this._error(streamId, 'bad-kind', kind)
  }

  _harnessHeaders (frame, extra = {}) {
    const h = {}
    for (const [k, v] of Object.entries(frame.headers || {})) if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v
    return { ...h, ...extra }
  }

  _httpOpenPending (frame) {
    const st = { kind: 'http', method: frame.method || 'GET', path: frame.path, headers: this._harnessHeaders(frame), chunks: [], fin: false }
    this.streams.set(frame.streamId, st)
  }

  /** 通用壳 P1：/t/ 路由命中时返回 null（放行走目标 fetch），否则直接应答并返回 true */
  async _routeTarget (st, streamId) {
    const t = this.deps.targets?.resolve?.(st.path)
    if (!t) return false
    if (t.kind === 'index') {
      await this._replyBuf(streamId, 200, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from(indexHtml(this.deps.targets.list()), 'utf8'))
      return true
    }
    if (t.kind === 'miss') {
      await this._replyBuf(streamId, 404, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from('<meta charset="utf-8">目标不存在（<a href="/t/">返回选择页</a>）'))
      return true
    }
    if (!t.target.originSpec) { // spawn-only（P2 未启用）
      await this._replyBuf(streamId, 503, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from('<meta charset="utf-8">该目标尚未启用（需 P2 ttyd 支持）'))
      return true
    }
    st.target = t.target
    st.path = t.rest
    return false
  }

  /** 分块应答（24KB + 8ms 节流，同 _httpFlush 口径） */
  async _replyBuf (streamId, status, headers, buf) {
    this.sendFrame({ type: 'http-head', streamId, status, headers })
    const MAX = 24 * 1024
    if (!buf.length) {
      this.sendFrame({ type: 'data', streamId, data: '', fin: true })
    } else {
      for (let off = 0; off < buf.length; off += MAX) {
        const fin = off + MAX >= buf.length
        this.sendFrame({ type: 'data', streamId, data: buf.subarray(off, off + MAX).toString('base64'), fin })
        if (!fin) await new Promise((r) => setTimeout(r, 8))
      }
    }
    this.sendFrame({ type: 'close', streamId, code: 1000 })
    this.streams.delete(streamId)
  }

  async _httpFlush (streamId) {
    const st = this.streams.get(streamId)
    if (!st || st.sent) return
    st.sent = true
    try {
      // /__happy/* 内部路径：不进 dsh，由插件进程处理（V4 远程登录授权等）
      if (st.path && st.path.startsWith('/__happy/')) {
        const body = st.chunks.length ? Buffer.concat(st.chunks) : Buffer.alloc(0)
        const r = await this.deps.onInternalRequest?.(st.path, st.method || 'GET', body)
        const status = r?.status ?? 404
        const payload = Buffer.from(JSON.stringify(r?.body ?? { error: 'not found' }), 'utf8')
        this.sendFrame({ type: 'http-head', streamId, status, headers: { 'content-type': 'application/json' } })
        // 🔴 大响应必须分块（24KB + 8ms 节流）：单帧大 base64 会触发 ArkWS 接收丢帧（2026-10-23 教训）
        for (let off = 0; off < payload.length; off += 24 * 1024) {
          const fin = off + 24 * 1024 >= payload.length
          this.sendFrame({ type: 'data', streamId, data: payload.slice(off, off + 24 * 1024).toString('base64'), fin })
          if (!fin) await new Promise((r2) => setTimeout(r2, 8))
        }
        this.sendFrame({ type: 'close', streamId, code: 1000 })
        this.streams.delete(streamId)
        return
      }
      // 通用壳 P1：/t/<name>/ 路由（未命中返回 false，st.path 已重写为目标内路径）
      if (st.path.startsWith('/t') && await this._routeTarget(st, streamId)) return
      const target = st.target
      const origin = target ? this.deps.targets.originOf(target) : this.deps.getOrigin()
      const doFetch = async () => {
        const authHeaders = target ? await this.deps.targets.authHeadersOf(target) : { Cookie: await this.deps.mintCookie() }
        return fetch(origin + st.path, {
          method: st.method,
          headers: { ...st.headers, ...authHeaders },
          body: st.chunks.length ? Buffer.concat(st.chunks) : undefined
        })
      }
      let res = await doFetch()
      if (!target && (res.status === 401 || res.status === 403)) {
        // peer 被 dsh 吊销（mux WS 断开即吊销）→ 进程内重发 peer 重试
        this.deps.log(`attach ${this.attachId} HTTP ${res.status}（peer 吊销）→ 重铸重试`)
        res = await doFetch()
      }
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      delete headers['content-encoding'] // fetch 已自动解压，保留该头会让 WebView 解码失败
      delete headers['content-length']
      this.sendFrame({ type: 'http-head', streamId, status: res.status, headers })
      const buf = Buffer.from(await res.arrayBuffer())
      const MAX = 24 * 1024 // 手机 ArkWS 队列对连续大帧敏感（burst 丢帧实测），24KB+节流为实证安全区
      if (buf.length === 0) {
        this.sendFrame({ type: 'data', streamId, data: '', fin: true })
      } else {
        for (let off = 0; off < buf.length; off += MAX) {
          this.sendFrame({ type: 'data', streamId, data: buf.subarray(off, off + MAX).toString('base64'), fin: off + MAX >= buf.length })
          await new Promise((r) => setTimeout(r, 8)) // 节流防 burst
        }
      }
      this.sendFrame({ type: 'close', streamId, code: 1000 })
      this.streams.delete(streamId)
    } catch (e) {
      this._error(streamId, 'connect-failed', e.message)
    }
  }

  async _openWs (frame) {
    const { streamId } = frame
    const st = { kind: 'ws' }
    this.streams.set(streamId, st)
    // 通用壳 P1：/t/<name>/ 路由（选择页对 WS 无意义，404）
    const t = this.deps.targets?.resolve?.(frame.path)
    let origin
    let authHeaders = {}
    if (t && t.kind === 'target' && t.target.originSpec) {
      origin = this.deps.targets.originOf(t.target).replace(/^http/, 'ws')
      authHeaders = await this.deps.targets.authHeadersOf(t.target)
    } else if (t) {
      this._error(streamId, 'bad-target', t.kind === 'index' ? 'WS 无目标选择页' : '目标不存在或未启用')
      return
    } else {
      origin = this.deps.getOrigin().replace(/^http/, 'ws')
      authHeaders = { Cookie: await this.deps.mintCookie() }
    }
    // 🔴 修复白屏：此前简写 { Cookie }（大小写笔误）→ ReferenceError: Cookie is not defined
    //    → WebView GUI 的 /api/remote.mux 建不起来 → 首页加载后白屏
    const ws = new WebSocket(origin + (t ? t.rest : frame.path), { headers: { ...authHeaders } })
    st.ws = ws
    ws.onopen = () => this.sendFrame({ type: 'http-head', streamId, status: 101 })
    ws.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
      this.sendFrame({ type: 'data', streamId, data: Buffer.from(text, 'utf8').toString('base64'), fin: true })
    }
    ws.onclose = (ev) => {
      this.streams.delete(streamId)
      this.sendFrame({ type: 'close', streamId, code: downgradeCode(ev.code), reason: String(ev.reason || '').slice(0, 200) })
    }
    ws.onerror = () => this._error(streamId, 'connect-failed', 'harness ws error')
  }

  async _onData (frame) {
    const st = this.streams.get(frame.streamId)
    if (!st) return this._error(frame.streamId, 'unknown-stream', '')
    if (st.kind === 'ws') {
      if (st.ws && st.ws.readyState === 1 && frame.data) {
        st.ws.send(Buffer.from(frame.data, 'base64').toString('utf8'))
      }
      return
    }
    if (frame.data) st.chunks.push(Buffer.from(frame.data, 'base64'))
    if (frame.fin) return this._httpFlush(frame.streamId)
  }

  async _onClose (frame) {
    const st = this.streams.get(frame.streamId)
    if (!st) return
    if (st.kind === 'ws' && st.ws && st.ws.readyState === 1) st.ws.close()
    this.streams.delete(frame.streamId)
  }

  detach () {
    if (this._closed) return
    this._closed = true
    for (const [, st] of this.streams) {
      if (st.kind === 'ws' && st.ws && st.ws.readyState === 1) st.ws.close(1000, 'detached')
    }
    this.streams.clear()
    this.e2e = null
  }

  _error (streamId, code, message) {
    if (!this._closed) this.sendFrame({ type: 'error', streamId, code, message })
    this.streams.delete(streamId)
  }
}
