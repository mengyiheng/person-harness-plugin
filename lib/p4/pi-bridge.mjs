// P4：pi → dsh 协议 bridge（照 opencode-bridge.mjs 样板，P4协议适配-skill.md §1 契约）
// 内核：@earendil-works/pi-coding-agent 的 RPC 模式（`pi --mode rpc`，JSON lines over stdio）
//   命令：{id?, type:'prompt'|'get_state'|'switch_session'|..., message}
//   响应：{type:'response', id?, command, success, data|error}
//   事件：session 事件 toJsonEvent 全量转发（agent_start/message_update/message_end/agent_end...）
//   UI 请求：{type:'extension_ui_request', id, method:'confirm'|'select'|'input'} ← L3 审批走 confirm
// 会话落盘：~/.pi/agent/sessions/<safe-cwd>/<id>.jsonl（首行 SessionHeader，entry.type==='message'）
// L1 只读（扫盘 snapshot）+ L2 对话（prompt + 流式）+ L3 审批（confirm→批准/拒绝）+ L4 标题/用量
// 零依赖：HTTP 用 node:http；WS 手写最小 RFC6455（与 opencode-bridge 相同实现）
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const PORT = Number(args.get('--port') || 7707)
const CWD = args.get('--cwd') || process.cwd()
const NODE = args.get('--node') || process.execPath
const PI_JS = args.get('--pi') || 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'
const SESSIONS_DIR = args.get('--sessions') || path.join(os.homedir(), '.pi', 'agent', 'sessions')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const log = (...a) => console.log('[p4-pi-bridge]', ...a)
const APPROVAL_TTL = 120_000

// ---------- 手写最小 WS（同 opencode-bridge） ----------
const wsAccept = (key) => createHash('sha1').update(key + WS_GUID).digest('base64')
function wsSend (sock, text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = len } else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2) } else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
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
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2 } else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8 }
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

// ---------- pi 落盘会话：L1 数据源 ----------
function listSessionFiles () {
  const out = []
  if (!fs.existsSync(SESSIONS_DIR)) return out
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  try { walk(SESSIONS_DIR) } catch { /* 目录不可读当作空 */ }
  return out
}
// jsonl → {header, messages:[{role, text, ts}]}；坏文件跳过
function readSessionFile (file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return null
  let header
  try { header = JSON.parse(lines[0]) } catch { return null }
  if (header?.type !== 'session') return null
  const messages = []
  for (const line of lines.slice(1)) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type !== 'message' || !entry.message) continue
    const m = entry.message
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter((c) => c && (c.type === 'text' || typeof c === 'string'))
      .map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
    if (!text) continue
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', text, ts })
  }
  return { header, messages, file }
}

// ---------- pi rpc 子进程（每会话一个；prompt 前懒拉起） ----------
const procs = new Map() // id → proc 状态
function getProc (id) {
  let p = procs.get(id)
  if (p && !p.dead) return p
  log('spawn pi --mode rpc：session=' + id)
  const child = spawn(NODE, [PI_JS, '--mode', 'rpc'], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'] })
  p = {
    child, dead: false, buf: '', pending: new Map(), // rpcId → {resolve}
    turn: false, curText: '', firstUser: '', titled: false, usage: null, error: null, file: null, startedAt: Date.now()
  }
  procs.set(id, p)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    p.buf += d
    let nl
    while ((nl = p.buf.indexOf('\n')) >= 0) {
      const line = p.buf.slice(0, nl).trim()
      p.buf = p.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      try { handleUpstream(id, p, msg) } catch (e) { log('upstream 处理异常:', e.message) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { const t = d.trim(); if (t) log('pi stderr:', t.slice(0, 200)) })
  child.on('exit', (code) => { p.dead = true; log(`pi 进程退出 code=${code} session=${id}`); procs.delete(id) })
  child.on('error', (e) => { p.dead = true; log('pi 进程错误:', e.message); procs.delete(id) })
  return p
}
function rpc (p, command) {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    p.pending.set(id, { resolve, reject })
    p.child.stdin.write(JSON.stringify({ id, ...command }) + '\n')
    setTimeout(() => { if (p.pending.has(id)) { p.pending.delete(id); reject(new Error('pi rpc 超时: ' + command.type)) } }, 60_000)
  })
}
function textOfMessage (m) {
  return (Array.isArray(m?.content) ? m.content : [])
    .filter((c) => c && (c.type === 'text' || typeof c === 'string'))
    .map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
}

// ---------- followers / 事件分发（同 opencode-bridge 形状） ----------
const followers = new Set() // {sock, streamId, sessionId, st}
function newSessionState () { return { seqMap: new Map(), nextSeq: 1 } }
const seqOf = (f, mid) => {
  if (!f.st.seqMap.has(mid)) f.st.seqMap.set(mid, f.st.nextSeq++ * 2 + 1)
  return f.st.seqMap.get(mid)
}
function emit (f, event) {
  try { wsSend(f.sock, JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event } })) } catch { followers.delete(f) }
}
function emitAll (sessionId, event) {
  for (const f of [...followers]) if (f.sessionId === sessionId && !f.sock.destroyed) emit(f, event)
}

// ---------- L3 审批 pending（按会话全局） ----------
const pendingBySession = new Map()

// pi 上游消息 → dsh 事件
function handleUpstream (id, p, msg) {
  if (msg.type === 'response') {
    const waiter = p.pending.get(msg.id)
    if (waiter) { p.pending.delete(msg.id); msg.success ? waiter.resolve(msg.data) : waiter.reject(new Error(msg.error || 'pi rpc 失败')) }
    return
  }
  if (msg.type === 'extension_ui_request' && msg.method === 'confirm') {
    // L3：安全确认弹窗 → 统一审批事件 + 聊天卡片
    pendingBySession.set(id, { reqId: msg.id, title: msg.title || '确认', message: msg.message || '', expires: Date.now() + APPROVAL_TTL })
    emitAll(id, { type: 'approval/request', seq: 0, data: { reqId: msg.id, permission: msg.title || 'confirm', command: msg.message || '' } })
    emitAll(id, {
      type: 'assistant/message', seq: 999000,
      data: { message: { content: `⚠️ **审批请求**：${msg.title || ''}\n${msg.message || ''}\n回复 **批准** / **拒绝**（${APPROVAL_TTL / 1000}s 内有效，超时自动拒绝）` } }
    })
    log(`审批请求：session=${id} ${msg.title || ''}`)
    setTimeout(() => {
      const cur = pendingBySession.get(id)
      if (cur && cur.reqId === msg.id) {
        pendingBySession.delete(id)
        try { p.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: msg.id, confirmed: false }) + '\n') } catch { }
        log(`审批超时自动拒绝：${msg.id}`)
      }
    }, APPROVAL_TTL + 1000)
    return
  }
  if (msg.type === 'agent_start' || msg.type === 'turn_start') {
    if (!p.turn) { p.turn = true; p.curText = ''; emitAll(id, { type: 'turn/start', seq: 0 }) }
    return
  }
  if (msg.type === 'message_update') {
    // 实测形状（2026-10-25）：{usage, assistantMessageEvent:{type, delta?|content?}}；事件无 messageId
    if (msg.usage && (msg.usage.totalTokens > 0 || msg.usage.output > 0)) p.usage = msg.usage
    const ev = msg.assistantMessageEvent || {}
    if (ev.type === 'text_delta' && typeof ev.delta === 'string') {
      p.curText = (p.curText || '') + ev.delta
      emitAll(id, { type: 'assistant/message', seq: seqOfF(id, 'live'), data: { message: { content: p.curText } } })
    }
    return
  }
  if (msg.type === 'message_end') {
    const m = msg.message
    if (!m) return
    const text = textOfMessage(m)
    if (m.role === 'user') {
      if (!p.firstUser) p.firstUser = text // 标题素材（桥 prompt 时也会记录）
      return
    }
    if (m.role === 'assistant' && text) {
      p.curText = text // 权威终稿替换流式缓冲
      emitAll(id, { type: 'assistant/message', seq: seqOfF(id, 'live'), data: { message: { content: text } } })
      if (m.usage && (m.usage.totalTokens > 0 || m.usage.output > 0)) p.usage = m.usage
    }
    return
  }
  if (msg.type === 'agent_end' || msg.type === 'agent_settled') {
    if (p.turn) {
      p.turn = false
      emitAll(id, { type: 'turn/end', seq: 0 })
      const u = p.usage
      if (u && (u.totalTokens > 0 || u.output > 0)) {
        emitAll(id, { type: 'usage', seq: 0, data: { tokens: { input: u.input || 0, output: u.output || 0, total: u.totalTokens || 0, cost: (u.cost && u.cost.total) || 0 } } })
        emitAll(id, {
          type: 'assistant/message', seq: 999002,
          data: { message: { content: `📊 本轮用量：输入 ${((u.input || 0) / 1000).toFixed(1)}k · 输出 ${((u.output || 0) / 1000).toFixed(1)}k · 合计 ${u.totalTokens} tokens` + ((u.cost && u.cost.total) ? ` · $${u.cost.total.toFixed(4)}` : '') } }
        })
      }
      p.usage = null
      // L4 标题：首条用户消息前 24 字
      if (!p.titled && p.firstUser) {
        p.titled = true
        emitAll(id, { type: 'session/title', seq: 0, data: { title: p.firstUser.slice(0, 24) } })
      }
    }
    return
  }
}
// 跨 follower 共享的 seq（挂在 p 上，避免各 follower 漂移）
function seqOfF (sessionId, mid) {
  const f0 = [...followers].find((f) => f.sessionId === sessionId)
  if (!f0) return 1
  return seqOf(f0, mid)
}

// ---------- snapshot（L1：读落盘；找不到文件则空会话） ----------
async function buildSnapshot (sessionId, st) {
  const file = findSessionFile(sessionId)
  const records = []
  let cursor = 0
  if (file) {
    const { messages } = readSessionFile(file) || { messages: [] }
    for (const m of messages) {
      if (!st.seqMap.has(m.text)) st.seqMap.set(m.text, st.nextSeq++ * 2 + 1)
      const seq = st.seqMap.get(m.text)
      cursor = Math.max(cursor, seq)
      records.push(m.role === 'user'
        ? { type: 'event', event: { type: 'user/message', seq, data: { content: m.text } } }
        : { type: 'event', event: { type: 'assistant/message', seq, data: { message: { content: m.text } } } })
    }
  }
  return { records, cursor }
}
function findSessionFile (sessionId) {
  const hit = listSessionFiles().find((f) => path.basename(f, '.jsonl') === sessionId)
  return hit || null
}

// ---------- mux open ----------
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
      value: { type: 'snapshot', header: { id: sessionId, cwd: 'pi' }, cursor, records }
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
      // 落盘会话 = 权威列表；按 mtime 新→旧
      const items = listSessionFiles().map((f) => {
        const st = fs.statSync(f)
        const id = path.basename(f, '.jsonl')
        const parsed1 = readSessionFile(f)
        const first = parsed1?.messages.find((m) => m.role === 'user')
        return { sessionId: id, updatedAt: Math.floor(st.mtimeMs), cwd: parsed1?.header?.cwd || CWD, agentAvailable: true, running: false, title: first?.text?.slice(0, 24) }
      }).sort((a, b) => b.updatedAt - a.updatedAt)
      // 加上活跃（还没落盘的）新会话
      for (const id of procs.keys()) if (!items.some((i) => i.sessionId === id)) items.unshift({ sessionId: id, updatedAt: Date.now(), cwd: CWD, agentAvailable: true, running: true })
      wrap({ items })
    } else if (req.url === '/api/session/create') {
      const id = randomUUID()
      wrap({ sessionId: id }) // 进程在首次 prompt 时懒拉起
    } else if (req.url === '/api/session/prompt') {
      const r = parsed.payload?.args?.request || parsed.request || {}
      if (!r.sessionId) return fail('缺 sessionId')
      const text = (r.content || []).map((c) => c.text || '').join('').trim()
      // L3 审批拦截：批准/拒绝 直接应答 extension_ui_response
      const pending = pendingBySession.get(r.sessionId)
      if (pending && Date.now() < pending.expires) {
        const p = getProc(r.sessionId)
        const lower = text.toLowerCase()
        const yes = ['批准', '允许', '同意', 'yes', 'ok', 'y'].some((w) => lower === w || lower.startsWith(w))
        const no = ['拒绝', '不同意', '不允许', 'no', 'n'].some((w) => lower === w || lower.startsWith(w))
        if (yes || no) {
          pendingBySession.delete(r.sessionId)
          p.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: pending.reqId, confirmed: yes }) + '\n')
          return wrap({ approval: yes ? 'once' : 'reject' })
        }
        // 非审批指令 → 先拒绝 pending（用户选择继续对话）
        pendingBySession.delete(r.sessionId)
        try { p.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: pending.reqId, confirmed: false }) + '\n') } catch { }
      }
      const p = getProc(r.sessionId)
      if (!p.firstUser) p.firstUser = text // L4 标题素材
      emitAll(r.sessionId, { type: 'user/message', seq: seqOfF(r.sessionId, 'u' + randomUUID()), data: { content: text } })
      await rpc(p, { type: 'prompt', message: text })
      wrap({})
    } else if (req.url === '/api/session/approve') {
      const r = parsed.payload?.args?.request || parsed.request || {}
      const pending = pendingBySession.get(r.sessionId)
      if (!pending || Date.now() >= pending.expires) return fail('无待审批请求')
      pendingBySession.delete(r.sessionId)
      const p = getProc(r.sessionId)
      p.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: pending.reqId, confirmed: r.response !== 'reject' }) + '\n')
      wrap({ approval: r.response === 'reject' ? 'reject' : 'once' })
    } else if (req.url === '/api/session/page') {
      wrap({ records: [], cursor: 0 })
    } else {
      fail('未知方法: ' + req.url)
    }
  } catch (e) { fail(e.message) }
})

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
  log(`P4 pi-bridge 就绪: http://127.0.0.1:${PORT}（内核 pi --mode rpc，cwd ${CWD}）`)
})
