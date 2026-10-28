// Attach 会话适配（自 companion-v2/src/protocol-adapter.mjs 移植，2026-10-23）：
//   手机侧 open/data/close 协议 ↔ dsh。差异：进程内运行——
//   - dsh 地址取自 webServer.getOrigin()（实例发现问题不复存在）
//   - Cookie 进程内现铸：connection.publishPeer('answer') + browserAuth.secret 自签 v2 peer Cookie
//   - 401（peer 被 WS 断开吊销）→ 进程内重发 peer 秒级重试
import { E2EBox, genEphemeral, signE2E, verifyE2E, deriveKeys } from './e2e.mjs'
import { indexHtml } from './targets.mjs'
import { usesDshShell, localShellRpc, normalizeBridgeRpc, normalizeBridgeMux, projectionValues } from './dsh-shell.mjs'

const HOP_BY_HOP = new Set(['host', 'cookie', 'authorization', 'content-length', 'connection', 'upgrade'])
const EXTERNAL_APPROVAL_TTL = 120_000

function normalizeCwd (value) {
  return String(value || '').replaceAll('/', '\\').replace(/\\+$/g, '').toLowerCase()
}

function rpcRequest (body) {
  try {
    const parsed = JSON.parse(Buffer.from(body || '').toString('utf8') || '{}')
    return { parsed, request: parsed.payload?.args?.request || {} }
  } catch {
    return { parsed: {}, request: {} }
  }
}

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
    this.throttleKbps = Number(attached.tierKbps) || 0 // V7：云端按手机档位下发的文件传输限速（0=不限）
    this.deps = deps
    this.streams = new Map()
    this.e2e = null
    this._eph = null
    this._peerEph = null
    this._closed = false
    // 外部 Agent 的会话/工作区归属与审批必须跨 HTTP、WS 流共享。
    this.bridgeSessions = new Map()
    this.bridgeWorkspaces = new Map()
    this.approvals = new Map()
    this.approvalSeq = 0
  }

  _rememberBridgeRpc (target, path, requestBody, responseBuffer) {
    if (target?.shell !== 'dsh') return
    let msg
    try { msg = JSON.parse(Buffer.from(responseBuffer).toString('utf8')) } catch { return }
    if (!msg?.result?.ok) return
    const value = msg.result.value
    let changed = false
    if (path === '/api/session/list' && Array.isArray(value?.items)) {
      const items = new Map()
      for (const item of value.items) {
        if (item?.sessionId) items.set(String(item.sessionId), { ...item, sessionId: String(item.sessionId) })
      }
      this.bridgeSessions.set(target.name, items)
      changed = true
    } else if (path === '/api/session/create' && value?.sessionId) {
      const { request } = rpcRequest(requestBody)
      const cwd = request.cwd || this.bridgeWorkspaces.get(target.name)?.get(request.workspaceId)
      const items = this.bridgeSessions.get(target.name) || new Map()
      items.set(String(value.sessionId), {
        sessionId: String(value.sessionId), title: '新对话', cwd, blank: true,
        createdAt: Date.now(), updatedAt: Date.now(), running: false, agentAvailable: true
      })
      this.bridgeSessions.set(target.name, items)
      changed = true
    }
    if (changed) {
      this._refreshWorkspaces(target)
      this._syncExternalProjections(target)
    }
  }

  _bridgeProjectionBlock (item) {
    return {
      asOfSeq: Number.isSafeInteger(item.projections?.asOfSeq) ? item.projections.asOfSeq : 0,
      values: item.projections?.values || projectionValues({
        title: item.title, cwd: item.cwd, blank: item.blank, updatedAt: item.updatedAt
      })
    }
  }

  /** dsh 历史树订阅 session/control；外部 Agent 的标题与空会话状态也必须进入这条流。 */
  _syncExternalProjections (target, onlySessionId = null) {
    const sessions = this.bridgeSessions.get(target.name)
    if (!sessions) return
    for (const st of this.streams.values()) {
      if (st.kind !== 'ws' || st.closed || st.target?.name !== target.name || !st.controlStreamId || !st.controlSent) continue
      for (const [sessionId, item] of sessions) {
        if (onlySessionId && sessionId !== onlySessionId) continue
        const block = this._bridgeProjectionBlock(item)
        let sent = st.controlSent.get(sessionId)
        if (!sent) { sent = {}; st.controlSent.set(sessionId, sent) }
        for (const [key, value] of Object.entries(block.values)) {
          const serialized = JSON.stringify(value)
          if (sent[key] === serialized) continue
          this._sendWsJson(st, { type: 'item', streamId: st.controlStreamId, value: {
            type: 'projection', sessionId, key, value, seq: block.asOfSeq
          } })
          sent[key] = serialized
        }
      }
    }
  }

  _updateBridgeProjection (st, sessionId, values, seq) {
    if (!sessionId || !values || !Number.isSafeInteger(seq)) return
    const sessions = this.bridgeSessions.get(st.target.name) || new Map()
    const previous = sessions.get(sessionId) || { sessionId, title: '新对话', blank: true, updatedAt: Date.now() }
    const old = this._bridgeProjectionBlock(previous)
    const merged = { ...old.values, ...values }
    const item = {
      ...previous, sessionId,
      projections: { kind: 'sequenced', asOfSeq: seq, values: merged }
    }
    if (typeof values.title === 'string' && values.title) item.title = values.title
    const metadata = values.sessionListMetadata
    if (metadata) {
      item.blank = !!metadata.blank
      if (Number.isFinite(metadata.lastPromptAt)) item.updatedAt = metadata.lastPromptAt
    }
    if (typeof values.workingDirectory === 'string') item.cwd = values.workingDirectory
    sessions.set(sessionId, item)
    this.bridgeSessions.set(st.target.name, sessions)
    this._syncExternalProjections(st.target, sessionId)
  }

  _captureBridgeProjections (st, text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    const sessionId = st.muxSessions.get(msg.streamId)
    const frame = msg?.value
    if (frame?.type === 'snapshot' && frame.projections) {
      this._updateBridgeProjection(st, sessionId, frame.projections.values, frame.projections.asOfSeq)
    } else if (frame?.type === 'event' && frame.event?.type === 'session/title') {
      this._updateBridgeProjection(st, sessionId, { title: frame.event.data?.title || null }, frame.event.seq)
    } else if (frame?.type === 'event' && frame.event?.type === 'user/message') {
      this._updateBridgeProjection(st, sessionId, {
        sessionListMetadata: { blank: false, lastPromptAt: frame.event.time }
      }, frame.event.seq)
    }
  }

  _mergeControlMux (st, text) {
    let msg
    try { msg = JSON.parse(text) } catch { return text }
    const frame = msg?.value
    if (msg.streamId !== st.controlStreamId || frame?.type !== 'baseline') return text
    frame.value = frame.value && typeof frame.value === 'object' ? frame.value : {}
    frame.value.projections = frame.value.projections && typeof frame.value.projections === 'object' ? frame.value.projections : {}
    st.controlSent = new Map()
    for (const [sessionId, item] of this.bridgeSessions.get(st.target.name) || []) {
      const block = this._bridgeProjectionBlock(item)
      frame.value.projections[sessionId] = { asOfSeq: block.asOfSeq, values: block.values }
      st.controlSent.set(sessionId, Object.fromEntries(Object.entries(block.values).map(([key, value]) => [key, JSON.stringify(value)])))
    }
    return JSON.stringify(msg)
  }

  _mergeWorkspaceMux (st, text) {
    if (st.target?.shell !== 'dsh') return text
    let msg
    try { msg = JSON.parse(text) } catch { return text }
    const frame = msg?.value
    const views = st.workspaceViews || (st.workspaceViews = new Map())
    if (frame?.type === 'remove') {
      views.delete(frame.workspaceId)
      return text
    }
    const workspaces = frame?.type === 'baseline' || frame?.type === 'replace'
      ? frame.value?.items
      : frame?.type === 'upsert' ? [frame.workspace] : null
    if (!Array.isArray(workspaces)) return text
    st.workspaceStreamId = msg.streamId
    if (frame.type === 'baseline' || frame.type === 'replace') views.clear()
    const paths = this.bridgeWorkspaces.get(st.target.name) || new Map()
    const sessions = this.bridgeSessions.get(st.target.name) || new Map()
    for (const workspace of workspaces) {
      if (!workspace || typeof workspace !== 'object') continue
      if (workspace.workspaceId && workspace.path) paths.set(workspace.workspaceId, workspace.path)
      const own = new Set(sessions.keys())
      const ids = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).filter((id) => !own.has(String(id)))
      for (const [sessionId, session] of sessions) {
        if (normalizeCwd(session.cwd) && normalizeCwd(session.cwd) === normalizeCwd(workspace.path)) ids.push(sessionId)
      }
      workspace.sessionIds = ids
      if (workspace.workspaceId) views.set(workspace.workspaceId, workspace)
    }
    this.bridgeWorkspaces.set(st.target.name, paths)
    return JSON.stringify(msg)
  }

  _refreshWorkspaces (target) {
    for (const st of this.streams.values()) {
      if (st.kind !== 'ws' || st.closed || st.target?.name !== target.name || !st.workspaceStreamId || !st.workspaceViews) continue
      for (const workspace of [...st.workspaceViews.values()]) {
        const before = JSON.stringify(workspace.sessionIds || [])
        const text = this._mergeWorkspaceMux(st, JSON.stringify({ type: 'item', streamId: st.workspaceStreamId, value: { type: 'upsert', workspace } }))
        const projected = JSON.parse(text).value.workspace
        if (JSON.stringify(projected.sessionIds || []) === before) continue
        this.sendFrame({ type: 'data', streamId: st.outerStreamId, data: Buffer.from(text, 'utf8').toString('base64'), fin: true })
      }
    }
  }

  _captureApproval (st, text) {
    let msg
    try { msg = JSON.parse(text) } catch { return null }
    const event = msg?.value?.type === 'event' ? msg.value.event : null
    if (event?.type !== 'approval/request') return null
    const sessionId = st.muxSessions.get(msg.streamId)
    const data = event.data || {}
    const reqId = String(data.reqId || data.id || '')
    if (!sessionId || !reqId) return null
    const eventId = `ph-approval:${this.attachId}:${++this.approvalSeq}:${reqId}`
    const entry = {
      eventId, owner: st, target: st.target, sessionId, reqId,
      options: Array.isArray(data.options) ? data.options : [], clientId: null, timer: null
    }
    entry.timer = setTimeout(() => {
      if (this.approvals.get(eventId) !== entry) return
      this.approvals.delete(eventId)
      if (entry.clientId && !st.closed) this._sendWsJson(st, { type: 'item', streamId: st.eventStreamId, value: { type: 'cancel', eventId } })
    }, EXTERNAL_APPROVAL_TTL)
    entry.timer.unref?.()
    this.approvals.set(eventId, entry)
    return {
      entry,
      frame: {
        type: 'item', streamId: null,
        value: {
          type: 'waterfall', event: 'approval/request', eventId, agentId: sessionId,
          request: {
            toolName: data.toolName || data.permission || 'Agent 操作',
            reason: data.reason || data.command || 'Agent 请求执行一项操作',
            ...(data.callId ? { callId: data.callId } : {})
          }
        }
      }
    }
  }

  _queueApproval (st, pending) {
    if (!pending) return
    if (!st.eventsReady || !st.eventStreamId) {
      st.pendingApprovals.push(pending)
      return
    }
    pending.entry.clientId = st.eventClientId
    pending.frame.streamId = st.eventStreamId
    this._sendWsJson(st, pending.frame)
  }

  _flushApprovals (st) {
    if (!st.eventsReady || !st.eventStreamId) return
    const queued = st.pendingApprovals.splice(0)
    for (const pending of queued) {
      if (this.approvals.get(pending.entry.eventId) === pending.entry) this._queueApproval(st, pending)
    }
  }

  _routeApprovalResult (target, body) {
    if (target?.shell !== 'dsh') return null
    let parsed
    try { parsed = JSON.parse(Buffer.from(body).toString('utf8')) } catch { return null }
    const args = parsed?.payload?.args
    const entry = this.approvals.get(args?.eventId)
    if (!entry || entry.target.name !== target.name) return null
    if (args.clientId !== entry.clientId) return { error: '审批事件不属于当前连接，请刷新后重试' }
    const value = args.outcome?.kind === 'result' ? args.outcome.value : null
    if (value !== 'allowed-once' && value !== 'rejected') return { error: '不支持的审批结果' }
    const allow = value === 'allowed-once'
    const kinds = allow ? ['allow_once'] : ['reject_once', 'reject']
    const option = entry.options.find((item) => kinds.includes(item?.kind)) ||
      entry.options.find((item) => String(item?.optionId) === (allow ? 'once' : 'reject'))
    const optionId = String(option?.optionId || (allow ? 'once' : 'reject'))
    parsed.payload.args = { request: { sessionId: entry.sessionId, reqId: entry.reqId, optionId, response: optionId } }
    return { entry, body: Buffer.from(JSON.stringify(parsed), 'utf8') }
  }

  _completeApproval (entry, buffer) {
    if (!entry) return
    try {
      const msg = JSON.parse(Buffer.from(buffer).toString('utf8'))
      if (!msg?.result?.ok) return
    } catch { return }
    clearTimeout(entry.timer)
    this.approvals.delete(entry.eventId)
  }

  _dropApprovals (st) {
    for (const [eventId, entry] of this.approvals) {
      if (entry.owner !== st) continue
      clearTimeout(entry.timer)
      this.approvals.delete(eventId)
    }
  }

  _sendWsJson (st, value) {
    this.sendFrame({ type: 'data', streamId: st.outerStreamId, data: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'), fin: true })
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
    // 🔴 2026-10-27 二次修正：只串行"解密 + 分发注册"——open/data 乱序竞态出在这里（async 解密并行完成顺序不定）。
    //    异步 handler（_httpFlush 含 SSE/长连接，永不返回）必须 fire-and-forget：
    //    若把整个 handle 串进链，一条长流会卡死整条链 → 隧道假死（鸿蒙 45 秒聋定罪，勿回退）。
    this._decChain = (this._decChain || Promise.resolve()).then(async () => {
      let inner
      try {
        inner = JSON.parse(this.e2e.open(frame.streamId ?? '-', frame.type, frame.e2e))
      } catch (e) {
        this.deps.log?.(`[ph-dec] 解密失败 type=${frame.type} sid=${frame.streamId}: ${e.message}`)
        return
      }
      const msg = { type: frame.type, streamId: frame.streamId, fin: frame.fin, ...inner.rest }
      if (msg.type === 'open') {
        // http：同步注册（链内，保序）；ws：_openWs 含耗时 await（mintCookie/拉起目标），必须链外
        if (msg.kind === 'ws') {
          if (this.streams.has(msg.streamId)) return this._error(msg.streamId, 'dup-stream', '')
          this._openWs(msg).catch((e) => this._error(msg.streamId, 'ws-open-failed', e.message))
          return
        }
        return this._onOpen(msg)
      }
      if (msg.type === 'data') {
        const st = this.streams.get(msg.streamId)
        if (!st) return this._error(msg.streamId, 'unknown-stream', '')
        if (st.kind === 'ws') {
          this._forwardWs(st, msg.streamId, msg.data)
          return
        }
        if (msg.data) st.chunks.push(Buffer.from(msg.data, 'base64'))
        if (msg.fin) this._httpFlush(msg.streamId).catch((e) => this._error(msg.streamId, 'handler-failed', e.message))
        return
      }
      if (msg.type === 'close') return this._onClose(msg)
      if (msg.type === 'error') { this.deps.log(`attach ${this.attachId} 对端错误: ${msg.code}`); return }
    }).catch(() => {})
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
    const st = { kind: 'http', method: frame.method || 'GET', path: frame.path, headers: this._harnessHeaders(frame), chunks: [], fin: false, at: Date.now() }
    this.streams.set(frame.streamId, st)
  }

  /** 通用壳 P1：/t/ 路由命中时返回 null（放行走目标 fetch），否则直接应答并返回 true */
  async _routeTarget (st, streamId) {
    const t = this.deps.targets?.resolve?.(st.path)
    if (!t) {
      // P2.5 Referer 回源（2026-10-24）：SPA 的子资源/WS 是根绝对路径（/assets、/ws），
      // 不带 /t/ 前缀 → 按 Referer 里的来源 target 回源。dsh 自身请求 Referer 不含 /t/，不受影响。
      const ref = String(st.headers?.referer || st.headers?.Referer || '')
      const m = /\/t\/([a-z0-9-]{1,32})\//.exec(ref)
      if (m) {
        const rt = this.deps.targets?.resolve?.(`/t/${m[1]}/`)
        if (rt && rt.kind === 'target') {
          if (!rt.target.originSpec) {
            const r = await this.deps.targets.ensure?.(rt.target)
            if (r && r.ok) { st.target = rt.target; return false }
          } else { st.target = rt.target; return false }
        }
      }
      return false
    }
    if (t.kind === 'index') {
      // P2-lite：后台预热 spawn 目标（不阻塞选择页渲染，卡片状态下次刷新即亮）
      this.deps.targets.ensureAll?.().catch(() => {})
      await this._replyBuf(streamId, 200, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from(indexHtml(this.deps.targets.list()), 'utf8'))
      return true
    }
    if (t.kind === 'miss') {
      await this._replyBuf(streamId, 404, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from('<meta charset="utf-8">目标不存在（<a href="/t/">返回选择页</a>）'))
      return true
    }
    if (!t.target.originSpec) { // P2-lite：spawn 托管目标——按需拉起 + 探活
      const r = await this.deps.targets.ensure?.(t.target)
      if (!r || !r.ok) {
        await this._replyBuf(streamId, 503, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from(`<meta charset="utf-8">目标启动失败：${(r && r.err) || '未知原因'}（<a href="/t/">返回选择页</a>）`))
        return true
      }
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
      // /__ph/* 内部路径：不进 dsh，由插件进程处理（V4 远程登录授权等）
      if (st.path && st.path.startsWith('/__ph/')) {
        const body = st.chunks.length ? Buffer.concat(st.chunks) : Buffer.alloc(0)
        const r = await this.deps.onInternalRequest?.(st.path, st.method || 'GET', body, { attachId: this.attachId, throttleKbps: this.throttleKbps })
        const status = r?.status ?? 404
        // 调试观测（2026-10-26 app 不可用排查）：工具端点每请求一行
        this.deps.log?.(`[ph-req] ${st.method} ${st.path} → ${status} ${Date.now() - (st.at || Date.now())}ms`)
        const headers = { 'content-type': 'application/json', ...(r?.headers || {}) }
        const payload = Buffer.isBuffer(r?.body)
          ? r.body
          : (typeof r?.body === 'string' && !String(headers['content-type']).includes('application/json'))
              ? Buffer.from(r.body, 'utf8')
              : Buffer.from(JSON.stringify(r?.body ?? { error: 'not found' }), 'utf8')
        this.sendFrame({ type: 'http-head', streamId, status, headers })
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
      // 所有 HTTP 请求都先过目标路由：/t/<name>/ 直接命中；SPA 的 /api、/assets 等
      // 根绝对路径则由 _routeTarget 按 Referer 回源。此前仅在 /t 前缀下调用，Referer 回源实际不生效。
      if (await this._routeTarget(st, streamId)) return
      const target = st.target
      const rpcPath = st.path
      let body = st.chunks.length ? Buffer.concat(st.chunks) : Buffer.alloc(0)
      let shell = usesDshShell(target, st.path)
      let origin = target && !shell ? this.deps.targets.originOf(target) : this.deps.getOrigin()
      let approvalEntry = null
      if (target?.shell === 'dsh' && st.path === '/api/$events/result') {
        const approval = this._routeApprovalResult(target, body)
        if (approval?.error) {
          const { parsed } = rpcRequest(body)
          const failure = { type: 'server-response', rpcId: parsed.rpcId, result: { ok: false, error: { code: 'approval-error', message: approval.error } } }
          await this._replyBuf(streamId, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(failure), 'utf8'))
          return
        }
        if (approval) {
          approvalEntry = approval.entry
          body = approval.body
          st.path = '/api/session/approve'
          shell = false
          origin = this.deps.targets.originOf(target)
        }
      }
      const local = localShellRpc(target, st.path, body)
      if (local) {
        await this._replyBuf(streamId, 200, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify(local), 'utf8'))
        return
      }
      // 会话写操作立即使短缓存失效；进行中的旧列表也不能被之后的调用者加入。
      if (!target && st.method !== 'GET' && st.path.startsWith('/api/session/') && st.path !== '/api/session/list') {
        this.deps.sessionListCache?.invalidate()
      }
      const doFetch = async () => {
        const authHeaders = target && !shell ? await this.deps.targets.authHeadersOf(target) : { Cookie: await this.deps.mintCookie() }
        return fetch(origin + st.path, {
          method: st.method,
          headers: { ...st.headers, ...authHeaders },
          body: body.length ? body : undefined
        })
      }
      const sharedList = !target && st.method === 'POST' && st.path === '/api/session/list' && this.deps.sessionListCache
      let res = sharedList
        ? await this.deps.sessionListCache.fetch({ origin, path: st.path, method: st.method, body }, doFetch)
        : await doFetch()
      if ((!target || shell) && (res.status === 401 || res.status === 403)) {
        // peer 被 dsh 吊销（mux WS 断开即吊销）→ 进程内重发 peer 重试
        this.deps.log(`attach ${this.attachId} HTTP ${res.status}（peer 吊销）→ 重铸重试`)
        res = await doFetch()
      }
      // 调试观测（2026-10-26 中转红灯排查）：每流一行，量小
      this.deps.log?.(`[http] ${st.method} ${st.path} → ${res.status} ${Date.now() - (st.at || Date.now())}ms`)
      const headers = {}
      res.headers.forEach((v, k) => { headers[k] = v })
      delete headers['content-encoding'] // fetch 已自动解压，保留该头会让 WebView 解码失败
      delete headers['content-length']
      // 静态资源带内容哈希（index-XXXX.js），可安全长缓存——WebView 每次全量重拉 2MB+ 会把
      // 手机中继链路堵死（2026-10-26 白页事故：GUI 首屏永远等不到资源）。只覆盖 /assets/，不动 API。
      if (st.path && st.path.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable'
      this.sendFrame({ type: 'http-head', streamId, status: res.status, headers })
      // 🔴 SSE 流式透传（2026-10-24，opencode target）：text/event-stream 是永不结束的
      //    长连接——arrayBuffer() 会永久挂住。改逐 chunk 转发，手机端 LocalProxy 已配套 chunked 流式。
      if (String(headers['content-type'] || '').includes('text/event-stream')) {
        try {
          for await (const chunk of res.body) {
            const c = Buffer.from(chunk)
            const MAX = 24 * 1024
            for (let off = 0; off < c.length; off += MAX) {
              this.sendFrame({ type: 'data', streamId, data: c.subarray(off, off + MAX).toString('base64'), fin: off + MAX >= c.length })
              await new Promise((r) => setTimeout(r, 8))
            }
          }
        } catch (e) {
          this.deps.log?.(`SSE 流中断 streamId=${streamId}: ${e.message}`)
        }
        this.sendFrame({ type: 'close', streamId, code: 1000 })
        this.streams.delete(streamId)
        return
      }
      const raw = Buffer.from(await res.arrayBuffer())
      this._completeApproval(approvalEntry, raw)
      if (!approvalEntry) this._rememberBridgeRpc(target, rpcPath, body, raw)
      const buf = target && !shell ? normalizeBridgeRpc(st.path, raw) : raw
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
    const st = { kind: 'ws', path: frame.path, outerStreamId: streamId }
    this.streams.set(streamId, st)
    // 通用壳 P1：/t/<name>/ 路由（选择页对 WS 无意义，404）
    let t = this.deps.targets?.resolve?.(frame.path)
    if (!t) {
      // P2.5 Referer 回源：target 页面发起的 WS 是根绝对路径（如 /ws）→ 按 Referer 来源路由
      const ref = String(frame.headers?.referer || frame.headers?.Referer || '')
      const m = /\/t\/([a-z0-9-]{1,32})\//.exec(ref)
      if (m) {
        const rt = this.deps.targets?.resolve?.(`/t/${m[1]}/`)
        if (rt && rt.kind === 'target') { t = { kind: 'target', target: rt.target, rest: frame.path } }
      }
    }
    st.target = t?.target || null
    let origin
    let authHeaders = {}
    if (t && t.kind === 'target' && (t.target.originSpec || t.target.spawn)) {
      if (t.target.spawn && !t.target.originSpec) { // P2-lite：WS 也可能先于 HTTP 到达 → 按需拉起
        const r = await this.deps.targets.ensure?.(t.target)
        if (!r || !r.ok) { this._error(streamId, 'target-not-ready', '目标启动失败：' + ((r && r.err) || '未知')); return }
      }
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
    const shellDsh = st.target?.shell === 'dsh'
    st.openedRoutes = new Set()
    if (shellDsh) {
      st.muxRoutes = new Map()
      st.muxSessions = new Map()
      st.muxState = { nextSeq: 1, assistantSeqs: new Map() }
      st.pending = { target: [], dsh: [] }
      st.pendingApprovals = []
      st.eventsReady = false
    }
    const connect = (route, upstream, headers) => {
      this.deps.log?.(`[ws] open sid=${streamId} route=${route} target=${st.target?.name || 'dsh'} upstream=${upstream}`)
      const ws = new WebSocket(upstream, { headers: { ...headers } })
      if (route === 'target') st.ws = ws
      else st.dshWs = ws
      ws.onopen = () => {
        st.openedRoutes.add(route)
        this.deps.log?.(`[ws] opened sid=${streamId} route=${route}`)
        if (route === 'target') this.sendFrame({ type: 'http-head', streamId, status: 101 })
        const queued = st.pending?.[route] || []
        if (st.pending) st.pending[route] = []
        for (const text of queued) ws.send(text)
      }
      ws.onmessage = (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')
        let normalized = text
        let approval = null
        if (shellDsh && route === 'target') {
          approval = this._captureApproval(st, text)
          normalized = normalizeBridgeMux(text, st.muxState)
          this._captureBridgeProjections(st, normalized)
        } else if (shellDsh) {
          normalized = this._mergeControlMux(st, text)
          normalized = this._mergeWorkspaceMux(st, normalized)
          try {
            const msg = JSON.parse(text)
            if (msg.streamId === st.eventStreamId && msg.value?.type === 'ready') {
              st.eventClientId = msg.value.clientId
              st.eventsReady = true
            }
          } catch { }
        }
        this.sendFrame({ type: 'data', streamId, data: Buffer.from(normalized, 'utf8').toString('base64'), fin: true })
        if (route === 'target') this._queueApproval(st, approval)
        else this._flushApprovals(st)
      }
      ws.onclose = (ev) => {
        if (st.closed) return
        st.closed = true
        this._dropApprovals(st)
        this.deps.log?.(`[ws] close sid=${streamId} route=${route} code=${ev.code} reason=${String(ev.reason || '').slice(0, 120)}`)
        const other = route === 'target' ? st.dshWs : st.ws
        if (other && other.readyState <= 1) other.close(1000, 'sibling closed')
        this.streams.delete(streamId)
        this.sendFrame({ type: 'close', streamId, code: downgradeCode(ev.code), reason: String(ev.reason || '').slice(0, 200) })
      }
      ws.onerror = (ev) => {
        this.deps.log?.(`[ws] error sid=${streamId} route=${route} opened=${st.openedRoutes.has(route)} closed=${!!st.closed} msg=${ev?.message || ev?.error?.message || 'unknown'}`)
        if (!st.closed && route === 'target' && st.openedRoutes.size === 0) {
          st.closed = true
          this._error(streamId, 'connect-failed', 'harness ws error')
        }
      }
    }
    connect('target', origin + (t ? t.rest : frame.path), authHeaders)
    if (shellDsh) {
      // dsh Web 把 session/follow 与 workspace/follow、account/watch、$events 等复用在同一 mux。
      // 只有会话通道属于外部 Agent；其余必须仍由 dsh 本体处理。首个非会话消息到达时再建连。
      const dshUrl = this.deps.getOrigin().replace(/^http/, 'ws') + frame.path.replace(/^\/t\/[^/]+/, '')
      const dshHeaders = { Cookie: await this.deps.mintCookie() }
      st.openDsh = () => { if (!st.dshWs) connect('dsh', dshUrl, dshHeaders) }
    }
  }

  _forwardWs (st, streamId, data) {
    if (!data) return
    const text = Buffer.from(data, 'base64').toString('utf8')
    if (st.target?.shell !== 'dsh') {
      if (st.ws?.readyState === 1) st.ws.send(text)
      return
    }
    let msg = null
    try { msg = JSON.parse(text) } catch { /* 非 mux 消息按目标会话通道处理 */ }
    const innerId = msg?.streamId || streamId
    let route = st.muxRoutes.get(innerId) || 'target'
    if (msg?.type === 'open') {
      route = msg.endpoint === 'session/follow' ? 'target' : 'dsh'
      st.muxRoutes.set(innerId, route)
      if (msg.endpoint === 'session/follow') {
        const sessionId = msg.payload?.args?.request?.address?.sessionId
        if (sessionId) st.muxSessions.set(innerId, String(sessionId))
      } else if (msg.endpoint === '$events') {
        st.eventStreamId = innerId
        st.eventsReady = false
        st.eventClientId = null
      } else if (msg.endpoint === 'session/control') {
        st.controlStreamId = innerId
        st.controlSent = null
      }
      this.deps.log?.(`[ws] route outer=${streamId} inner=${innerId} endpoint=${msg.endpoint || '-'} → ${route}`)
    }
    if (route === 'dsh') st.openDsh?.()
    const ws = route === 'dsh' ? st.dshWs : st.ws
    if (ws?.readyState === 1) ws.send(text)
    else if (ws?.readyState === 0) st.pending[route].push(text)
    else this.deps.log?.(`[ws] drop outer=${streamId} route=${route}：上游未连接`)
    if (msg?.type === 'close') {
      st.muxRoutes.delete(innerId)
      st.muxSessions.delete(innerId)
      if (st.eventStreamId === innerId) {
        st.eventStreamId = null
        st.eventsReady = false
        st.eventClientId = null
      }
      if (st.controlStreamId === innerId) {
        st.controlStreamId = null
        st.controlSent = null
      }
    }
  }

  async _onData (frame) {
    const st = this.streams.get(frame.streamId)
    if (!st) return this._error(frame.streamId, 'unknown-stream', '')
    if (st.kind === 'ws') {
      this._forwardWs(st, frame.streamId, frame.data)
      return
    }
    if (frame.data) st.chunks.push(Buffer.from(frame.data, 'base64'))
    if (frame.fin) return this._httpFlush(frame.streamId)
  }

  async _onClose (frame) {
    const st = this.streams.get(frame.streamId)
    if (!st) return
    if (st.kind === 'ws') {
      st.closed = true
      this._dropApprovals(st)
      for (const ws of [st.ws, st.dshWs]) if (ws && ws.readyState <= 1) ws.close()
    }
    this.streams.delete(frame.streamId)
  }

  detach () {
    if (this._closed) return
    this._closed = true
    for (const [, st] of this.streams) {
      if (st.kind === 'ws') {
        st.closed = true
        this._dropApprovals(st)
        for (const ws of [st.ws, st.dshWs]) if (ws && ws.readyState <= 1) ws.close(1000, 'detached')
      }
    }
    this.streams.clear()
    this.approvals.clear()
    this.e2e = null
  }

  _error (streamId, code, message) {
    this.deps.log?.(`[ph-err] stream=${streamId} code=${code} msg=${message || ''}`) // 2026-10-27 排查：错误帧此前无日志
    const st = this.streams.get(streamId)
    if (st?.kind === 'ws') this._dropApprovals(st)
    if (!this._closed) this.sendFrame({ type: 'error', streamId, code, message })
    this.streams.delete(streamId)
  }
}
