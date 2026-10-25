// P4：opencode → dsh 协议 bridge（独立 target，spawn 托管）
// 形态：外观 dsh、内核 opencode——App 原生聊天页零改动接入（P4协议适配-skill.md §1 契约）
// L1 只读（list/create/follow snapshot）+ L2 对话（prompt + 流式 + turn 信号）
// 零依赖：HTTP 用 node:http；WS 手写最小 RFC6455（仅文本帧、小 JSON、双方自控）
//
// opencode SSE 事件形状（2026-10-24 实测）：
//   message.updated       {sessionID, info:{id, role}}
//   message.part.updated  {sessionID, part:{type:'text', text(累积), messageID, id(partId)}}
//   session.status        {status:{type:'busy'|'idle'}}
//   session.idle          {sessionID}   ← 一轮结束（turn/end 判据）
import http from 'node:http'
import { createHash } from 'node:crypto'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const PORT = Number(args.get('--port') || 7706)
const UPSTREAM = (args.get('--origin') || 'http://127.0.0.1:4096').replace(/\/$/, '')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const log = (...a) => console.log('[p4-bridge]', ...a)

// ---------- opencode 上游 ----------
const oc = async (method, path, body) => {
  const res = await fetch(UPSTREAM + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok) throw new Error(`opencode ${method} ${path} → ${res.status}`)
  if (res.status === 204) return null
  return res.json()
}

// ---------- 会话状态（每个 follower 一份；seq 计数器制，🔴 重启会漂移——下次改 messageId 哈希派生） ----------
function newSessionState () {
  return { seqMap: new Map(), nextSeq: 1, msgRole: new Map(), parts: new Map(), runningTurn: false }
}

// L3 审批：pending 按 session 全局存（HTTP prompt 与 WS follower 共享）；
// {id, command, permission, expires} —— 120s 未决自动拒绝（安全默认）
const pendingBySession = new Map()
const APPROVAL_TTL = 120_000

// opencode 消息列表 → dsh snapshot（顺序按 time.created，seq 按分配序；头部带标题）
async function buildSnapshot (sessionId, st) {
  const msgs = await oc('GET', `/session/${sessionId}/message`)
  const records = []
  try {
    const s = await oc('GET', `/session/${sessionId}`)
    if (s?.title) records.push({ type: 'event', event: { type: 'session/title', seq: 0, data: { title: s.title } } })
  } catch { /* 标题拿不到不致命 */ }
  const sorted = [...(msgs || [])].sort((a, b) => (a.info?.time?.created || 0) - (b.info?.time?.created || 0))
  let cursor = 0
  for (const m of sorted) {
    const role = m.info?.role
    const text = (m.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('')
    if (!text) continue
    if (!st.seqMap.has(m.info.id)) st.seqMap.set(m.info.id, st.nextSeq++ * 2 + 1)
    const seq = st.seqMap.get(m.info.id)
    st.msgRole.set(m.info.id, role)
    cursor = Math.max(cursor, seq)
    if (role === 'user') {
      records.push({ type: 'event', event: { type: 'user/message', seq, data: { content: text } } })
    } else {
      records.push({ type: 'event', event: { type: 'assistant/message', seq, data: { message: { content: text } } } })
    }
  }
  return { records, cursor }
}

// ---------- 手写最小 WS 服务端（仅文本帧） ----------
function wsAccept (key) { return createHash('sha1').update(key + WS_GUID).digest('base64') }
function wsSend (sock, text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x81
  sock.write(Buffer.concat([header, payload]))
}
function wsParse (buf) {
  const frames = []
  let off = 0
  while (off + 2 <= buf.length) {
    const b0 = buf[off]; const b1 = buf[off + 1]
    const op = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let p = off + 2
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
    const maskKey = masked ? buf.subarray(p, p + 4) : null
    if (masked) p += 4
    if (p + len > buf.length) break
    let payload = buf.subarray(p, p + len)
    if (masked) { const out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4]; payload = out }
    frames.push({ op, text: payload.toString('utf8') })
    off = p + len
  }
  return { frames, rest: buf.subarray(off) }
}

// ---------- followers ----------
const followers = new Set() // {sock, streamId, sessionId, st}

function emit (f, event) {
  try { wsSend(f.sock, JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event } })) } catch { followers.delete(f) }
}
const seqOf = (f, mid) => {
  if (!f.st.seqMap.has(mid)) f.st.seqMap.set(mid, f.st.nextSeq++ * 2 + 1)
  return f.st.seqMap.get(mid)
}

// ---------- SSE 增量分发 ----------
async function startLive () {
  try {
    const res = await fetch(UPSTREAM + '/event')
    log('SSE 增量订阅已建立（/event）')
    ;(async () => {
      try {
        for await (const chunk of res.body) {
          const text = Buffer.from(chunk).toString('utf8')
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue
            let ev
            try { ev = JSON.parse(line.slice(6)) } catch { continue }
            const p = ev.properties || {}
            for (const f of [...followers]) {
              if (f.sessionId !== p.sessionID || f.sock.destroyed) continue
              try { dispatch(f, ev.type, p) } catch { /* 单条失败忽略 */ }
            }
          }
        }
      } catch { /* SSE 断开：重连 */ }
      setTimeout(startLive, 5000)
    })()
  } catch (e) {
    log('SSE 订阅失败（稍后重试）: ' + e.message)
    setTimeout(startLive, 15_000)
  }
}

function dispatch (f, type, p) {
  // L4 用量：step-finish part 带 tokens/cost → 累计，turn 结束出卡片
  if (type === 'message.part.updated' && p.part?.type === 'step-finish') {
    const tk = p.part.tokens || {}
    f.st.usage = f.st.usage || { input: 0, output: 0, total: 0, cost: 0 }
    f.st.usage.input += tk.input || 0
    f.st.usage.output += tk.output || 0
    f.st.usage.total += tk.total || 0
    f.st.usage.cost += p.part.cost || 0
    return
  }
  // L4 标题：session.updated 带新标题 → dsh session/title 事件（去重，App 列表即时更新）
  if (type === 'session.updated' && p.info?.title) {
    if (f.st.lastTitle !== p.info.title) {
      f.st.lastTitle = p.info.title
      emit(f, { type: 'session/title', seq: 0, data: { title: p.info.title } })
    }
    return
  }
  if (type === 'permission.asked' && p.id) {
    // L3 审批：① 未来 App 按钮用的结构化事件 ② 今天可用的聊天卡片（回复 批准/拒绝）
    pendingBySession.set(p.sessionID, {
      id: p.id,
      permission: p.permission,
      command: p.metadata?.command || (p.patterns || []).join(' '),
      expires: Date.now() + APPROVAL_TTL
    })
    emit(f, { type: 'approval/request', seq: 0, data: { reqId: p.id, permission: p.permission, command: p.metadata?.command || '' } })
    emit(f, {
      type: 'assistant/message', seq: 999000,
      data: { message: { content: `⚠️ **审批请求**（${p.permission}）：\n\`\`\`\n${p.metadata?.command || (p.patterns || []).join(' ')}\n\`\`\`\n回复 **批准** / **总是批准** / **拒绝**（${APPROVAL_TTL / 1000}s 内有效，超时自动拒绝）` } }
    })
    log(`审批请求：session=${p.sessionID} ${p.permission} ${p.metadata?.command || ''}`)
    setTimeout(() => {
      const cur = pendingBySession.get(p.sessionID)
      if (cur && cur.id === p.id) {
        pendingBySession.delete(p.sessionID)
        oc('POST', `/session/${p.sessionID}/permissions/${p.id}`, { response: 'reject' }).catch(() => { })
        log(`审批超时自动拒绝：${p.id}`)
      }
    }, APPROVAL_TTL + 1000)
    return
  }
  if (type === 'message.updated' && p.info) {
    f.st.msgRole.set(p.info.id, p.info.role)
    return
  }
  if (type === 'message.part.updated' && p.part?.type === 'text') {
    const mid = p.part.messageID
    const role = f.st.msgRole.get(mid)
    if (!f.st.parts.has(mid)) f.st.parts.set(mid, new Map())
    f.st.parts.get(mid).set(p.part.id, p.part.text)
    const text = [...f.st.parts.get(mid).values()].join('')
    if (!text) return
    const seq = seqOf(f, mid)
    if (role === 'user') {
      emit(f, { type: 'user/message', seq, data: { content: text } })
    } else {
      // 未知 role（part 先于 message.updated 到达）按 assistant 处理（流式常见序）
      if (!f.st.runningTurn) { f.st.runningTurn = true; emit(f, { type: 'turn/start', seq }) }
      emit(f, { type: 'assistant/message', seq, data: { message: { content: text } } })
    }
    return
  }
  if ((type === 'session.status' && p.status?.type === 'busy')) {
    if (!f.st.runningTurn) { f.st.runningTurn = true; emit(f, { type: 'turn/start', seq: 0 }) }
    return
  }
  if ((type === 'session.idle') || (type === 'session.status' && p.status?.type === 'idle')) {
    if (f.st.runningTurn) {
      f.st.runningTurn = false
      emit(f, { type: 'turn/end', seq: 0 })
      // L4 用量卡片：本轮累计（结构化 usage 事件 + 聊天内可见文本）
      if (f.st.usage && f.st.usage.total > 0) {
        const u = f.st.usage
        emit(f, { type: 'usage', seq: 0, data: { tokens: u } })
        emit(f, {
          type: 'assistant/message', seq: 999002,
          data: { message: { content: `📊 本轮用量：输入 ${(u.input / 1000).toFixed(1)}k · 输出 ${(u.output / 1000).toFixed(1)}k · 费用 $${u.cost.toFixed(4)}` } }
        })
        f.st.usage = null
      }
    }
    return
  }
}

// ---------- mux 会话（session/follow） ----------
function handleMuxOpen (msg, sock) {
  if (msg.endpoint !== 'session/follow') {
    wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'bad-endpoint', message: '仅支持 session/follow' }))
    return
  }
  const sessionId = msg.payload?.args?.request?.address?.sessionId
  if (!sessionId) {
    wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'bad-address', message: '缺 sessionId' }))
    return
  }
  const st = newSessionState()
  buildSnapshot(sessionId, st).then(({ records, cursor }) => {
    wsSend(sock, JSON.stringify({
      type: 'item', streamId: msg.streamId,
      value: { type: 'snapshot', header: { id: sessionId, cwd: 'opencode' }, cursor, records }
    }))
    followers.add({ sock, streamId: msg.streamId, sessionId, st })
    log(`follow snapshot：session=${sessionId} records=${records.length} cursor=${cursor}`)
  }).catch((e) => {
    wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'upstream-error', message: e.message }))
  })
}

// ---------- HTTP 面（dsh 一元 RPC 外观） ----------
const server = http.createServer(async (req, res) => {
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method !== 'POST' || !req.url.startsWith('/api/')) return json(404, { error: 'not found' })
  let body = ''
  for await (const c of req) body += c
  let parsed = {}
  try { parsed = JSON.parse(body) } catch { }
  const rpcId = parsed.rpcId
  const wrap = (value) => json(200, { type: 'server-response', rpcId, result: { ok: true, value } })
  const fail = (message) => json(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'bridge-error', message } } })
  try {
    if (req.url === '/api/session/list') {
      const sessions = await oc('GET', '/session')
      wrap({ items: (sessions || []).map((s) => ({ sessionId: s.id, updatedAt: s.time?.updated ? Math.floor(new Date(s.time.updated).getTime()) : undefined, cwd: s.directory, agentAvailable: true, running: false })) })
    } else if (req.url === '/api/session/create') {
      const s = await oc('POST', '/session', {})
      wrap({ sessionId: s.id })
    } else if (req.url === '/api/session/prompt') {
      // App 请求体：{requestId, sessionId, mode:'queue', content:[{type:'text',text}]}
      const r = parsed.payload?.args?.request || parsed.request || {}
      if (!r.sessionId) return fail('缺 sessionId')
      const text = (r.content || []).map((c) => c.text || '').join('').trim()
      // L3 审批拦截：pending 期间的 批准/总是批准/拒绝 不进 agent，直接应答权限接口
      const pending = pendingBySession.get(r.sessionId)
      if (pending && Date.now() < pending.expires) {
        const approveWords = ['批准', '允许', '同意', 'yes', 'ok', 'y']
        const alwaysWords = ['总是批准', '全部批准', 'always', '都批准']
        const rejectWords = ['拒绝', '不同意', '不允许', 'no', 'n']
        const lower = text.toLowerCase()
        if (alwaysWords.some((w) => lower === w || lower.startsWith(w))) {
          pendingBySession.delete(r.sessionId)
          await oc('POST', `/session/${r.sessionId}/permissions/${pending.id}`, { response: 'always' })
          return wrap({ approval: 'always' })
        }
        if (approveWords.some((w) => lower === w || lower.startsWith(w))) {
          pendingBySession.delete(r.sessionId)
          await oc('POST', `/session/${r.sessionId}/permissions/${pending.id}`, { response: 'once' })
          return wrap({ approval: 'once' })
        }
        if (rejectWords.some((w) => lower === w || lower.startsWith(w))) {
          pendingBySession.delete(r.sessionId)
          await oc('POST', `/session/${r.sessionId}/permissions/${pending.id}`, { response: 'reject' })
          return wrap({ approval: 'reject' })
        }
        // 既不是审批指令 → 先把 pending 拒掉（用户选择继续对话），再正常发消息
        pendingBySession.delete(r.sessionId)
        oc('POST', `/session/${r.sessionId}/permissions/${pending.id}`, { response: 'reject' }).catch(() => { })
      }
      await oc('POST', `/session/${r.sessionId}/prompt_async`, { parts: r.content || [] })
      wrap({})
    } else if (req.url === '/api/session/approve') {
      // L3 结构化应答口（未来 App 按钮用；聊天回复"批准/拒绝"走 prompt 拦截）
      const r = parsed.payload?.args?.request || parsed.request || {}
      const pending = pendingBySession.get(r.sessionId)
      if (!pending || Date.now() >= pending.expires) return fail('无待审批请求')
      pendingBySession.delete(r.sessionId)
      const response = r.response === 'reject' ? 'reject' : (r.response === 'always' ? 'always' : 'once')
      await oc('POST', `/session/${r.sessionId}/permissions/${pending.id}`, { response })
      wrap({ approval: response })
    } else if (req.url === '/api/session/page') {
      wrap({ records: [], cursor: 0 }) // 翻页未实现（App 视为"已到开头"）
    } else {
      fail('未知方法: ' + req.url)
    }
  } catch (e) { fail(e.message) }
})

// WS 升级（/api/remote.mux）
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']
  if (!key) { sock.destroy(); return }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
  let buf = Buffer.alloc(0)
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    const { frames, rest } = wsParse(buf)
    buf = rest
    for (const f of frames) {
      if (f.op === 8) { try { sock.end() } catch { } return }
      if (f.op === 9) {
        const p = Buffer.from(f.text, 'utf8'); const h = Buffer.alloc(2); h[0] = 0x8A; h[1] = p.length
        sock.write(Buffer.concat([h, p])); continue
      }
      if (f.op !== 1) continue
      let msg
      try { msg = JSON.parse(f.text) } catch { continue }
      if (msg.type === 'open') handleMuxOpen(msg, sock)
      else if (msg.type === 'close') { for (const fl of [...followers]) if (fl.streamId === msg.streamId) followers.delete(fl) }
    }
  })
  sock.on('close', () => { for (const f of [...followers]) if (f.sock === sock) followers.delete(f) })
  sock.on('error', () => { })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`P4 opencode-bridge 就绪: http://127.0.0.1:${PORT}（上游 ${UPSTREAM}）`)
  startLive()
})
