// P4：gemini → dsh 协议 bridge（照 opencode-bridge.mjs 样板，P4协议适配-skill.md §1 契约）
// 内核：gemini CLI 无长驻 server——每条 prompt 拉一次无头进程：
//   首条：node gemini.js --session-id <id> -p <text>        （gemini 自己持久化会话）
//   续聊：node gemini.js --resume latest -p <text>          （bridge 内按会话串行化）
// 会话保持策略：模型上下文由 gemini 落盘续接；展示层历史由 bridge 台账（JSONL）权威记录。
// 🔴 已知限制：① gemini 无可靠的结构化 headless 审批通道，桥不自动批准，也不使用 --yolo。
//   ② --resume latest 按"本项目最近会话"续接，若同时用 gemini TUI 并行对话会串台（串行化只保证桥内）
// L1 只读（台账 snapshot）+ L2 对话（stdout 流式）+ L3 不适用 + L4 标题（首条消息派生）
// 零依赖：HTTP 用 node:http；WS 手写最小 RFC6455（与 opencode-bridge 相同实现）
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatShellHtml } from '../chat-shell.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const PORT = Number(args.get('--port') || 7709)
const CWD = args.get('--cwd') || process.cwd()
const NODE = args.get('--node') || process.execPath
const GEMINI_JS = args.get('--gemini') || process.env.GEMINI_CLI || path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js')
const REG_DIR = args.get('--reg') || path.join(os.homedir(), '.ph', 'p4-gemini-bridge')
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const log = (...a) => console.log('[p4-gemini-bridge]', ...a)

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

// ---------- 会话台账（JSONL，一行 = {session, role, text, ts}；首行 = {session:{id,title,createdAt}}） ----------
function regFile (id) { return path.join(REG_DIR, id + '.jsonl') }
function readReg (id) {
  const f = regFile(id)
  if (!fs.existsSync(f)) return null
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim())
  if (!lines.length) return null
  let meta = {}
  const messages = []
  for (const line of lines) {
    let rec
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.session) { meta = rec.session; continue }
    if (rec.role && typeof rec.text === 'string') messages.push(rec)
  }
  return { meta, messages, file: f }
}
function appendReg (id, obj) {
  fs.mkdirSync(REG_DIR, { recursive: true })
  fs.appendFileSync(regFile(id), JSON.stringify(obj) + '\n')
}

// ---------- followers / seq（同 opencode-bridge） ----------
const followers = new Set()
function newSessionState () { return { seqMap: new Map(), nextSeq: 1 } }
const seqGlobal = new Map() // sessionId → {map,next}
function seqFor (sid, mid) {
  let s = seqGlobal.get(sid)
  if (!s) { s = { map: new Map(), next: 1 }; seqGlobal.set(sid, s) }
  if (!s.map.has(mid)) s.map.set(mid, s.next++ * 2 + 1)
  return s.map.get(mid)
}
function emit (f, event) {
  try { wsSend(f.sock, JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event } })) } catch { followers.delete(f) }
}
function emitAll (sid, event) {
  for (const f of [...followers]) if (f.sessionId === sid && !f.sock.destroyed) emit(f, event)
}

// ---------- gemini 无头执行（每会话串行队列） ----------
const queues = new Map() // sessionId → Promise 链
const activeRuns = new Map()
const modelsBySession = new Map()
const configuredModels = (args.get('--models') || '').split(',').map((m) => m.trim()).filter(Boolean)
const defaultModel = args.get('--model') || ''
const availableModels = [...new Set([defaultModel, ...configuredModels].filter(Boolean))]
function enqueue (sid, fn) {
  const prev = queues.get(sid) || Promise.resolve()
  const next = prev.then(fn).catch((e) => log('gemini 任务失败:', e.message)).finally(() => { if (queues.get(sid) === next) queues.delete(sid) })
  queues.set(sid, next)
  return next
}
function runGemini (sid, text, hasUpstreamSession) {
  return new Promise((resolve, reject) => {
    const cliArgs = hasUpstreamSession ? ['--resume', 'latest'] : ['--session-id', sid]
    const model = modelsBySession.get(sid) || defaultModel
    if (model && model !== 'default') cliArgs.push('--model', model)
    cliArgs.push('-p', text)
    log(`gemini 无头执行：session=${sid} resume=${!!hasUpstreamSession}`)
    const child = spawn(NODE, [GEMINI_JS, ...cliArgs], { cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GEMINI_CLI_NO_RELAUNCH: '1', NO_COLOR: '1' } })
    activeRuns.set(sid, child)
    let out = ''
    const mid = 'a' + Date.now()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      out += d
      emitAll(sid, { type: 'assistant/message', seq: seqFor(sid, mid), data: { message: { content: out } } })
    })
    child.stderr.setEncoding('utf8')
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    const killer = setTimeout(() => { try { child.kill() } catch { } }, 300_000)
    child.on('exit', (code) => {
      clearTimeout(killer)
      if (activeRuns.get(sid) === child) activeRuns.delete(sid)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`gemini exit ${code}: ${err.slice(-300) || out.slice(-300)}`))
    })
    child.on('error', (e) => {
      clearTimeout(killer)
      if (activeRuns.get(sid) === child) activeRuns.delete(sid)
      reject(e)
    })
  })
}

// ---------- snapshot（L1：台账） ----------
async function buildSnapshot (sid, st) {
  const reg = readReg(sid)
  const records = []
  let cursor = 0
  if (reg) {
    if (reg.meta.title) records.push({ type: 'event', event: { type: 'session/title', seq: 0, data: { title: reg.meta.title } } })
    for (const m of reg.messages) {
      const seq = seqFor(sid, (m.role === 'user' ? 'u' : 'a') + m.ts)
      cursor = Math.max(cursor, seq)
      records.push(m.role === 'user'
        ? { type: 'event', event: { type: 'user/message', seq, data: { content: m.text } } }
        : { type: 'event', event: { type: 'assistant/message', seq, data: { message: { content: m.text } } } })
    }
  }
  return { records, cursor }
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
      value: { type: 'snapshot', header: { id: sessionId, cwd: 'gemini', running: queues.has(sessionId) }, cursor, records }
    }))
    followers.add({ sock, streamId: msg.streamId, sessionId, st })
    log(`follow snapshot：session=${sessionId} records=${records.length} cursor=${cursor}`)
  }).catch((e) => {
    wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'upstream-error', message: e.message }))
  })
}

// ---------- HTTP 面 ----------
const server = http.createServer(async (req, res) => {
  const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && !req.url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(chatShellHtml('Gemini', { alwaysApproval: false }))
  }
  if (req.method !== 'POST' || !req.url.startsWith('/api/')) return json(404, { error: 'not found' })
  let body = ''
  for await (const c of req) body += c
  let parsed = {}
  try { parsed = JSON.parse(body) } catch { }
  const rpcId = parsed.rpcId
  const r = parsed.payload?.args?.request || parsed.request || {}
  const wrap = (value) => json(200, { type: 'server-response', rpcId, result: { ok: true, value } })
  const fail = (message) => json(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'bridge-error', message } } })
  try {
    if (req.url === '/api/session/list') {
      const items = []
      if (fs.existsSync(REG_DIR)) {
        for (const f of fs.readdirSync(REG_DIR).filter((f) => f.endsWith('.jsonl'))) {
          const id = path.basename(f, '.jsonl')
          const reg = readReg(id)
          if (!reg) continue
          items.push({
            sessionId: id,
            updatedAt: Math.floor(fs.statSync(path.join(REG_DIR, f)).mtimeMs),
            cwd: reg.meta.cwd || CWD,
            agentAvailable: true,
            running: queues.has(id),
            title: reg.meta.title
          })
        }
      }
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      wrap({ items })
    } else if (req.url === '/api/session/create') {
      const id = randomUUID().replace(/-/g, '').slice(0, 20)
      appendReg(id, { session: { id, createdAt: Date.now(), cwd: CWD, title: '新对话' } })
      if (r.model) modelsBySession.set(id, r.model)
      wrap({ sessionId: id })
    } else if (req.url === '/api/model/list') {
      const items = availableModels.length
        ? availableModels.map((id) => ({ id, name: id }))
        : [{ id: 'default', name: 'Gemini 默认模型（本地配置）' }]
      wrap({ items, selected: modelsBySession.get(r.sessionId) || defaultModel || items[0].id })
    } else if (req.url === '/api/model/select') {
      if (!r.sessionId || !r.model) return fail('缺 sessionId 或 model')
      const available = availableModels.length ? availableModels : ['default']
      if (!available.includes(r.model)) return fail('模型不可用: ' + r.model)
      modelsBySession.set(r.sessionId, r.model)
      wrap({ selected: r.model })
    } else if (req.url === '/api/session/prompt') {
      if (!r.sessionId) return fail('缺 sessionId')
      const text = (r.content || []).map((c) => c.text || '').join('').trim()
      if (!text) return fail('消息不能为空')
      if (!readReg(r.sessionId)) return fail('会话不存在（先 create）')
      const first = readReg(r.sessionId).messages.length === 0
      appendReg(r.sessionId, { role: 'user', text, ts: Date.now() })
      if (first) {
        const title = text.slice(0, 24)
        appendReg(r.sessionId, { session: { id: r.sessionId, createdAt: Date.now(), cwd: CWD, title } })
        emitAll(r.sessionId, { type: 'session/title', seq: 0, data: { title } })
      }
      emitAll(r.sessionId, { type: 'user/message', seq: seqFor(r.sessionId, 'u' + Date.now()), data: { content: text } })
      emitAll(r.sessionId, { type: 'turn/start', seq: 0 })
      enqueue(r.sessionId, async () => {
        try {
          const answer = await runGemini(r.sessionId, text, !first)
          appendReg(r.sessionId, { role: 'assistant', text: answer, ts: Date.now() })
          emitAll(r.sessionId, { type: 'turn/end', seq: 0 })
        } catch (e) {
          emitAll(r.sessionId, { type: 'assistant/message', seq: 999003, data: { message: { content: '❌ gemini 错误：' + e.message } } })
          emitAll(r.sessionId, { type: 'turn/end', seq: 0 })
        }
      })
      wrap({ accepted: true, queued: true })
    } else if (req.url === '/api/session/cancel') {
      if (!r.sessionId) return fail('缺 sessionId')
      const child = activeRuns.get(r.sessionId)
      if (child && child.exitCode == null) child.kill()
      wrap({ accepted: true })
    } else if (req.url === '/api/session/approve') {
      fail('Gemini 无可靠的结构化 headless 审批通道；桥接不会自动批准操作')
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
  log(`P4 gemini-bridge 就绪: http://127.0.0.1:${PORT}（内核 gemini 无头 -p，cwd ${CWD}）`)
})
