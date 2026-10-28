// 轻量 Agent 桥共享外壳：页面、会话台账、HTTP/WS、动态审批；原生能力由各 driver 提供。
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { chatShellHtml } from '../chat-shell.mjs'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const APPROVAL_TTL = 120_000
const validSessionId = (id) => /^[a-zA-Z0-9_-]{1,80}$/.test(String(id || ''))
const wsAccept = (key) => createHash('sha1').update(key + WS_GUID).digest('base64')

function wsSend (sock, text) {
  const payload = Buffer.from(text, 'utf8')
  let header
  if (payload.length < 126) { header = Buffer.alloc(2); header[1] = payload.length } else if (payload.length < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(payload.length, 2) } else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2) }
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

export function startLightBridge ({ label, port, cwd, regDir, driver, workspaces = [], log = () => {} }) {
  fs.mkdirSync(regDir, { recursive: true })
  const workspaceFile = path.join(regDir, 'workspaces.json')
  const configuredWorkspaces = (workspaces.length ? workspaces : [{ id: 'default', name: path.basename(cwd) || cwd, cwd }]).map((item, index) => ({
    id: String(item.id || `workspace-${index + 1}`), name: String(item.name || item.id || path.basename(item.cwd) || '工作区'), cwd: path.resolve(item.cwd || cwd)
  }))
  const workspaceItems = [...configuredWorkspaces]
  try {
    const saved = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'))
    for (const item of saved.items || []) {
      if (!item || typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd)) continue
      if (workspaceItems.some((existing) => existing.id === item.id || existing.cwd === path.resolve(item.cwd))) continue
      workspaceItems.push({ id: String(item.id || randomUUID()), name: String(item.name || '工作区').slice(0, 60), cwd: path.resolve(item.cwd) })
    }
  } catch { /* 首次启动或配置损坏时使用启动参数 */ }
  const persistWorkspaces = () => fs.writeFileSync(workspaceFile, JSON.stringify({ items: workspaceItems }, null, 2))
  const workspaceFor = (id, sessionCwd) => workspaceItems.find((item) => item.id === id) || workspaceItems.find((item) => item.cwd === sessionCwd) || workspaceItems[0]
  const followers = new Set()
  const running = new Set()
  const pending = new Map()
  const currentPrompts = new Map()
  const recovering = new Map()
  const seqGlobal = new Map()
  const models = new Map()
  let defaultModel = 'default'
  const regFile = (id) => path.join(regDir, id + '.jsonl')
  const approvalFile = (sid, reqId) => path.join(regDir, `${sid}.${createHash('sha256').update(reqId).digest('hex').slice(0, 16)}.approval.json`)
  const persistApproval = (item) => fs.writeFileSync(approvalFile(item.sid, item.reqId), JSON.stringify({
    sid: item.sid, reqId: item.reqId, expires: item.expires, data: item.data,
    prompt: item.prompt || currentPrompts.get(item.sid) || ''
  }))
  const removeApproval = (item) => {
    pending.delete(`${item.sid}:${item.reqId}`)
    if (item.timer) clearTimeout(item.timer)
    try { fs.unlinkSync(approvalFile(item.sid, item.reqId)) } catch { }
  }
  function armApproval (item) {
    item.timer = setTimeout(async () => {
      if (!pending.has(`${item.sid}:${item.reqId}`)) return
      removeApproval(item)
      try { await item.respond?.({ cancelled: true, response: 'reject' }) } catch { }
    }, Math.max(0, item.expires - Date.now()))
    item.timer.unref()
  }
  const sameOperation = (a, b) => a.permission === b.permission && a.command === b.command
  const append = (id, value) => fs.appendFileSync(regFile(id), JSON.stringify(value) + '\n')
  const read = (id) => {
    if (!validSessionId(id) || !fs.existsSync(regFile(id))) return null
    let meta = {}
    const messages = []
    for (const line of fs.readFileSync(regFile(id), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (row.session) meta = { ...meta, ...row.session }
        if (row.role && typeof row.text === 'string') messages.push(row)
      } catch { /* 保留其它完整行 */ }
    }
    return { meta, messages }
  }
  const updateMeta = (id, patch) => append(id, { session: { ...read(id)?.meta, ...patch } })
  const seqFor = (sid, mid) => {
    let state = seqGlobal.get(sid)
    if (!state) { state = { map: new Map(), next: 1 }; seqGlobal.set(sid, state) }
    const key = String(mid)
    if (!state.map.has(key)) state.map.set(key, state.next++ * 2 + 1)
    return state.map.get(key)
  }
  const emit = (f, event) => {
    try { wsSend(f.sock, JSON.stringify({ type: 'item', streamId: f.streamId, value: { type: 'event', event } })) } catch { followers.delete(f) }
  }
  const emitAll = (sid, event) => {
    for (const f of [...followers]) if (f.sessionId === sid && !f.sock.destroyed) emit(f, event)
  }
  const text = (sid, mid, value, final = false) => {
    if (typeof value !== 'string') return
    emitAll(sid, { type: 'assistant/message', seq: seqFor(sid, mid), data: { message: { content: value } } })
    if (final && value) {
      const reg = read(sid)
      if (!reg?.messages.some((m) => m.mid === String(mid))) append(sid, { role: 'assistant', text: value, mid: String(mid), ts: Date.now() })
    }
  }
  const end = (sid, error) => {
    const wasRunning = running.delete(sid)
    if (error) text(sid, 'error-' + randomUUID(), '❌ ' + (error.message || error), true)
    if (wasRunning || error) emitAll(sid, { type: 'turn/end', seq: 0 })
  }
  const hooks = {
    text,
    end,
    nativeSession: (sid, nativeId) => { if (nativeId) updateMeta(sid, { nativeId }) },
    getSession: (sid) => read(sid),
    title: (sid, title) => {
      if (!title) return
      updateMeta(sid, { title: String(title).slice(0, 120) })
      emitAll(sid, { type: 'session/title', seq: 0, data: { title: String(title) } })
    },
    approval: (sid, request) => {
      const reqId = String(request.id)
      const key = `${sid}:${reqId}`
      const options = (request.options || []).map((o) => ({ optionId: String(o.optionId), label: o.label || o.name || o.optionId, kind: o.kind }))
      const data = { reqId, permission: request.permission || '操作', command: request.command || '', options }
      const recovery = recovering.get(sid)
      if (recovery && sameOperation(recovery.item.data, data)) {
        recovering.delete(sid)
        removeApproval(recovery.item)
        Promise.resolve(request.respond(recovery.choice)).catch((error) => end(sid, error))
        return
      }
      if (recovery) recovering.delete(sid)
      const item = {
        sid, reqId, respond: request.respond, expires: Date.now() + APPROVAL_TTL,
        prompt: currentPrompts.get(sid) || '', recovered: false, data
      }
      pending.set(key, item)
      persistApproval(item)
      emitAll(sid, { type: 'approval/request', seq: 0, data: item.data })
      armApproval(item)
    }
  }
  for (const file of fs.readdirSync(regDir).filter((name) => name.endsWith('.approval.json'))) {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(regDir, file), 'utf8'))
      if (!validSessionId(saved.sid) || !saved.reqId || !saved.data || !Number.isFinite(saved.expires)) continue
      const item = { ...saved, reqId: String(saved.reqId), recovered: true, respond: null }
      if (item.expires <= Date.now()) { try { fs.unlinkSync(path.join(regDir, file)) } catch { }; continue }
      pending.set(`${item.sid}:${item.reqId}`, item)
      armApproval(item)
    } catch { /* 忽略损坏的审批台账，不影响会话恢复 */ }
  }
  driver.attach?.(hooks)

  function snapshot (sid) {
    const reg = read(sid)
    const records = []
    let cursor = 0
    if (reg?.meta.title) records.push({ type: 'event', event: { type: 'session/title', seq: 0, data: { title: reg.meta.title } } })
    for (const m of reg?.messages || []) {
      const mid = m.mid || `${m.role}-${m.ts}`
      const seq = seqFor(sid, mid)
      cursor = Math.max(cursor, seq)
      records.push(m.role === 'user'
        ? { type: 'event', event: { type: 'user/message', seq, data: { content: m.text } } }
        : { type: 'event', event: { type: 'assistant/message', seq, data: { message: { content: m.text } } } })
    }
    for (const item of pending.values()) {
      if (item.sid === sid) records.push({ type: 'event', event: { type: 'approval/request', seq: 0, data: item.data } })
    }
    return { records, cursor }
  }
  function handleMuxOpen (msg, sock) {
    const sid = msg.payload?.args?.request?.address?.sessionId
    if (msg.endpoint !== 'session/follow' || !validSessionId(sid)) {
      wsSend(sock, JSON.stringify({ type: 'error', streamId: msg.streamId, code: 'bad-address', message: '无效 session/follow 地址' }))
      return
    }
    const { records, cursor } = snapshot(sid)
    wsSend(sock, JSON.stringify({ type: 'item', streamId: msg.streamId, value: { type: 'snapshot', header: { id: sid, cwd: read(sid)?.meta.cwd || cwd, running: running.has(sid) }, cursor, records } }))
    followers.add({ sock, streamId: msg.streamId, sessionId: sid })
  }

  const server = http.createServer(async (req, res) => {
    const json = (status, value) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      const html = Buffer.from(chatShellHtml(label, { alwaysApproval: false }))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': html.length })
      return res.end(html)
    }
    if (req.method !== 'POST' || !req.url.startsWith('/api/')) return json(404, { error: 'not found' })
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 2_000_000) return json(413, { error: 'request too large' })
    }
    let parsed = {}
    try { parsed = JSON.parse(body || '{}') } catch { }
    const rpcId = parsed.rpcId
    const request = parsed.payload?.args?.request || parsed.request || {}
    const wrap = (value) => json(200, { type: 'server-response', rpcId, result: { ok: true, value } })
    const fail = (message) => json(200, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'bridge-error', message } } })
    try {
      if (req.url === '/api/workspace/list') {
        wrap({ items: workspaceItems })
      } else if (req.url === '/api/workspace/create') {
        const name = String(request.name || '').trim()
        const requestedCwd = String(request.cwd || '').trim()
        if (!name || name.length > 60) return fail('工作区名称须为 1–60 个字符')
        if (!requestedCwd || requestedCwd.length > 500 || !path.isAbsolute(requestedCwd)) return fail('请输入电脑中已有目录的绝对路径')
        const canonicalCwd = path.resolve(requestedCwd)
        const duplicate = workspaceItems.find((item) => item.cwd === canonicalCwd)
        if (duplicate) return wrap(duplicate)
        let stat
        try { stat = fs.statSync(canonicalCwd) } catch { return fail('目录不存在，请先在电脑上创建') }
        if (!stat.isDirectory()) return fail('路径不是目录')
        const workspace = { id: 'workspace-' + randomUUID(), name, cwd: canonicalCwd }
        workspaceItems.push(workspace)
        persistWorkspaces()
        wrap(workspace)
      } else if (req.url === '/api/session/list') {
        const items = fs.readdirSync(regDir).filter((f) => f.endsWith('.jsonl')).map((file) => {
          const sid = path.basename(file, '.jsonl')
          const reg = read(sid)
          const sessionCwd = reg?.meta.cwd || cwd
          const workspace = workspaceFor(reg?.meta.workspaceId, sessionCwd)
          return { sessionId: sid, title: reg?.meta.title || '新对话', cwd: sessionCwd, workspaceId: workspace.id, updatedAt: Math.floor(fs.statSync(regFile(sid)).mtimeMs), blank: !reg?.messages.some((m) => m.role === 'user'), agentAvailable: true, running: running.has(sid) }
        }).sort((a, b) => b.updatedAt - a.updatedAt)
        wrap({ items })
      } else if (req.url === '/api/session/create') {
        const sid = randomUUID()
        const model = request.model || defaultModel
        const workspace = workspaceItems.find((item) => item.id === request.workspaceId)
        if (request.workspaceId && !workspace) return fail('工作区不存在')
        const selectedWorkspace = workspace || workspaceItems[0]
        append(sid, { session: { id: sid, title: '新对话', cwd: selectedWorkspace.cwd, workspaceId: selectedWorkspace.id, createdAt: Date.now(), model } })
        models.set(sid, model)
        wrap({ sessionId: sid, workspaceId: selectedWorkspace.id })
      } else if (req.url === '/api/model/list') {
        const sid = request.sessionId
        if (sid && !read(sid)) return fail('会话不存在')
        const result = await driver.listModels(sid, models.get(sid) || read(sid)?.meta.model || defaultModel)
        const items = result.items?.length ? result.items : [{ id: 'default', name: `${label} 默认模型` }]
        const selected = result.selected || models.get(sid) || items[0].id
        if (sid) { models.set(sid, selected); updateMeta(sid, { model: selected }) } else defaultModel = selected
        wrap({ items, selected })
      } else if (req.url === '/api/model/select') {
        const sid = request.sessionId
        if (!read(sid) || !request.model) return fail('缺有效 sessionId 或 model')
        const available = await driver.listModels(sid, models.get(sid) || defaultModel)
        if (available.items?.length && !available.items.some((m) => m.id === request.model)) return fail('模型不可用: ' + request.model)
        await driver.selectModel(sid, request.model)
        models.set(sid, request.model)
        updateMeta(sid, { model: request.model })
        wrap({ selected: request.model })
      } else if (req.url === '/api/session/prompt') {
        const sid = request.sessionId
        const value = (request.content || []).map((c) => c.text || '').join('').trim()
        if (!read(sid)) return fail('会话不存在')
        if (!value) return fail('消息不能为空')
        if (running.has(sid)) return fail('当前轮次仍在运行')
        const reg = read(sid)
        append(sid, { role: 'user', text: value, mid: 'u-' + randomUUID(), ts: Date.now() })
        if (!reg.messages.some((m) => m.role === 'user')) hooks.title(sid, value.slice(0, 24))
        emitAll(sid, { type: 'user/message', seq: seqFor(sid, 'u-' + randomUUID()), data: { content: value } })
        currentPrompts.set(sid, value)
        running.add(sid)
        emitAll(sid, { type: 'turn/start', seq: 0 })
        try {
          await driver.prompt(sid, value, models.get(sid) || reg.meta.model || defaultModel)
          wrap({ accepted: true })
        } catch (error) {
          end(sid, error)
          throw error
        }
      } else if (req.url === '/api/session/cancel') {
        const sid = request.sessionId
        if (!read(sid)) return fail('会话不存在')
        recovering.delete(sid)
        for (const item of [...pending.values()]) {
          if (item.sid !== sid) continue
          removeApproval(item)
          try { await item.respond?.({ cancelled: true, response: 'reject' }) } catch { }
        }
        await driver.cancel(sid)
        if (running.has(sid)) end(sid)
        wrap({ accepted: true })
      } else if (req.url === '/api/session/approve') {
        const sid = request.sessionId
        const reqId = String(request.reqId || '')
        const key = `${sid}:${reqId}`
        const item = pending.get(key)
        if (!item || item.expires <= Date.now()) return fail('无待审批请求或请求已过期')
        const optionId = String(request.optionId || request.response || '')
        const selected = item.data.options.find((o) => o.optionId === optionId)
        if (item.data.options.length && !selected) return fail('审批选项无效')
        const rejected = optionId === 'reject' || request.response === 'reject' || selected?.kind?.startsWith('reject')
        if (item.recovered) {
          if (rejected) {
            removeApproval(item)
          } else {
            if (running.has(sid)) return fail('当前轮次仍在运行')
            const resume = `RECOVER_APPROVAL:${JSON.stringify({ permission: item.data.permission, command: item.data.command })}`
            recovering.set(sid, { item, choice: { response: request.response, optionId, cancelled: false } })
            currentPrompts.set(sid, resume)
            running.add(sid)
            emitAll(sid, { type: 'turn/start', seq: 0 })
            try {
              await driver.prompt(sid, resume, models.get(sid) || read(sid)?.meta.model || defaultModel)
            } catch (error) {
              recovering.delete(sid)
              end(sid, error)
              throw error
            }
          }
        } else {
          await item.respond({ response: request.response, optionId, cancelled: false })
          removeApproval(item)
        }
        wrap({ accepted: true, approval: optionId })
      } else if (req.url === '/api/session/page') {
        wrap({ records: [], cursor: 0, hasMore: false })
      } else if (req.url === '/api/agent/capabilities') {
        wrap(driver.capabilities || {})
      } else {
        fail('未知方法: ' + req.url)
      }
    } catch (error) { fail(error.message) }
  })
  server.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key']
    if (!key) { sock.destroy(); return }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`)
    let buf = Buffer.alloc(0)
    sock.on('data', (data) => {
      buf = Buffer.concat([buf, data])
      const parsed = wsParse(buf)
      buf = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.op === 8) { sock.end(); return }
        if (frame.op === 9) {
          const payload = Buffer.from(frame.text)
          if (payload.length < 126) { const h = Buffer.alloc(2); h[0] = 0x8a; h[1] = payload.length; sock.write(Buffer.concat([h, payload])) }
          continue
        }
        if (frame.op !== 1) continue
        try {
          const msg = JSON.parse(frame.text)
          if (msg.type === 'open') handleMuxOpen(msg, sock)
          if (msg.type === 'close') for (const f of [...followers]) if (f.streamId === msg.streamId) followers.delete(f)
        } catch { }
      }
    })
    sock.on('close', () => { for (const f of [...followers]) if (f.sock === sock) followers.delete(f) })
    sock.on('error', () => { })
  })
  server.on('close', () => { driver.close?.() })
  server.listen(port, '127.0.0.1', () => log(`${label} bridge 就绪: http://127.0.0.1:${port}`))
  return server
}
