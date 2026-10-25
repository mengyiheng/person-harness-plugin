// P4：codex → dsh 协议 bridge（照 opencode-bridge.mjs 样板，P4协议适配-skill.md §1 契约）
// 内核：`codex app-server`（JSON-RPC over stdio，单长驻子进程，thread 多路复用）
//   客户端请求：thread/start / thread/resume / thread/list / thread/read / turn/start / turn/interrupt
//   服务端通知：thread/started、turn/started、item/started、item/agentMessage/delta、item/completed、
//              turn/completed、thread/tokenUsage/updated、thread/name/updated、thread/status/changed
//   服务端请求（L3 审批）：item/commandExecution/requestApproval / item/fileChange/requestApproval
//     → 应答 {decision:'accept'|'acceptForSession'|'decline'}（协议 Schema 实测 0.164.0）
// L1 只读（thread/list + thread/read snapshot）+ L2 对话 + L3 审批 + L4 标题/用量
// 零依赖：HTTP 用 node:http；WS 手写最小 RFC6455（与 opencode-bridge 相同实现）
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const PORT = Number(args.get('--port') || 7708)
const CWD = args.get('--cwd') || process.cwd()
const CODEX = args.get('--codex') || 'D:\\pythonProject\\harness\\tools\\codex\\codex.exe'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const log = (...a) => console.log('[p4-codex-bridge]', ...a)
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

// ---------- codex app-server 子进程（单长驻，JSON-RPC over stdio） ----------
// 🔴 实测坑（2026-10-25）：sqlite 状态库在 C:\Users\* 下任何目录初始化都报 os error 5（ACL 正常也复现，
//   疑似 Defender 对用户目录的行为拦截）；CODEX_HOME 放 D 盘即好。回退目录默认进工作区，可用 --codex-home 覆盖。
let child = null
let dead = false
let nextId = 1
let usingFallbackHome = false
const pending = new Map() // rpcId → {resolve, reject}
const bufferRef = { buf: '' }

function ensureChild () {
  if (child && !dead) return child
  const home = usingFallbackHome ? FALLBACK_HOME : undefined
  log('spawn codex app-server' + (home ? `（CODEX_HOME=${home}）` : ''))
  const env = { ...process.env }
  if (home) { env.CODEX_HOME = home; fs.mkdirSync(home, { recursive: true }) }
  child = spawn(CODEX, ['app-server'], { cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], env })
  dead = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => {
    bufferRef.buf += d
    let nl
    while ((nl = bufferRef.buf.indexOf('\n')) >= 0) {
      const line = bufferRef.buf.slice(0, nl).trim()
      bufferRef.buf = bufferRef.buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      try { handleUpstream(msg) } catch (e) { log('upstream 处理异常:', e.message) }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { const t = d.trim(); if (t && !t.includes('WARNING')) log('codex stderr:', t.slice(0, 200)) })
  child.on('exit', (code) => {
    dead = true
    log(`codex 进程退出 code=${code}；后续调用将重拉`)
    // 初始化即退（sqlite 家目录打不开等）→ 切 fallback 家目录重拉
    if (!initialized && !usingFallbackHome) {
      usingFallbackHome = true
      log('默认 CODEX_HOME 初始化失败，切换 fallback：' + FALLBACK_HOME)
      setTimeout(() => { try { rpc('initialize', INIT_PARAMS).catch(() => { }) } catch { } }, 500)
    }
  })
  child.on('error', (e) => { dead = true; log('codex 进程错误:', e.message) })
  // initialize（app-server 要求首个请求）
  rpc('initialize', INIT_PARAMS).catch((e) => log('initialize 失败:', e.message))
  return child
}
const FALLBACK_HOME = args.get('--codex-home') || 'D:\\pythonProject\\harness\\.p4-codex-home'
const INIT_PARAMS = { clientInfo: { name: 'happy-p4-bridge', title: 'Happy P4 Bridge', version: '0.1.0' } }
let initialized = false
function rpc (method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ensureChild().stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('codex rpc 超时: ' + method)) } }, 60_000)
  })
}

// ---------- followers / seq（同 opencode-bridge） ----------
const followers = new Set()
function newSessionState () { return { seqMap: new Map(), nextSeq: 1 } }
const seqOf = (f, mid) => {
  if (!f.st.seqMap.has(mid)) f.st.seqMap.set(mid, f.st.nextSeq++ * 2 + 1)
  return f.st.seqMap.get(mid)
}
const seqGlobal = new Map() // threadId → {map,next}（跨 follower 共享，避免流式中各 follower seq 漂移）
function seqFor (threadId, mid) {
  let s = seqGlobal.get(threadId)
  if (!s) { s = { map: new Map(), next: 1 }; seqGlobal.set(threadId, s) }
  if (!s.map.has(mid)) s.map.set(mid, s.next++ * 2 + 1)
  return s.map.get(mid)
}
function emit (f, event) {
  try { wsSend(f.sock, JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event } })) } catch { followers.delete(f) }
}
function emitAll (threadId, event) {
  for (const f of [...followers]) if (f.sessionId === threadId && !f.sock.destroyed) emit(f, event)
}
function emitText (threadId, mid, text) {
  if (!text) return
  emitAll(threadId, { type: 'assistant/message', seq: seqFor(threadId, mid), data: { message: { content: text } } })
}

// ---------- L3 审批 pending ----------
const pendingBySession = new Map()
function autoDecline (threadId) {
  const cur = pendingBySession.get(threadId)
  if (cur && Date.now() >= cur.expires) {
    pendingBySession.delete(threadId)
    // 通知已在 app-server 侧等待应答——静默 decline 由超时回调发
  }
}

// ---------- codex 通知/请求 → dsh 事件 ----------
const lastUsageByThread = new Map()
function handleUpstream (msg) {
  // JSON-RPC 响应（对应 rpc() 的 pending）
  if (msg.id !== undefined && msg.id !== null && !msg.method) {
    if (!initialized) initialized = true
    const waiter = pending.get(msg.id)
    if (waiter) { pending.delete(msg.id); msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result) }
    return
  }
  // 服务端请求（审批）
  if (msg.method && msg.id !== undefined && msg.id !== null) {
    const p = msg.params || {}
    const threadId = p.threadId
    if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'item/fileChange/requestApproval' || msg.method === 'execCommandApproval' || msg.method === 'applyPatchApproval') {
      const command = p.command || p.reason || (msg.method.includes('fileChange') ? '文件修改' : '命令执行')
      pendingBySession.set(threadId, { rpcId: msg.id, command, expires: Date.now() + APPROVAL_TTL })
      emitAll(threadId, { type: 'approval/request', seq: 0, data: { reqId: String(msg.id), permission: msg.method, command } })
      emitAll(threadId, {
        type: 'assistant/message', seq: 999000,
        data: { message: { content: `⚠️ **审批请求**：\n\`\`\`\n${command}\n\`\`\`\n回复 **批准** / **总是批准** / **拒绝**（${APPROVAL_TTL / 1000}s 内有效，超时自动拒绝）` } }
      })
      log(`审批请求：thread=${threadId} ${command}`)
      setTimeout(() => {
        const cur = pendingBySession.get(threadId)
        if (cur && cur.rpcId === msg.id) {
          pendingBySession.delete(threadId)
          respondApproval(msg.id, 'decline')
          log(`审批超时自动拒绝：thread=${threadId}`)
        }
      }, APPROVAL_TTL + 1000)
      return
    }
    // 未识别的服务端请求：空对象兜底应答，避免 app-server 挂起
    log('未处理的服务端请求:', msg.method)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
    return
  }
  // 通知
  const p = msg.params || {}
  const threadId = p.threadId
  if (!threadId) return
  switch (msg.method) {
    case 'turn/started':
      emitAll(threadId, { type: 'turn/start', seq: 0 })
      break
    case 'item/started':
      if (p.item?.type === 'userMessage') {
        const text = (p.item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
        emitAll(threadId, { type: 'user/message', seq: seqFor(threadId, p.item.id), data: { content: text } })
      }
      break
    case 'item/agentMessage/delta': {
      // delta 累积：按 itemId 维护缓冲
      const key = 'delta:' + threadId + ':' + p.itemId
      acc.set(key, (acc.get(key) || '') + (p.delta || ''))
      emitAll(threadId, { type: 'assistant/message', seq: seqFor(threadId, p.itemId), data: { message: { content: acc.get(key) } } })
      break
    }
    case 'item/completed': {
      const it = p.item
      if (it?.type === 'agentMessage') {
        acc.delete('delta:' + threadId + ':' + it.id)
        emitText(threadId, it.id, it.text || '')
      } else if (it?.type === 'commandExecution') {
        // 工具块：折叠卡片（聊天内可见文本形态）
        const line = `🔧 **命令**（${it.status || '执行中'}）\n\`\`\`\n${(it.command || '').slice(0, 500)}\n\`\`\``
        emitText(threadId, it.id, line)
      } else if (it?.type === 'fileChange') {
        emitText(threadId, it.id, `📝 **文件修改**（${it.status || ''}）`)
      }
      break
    }
    case 'thread/tokenUsage/updated':
      lastUsageByThread.set(threadId, p.tokenUsage)
      break
    case 'turn/completed': {
      emitAll(threadId, { type: 'turn/end', seq: 0 })
      const u = lastUsageByThread.get(threadId)
      if (u) {
        const t = u.last || u.total || {}
        emitAll(threadId, { type: 'usage', seq: 0, data: { tokens: { input: t.input_tokens || 0, output: t.output_tokens || 0, total: t.total_tokens || 0, cached: t.cached_input_tokens || 0 } } })
        emitAll(threadId, {
          type: 'assistant/message', seq: 999002,
          data: { message: { content: `📊 本轮用量：输入 ${((t.input_tokens || 0) / 1000).toFixed(1)}k · 输出 ${((t.output_tokens || 0) / 1000).toFixed(1)}k` + (t.cached_input_tokens ? ` · 缓存 ${(t.cached_input_tokens / 1000).toFixed(1)}k` : '') } }
        })
      }
      break
    }
    case 'thread/name/updated':
      if (p.threadName) emitAll(threadId, { type: 'session/title', seq: 0, data: { title: p.threadName } })
      break
    case 'error':
      emitAll(threadId, { type: 'assistant/message', seq: 999003, data: { message: { content: `❌ agent 错误：${p.error?.message || '未知'}` } } })
      break
    default:
      break // thread/started、item/reasoning/* 等暂不映射
  }
}
const acc = new Map()
function respondApproval (rpcId, decision) {
  try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: { decision } }) + '\n') } catch { }
}

// ---------- snapshot（L1：thread/read → turns/items 平铺） ----------
async function buildSnapshot (threadId, st) {
  const r = await rpc('thread/read', { threadId }).catch(() => null)
  const records = []
  let cursor = 0
  const pushText = (mid, role, text) => {
    if (!text) return
    const seq = seqFor(threadId, mid)
    records.push(role === 'user'
      ? { type: 'event', event: { type: 'user/message', seq, data: { content: text } } }
      : { type: 'event', event: { type: 'assistant/message', seq, data: { message: { content: text } } } })
  }
  const thread = r?.thread || r?.data?.thread
  if (thread?.name) records.push({ type: 'event', event: { type: 'session/title', seq: 0, data: { title: thread.name } } })
  for (const turn of thread?.turns || []) {
    for (const it of turn.items || []) {
      if (it.type === 'userMessage') pushText(it.id, 'user', (it.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
      else if (it.type === 'agentMessage') pushText(it.id, 'assistant', it.text || '')
      else if (it.type === 'commandExecution') pushText(it.id, 'assistant', `🔧 **命令**\n\`\`\`\n${(it.command || '').slice(0, 500)}\n\`\`\``)
    }
  }
  // cursor：取最大 seq
  for (const rec of records) cursor = Math.max(cursor, rec.event.seq || 0)
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
      value: { type: 'snapshot', header: { id: sessionId, cwd: 'codex' }, cursor, records }
    }))
    followers.add({ sock, streamId: msg.streamId, sessionId, st })
    log(`follow snapshot：thread=${sessionId} records=${records.length} cursor=${cursor}`)
  }).catch((e) => {
    wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'upstream-error', message: e.message }))
  })
}

// ---------- HTTP 面 ----------
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
      const r = await rpc('thread/list', { limit: 50, sortKey: 'updated_at', sortDirection: 'desc' })
      const threads = r.threads || r.data?.threads || []
      wrap({
        items: threads.map((t) => ({
          sessionId: t.id,
          updatedAt: t.updatedAt || t.updated_at,
          cwd: t.cwd,
          agentAvailable: true,
          running: false,
          title: t.name || t.preview || undefined
        }))
      })
    } else if (req.url === '/api/session/create') {
      const r = await rpc('thread/start', { cwd: CWD, approvalPolicy: 'on-request', sandbox: 'workspace-write' })
      const t = r.thread || r.data?.thread
      wrap({ sessionId: t.id })
    } else if (req.url === '/api/session/prompt') {
      const r = parsed.payload?.args?.request || parsed.request || {}
      if (!r.sessionId) return fail('缺 sessionId')
      const text = (r.content || []).map((c) => c.text || '').join('').trim()
      // L3 审批拦截
      const pendingA = pendingBySession.get(r.sessionId)
      if (pendingA && Date.now() < pendingA.expires) {
        const lower = text.toLowerCase()
        const always = ['总是批准', '全部批准', 'always'].some((w) => lower === w || lower.startsWith(w))
        const yes = always || ['批准', '允许', '同意', 'yes', 'ok', 'y'].some((w) => lower === w || lower.startsWith(w))
        const no = ['拒绝', '不同意', '不允许', 'no', 'n'].some((w) => lower === w || lower.startsWith(w))
        if (yes || no) {
          pendingBySession.delete(r.sessionId)
          respondApproval(pendingA.rpcId, always ? 'acceptForSession' : (yes ? 'accept' : 'decline'))
          return wrap({ approval: always ? 'always' : (yes ? 'once' : 'reject') })
        }
        // 非审批指令 → 拒掉 pending 继续对话
        pendingBySession.delete(r.sessionId)
        respondApproval(pendingA.rpcId, 'decline')
      }
      await rpc('turn/start', { threadId: r.sessionId, input: [{ type: 'text', text }] })
      wrap({})
    } else if (req.url === '/api/session/approve') {
      const r = parsed.payload?.args?.request || parsed.request || {}
      const pendingA = pendingBySession.get(r.sessionId)
      if (!pendingA || Date.now() >= pendingA.expires) return fail('无待审批请求')
      pendingBySession.delete(r.sessionId)
      const decision = r.response === 'reject' ? 'decline' : (r.response === 'always' ? 'acceptForSession' : 'accept')
      respondApproval(pendingA.rpcId, decision)
      wrap({ approval: r.response === 'reject' ? 'reject' : (r.response === 'always' ? 'always' : 'once') })
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
  log(`P4 codex-bridge 就绪: http://127.0.0.1:${PORT}（内核 codex app-server，cwd ${CWD}）`)
  ensureChild()
})
