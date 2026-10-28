import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-next-agent-bridges')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const claudeLog = path.join(scratch, 'claude.jsonl')
const acpLog = path.join(scratch, 'acp.jsonl')
const sockets = []
let claude
let acp

async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
async function waitFor (predicate, label, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时: ' + label)
}
async function startBridge (file, extra, env, readyText) {
  const port = await freePort()
  const child = spawn(process.execPath, [file, '--port', String(port), ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  await waitFor(() => log.includes(readyText) || child.exitCode != null, file + ' ready')
  assert.equal(child.exitCode, null, log)
  return { child, port, origin: `http://127.0.0.1:${port}`, log: () => log }
}
async function stopBridge (bridge) {
  if (!bridge || bridge.child.exitCode != null) return
  const exited = new Promise((resolve) => bridge.child.once('exit', resolve))
  bridge.child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
}
async function request (bridge, method, body = {}) {
  const response = await fetch(`${bridge.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: method, payload: { args: { request: body } } }),
    signal: AbortSignal.timeout(6000)
  })
  return response.json()
}
async function rpc (bridge, method, body = {}) {
  const msg = await request(bridge, method, body)
  assert.equal(msg.result.ok, true, `${method}: ${JSON.stringify(msg.result.error)}\n${bridge.log()}`)
  return msg.result.value
}
async function follow (bridge, sessionId) {
  const events = []
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let snapshot
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.value?.type === 'snapshot') snapshot = msg.value
    if (msg.value?.type === 'event') events.push(msg.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow-' + sessionId, endpoint: 'session/follow', payload: { args: { request: { address: { sessionId } } } } }))
  await waitFor(() => snapshot, 'snapshot ' + sessionId)
  sockets.push(ws)
  return { ws, events, snapshot: () => snapshot }
}
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
function cleanupAcp () {
  for (const row of rows(acpLog)) {
    if (row.kind === 'argv') { try { process.kill(row.pid) } catch { } }
  }
}
const assistantHistory = (snapshot) => snapshot.records.filter((r) => r.event?.type === 'assistant/message' && !r.event.data.message.content.startsWith('❌'))

try {
  const claudeReg = path.join(scratch, 'claude-reg')
  claude = await startBridge('lib/p4/claude-bridge.mjs', [
    '--reg', claudeReg, '--cwd', scratch,
    '--sdk', path.resolve('diagnostics/fake-claude-agent-sdk.mjs')
  ], { FAKE_CLAUDE_LOG: claudeLog }, 'Claude Code bridge 就绪')
  const claudePage = await fetch(claude.origin + '/').then((r) => r.text())
  assert.match(claudePage, /Claude Code · Person Harness/)
  assert.doesNotMatch(claudePage, /\/__ph\/devices|\/__ph\/webos/)
  assert.equal((await rpc(claude, 'agent/capabilities')).transport, '@anthropic-ai/claude-agent-sdk')

  const c1 = await rpc(claude, 'session/create')
  const c2 = await rpc(claude, 'session/create')
  assert.notEqual(c1.sessionId, c2.sessionId)
  const blankItems = (await rpc(claude, 'session/list')).items
  assert.ok(blankItems.every((item) => item.blank === true), '未发用户消息的新会话必须标记为空白')
  const cm = await rpc(claude, 'model/list', { sessionId: c1.sessionId })
  assert.equal(cm.items.length, 2, JSON.stringify(cm) + '\n' + claude.log())
  await rpc(claude, 'model/select', { sessionId: c1.sessionId, model: 'haiku-test' })
  const cf1 = await follow(claude, c1.sessionId)
  await rpc(claude, 'session/prompt', { sessionId: c1.sessionId, content: [{ type: 'text', text: '第一条' }] })
  await waitFor(() => cf1.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Claude 回复：第一条'), 'Claude first session reply')
  await waitFor(() => cf1.events.some((e) => e.type === 'turn/end'), 'Claude first turn end')

  await rpc(claude, 'model/list', { sessionId: c2.sessionId })
  const cf2 = await follow(claude, c2.sessionId)
  await rpc(claude, 'session/prompt', { sessionId: c2.sessionId, content: [{ type: 'text', text: 'approve' }] })
  const ca = await waitFor(() => cf2.events.find((e) => e.type === 'approval/request'), 'Claude approval')
  assert.deepEqual(ca.data.options.map((o) => o.optionId), ['once', 'reject'])
  await rpc(claude, 'session/approve', { sessionId: c2.sessionId, reqId: ca.data.reqId, response: 'once' })
  await waitFor(() => cf2.events.some((e) => e.type === 'assistant/message' && e.data.message.content === '审批后回复'), 'Claude approved reply')
  await waitFor(() => cf2.events.some((e) => e.type === 'turn/end'), 'Claude approved turn end')
  await rpc(claude, 'session/prompt', { sessionId: c2.sessionId, content: [{ type: 'text', text: 'wait' }] })
  await rpc(claude, 'session/cancel', { sessionId: c2.sessionId })
  const claudeSessions = (await rpc(claude, 'session/list')).items
  assert.equal(claudeSessions.length, 2)
  assert.ok(claudeSessions.every((s) => s.blank === false), '已有用户消息的会话不得再标记为空白')
  assert.ok(claudeSessions.some((s) => s.title === '第一条'))
  const cqueries = rows(claudeLog).filter((r) => r.kind === 'query')
  assert.equal(cqueries.length, 2)
  assert.equal(new Set(cqueries.map((r) => r.options.sessionId)).size, 2, '两个新对话必须使用不同原生 session')
  assert.ok(cqueries.every((r) => r.options.sessionId && !r.options.resume))
  const c1Stored = await follow(claude, c1.sessionId)
  const c2Stored = await follow(claude, c2.sessionId)
  assert.deepEqual(assistantHistory(c1Stored.snapshot()).map((r) => r.event.data.message.content), ['Claude 回复：第一条'])
  assert.deepEqual(assistantHistory(c2Stored.snapshot()).map((r) => r.event.data.message.content), ['审批后回复', '等待停止'])
  assert.ok(rows(claudeLog).some((r) => r.kind === 'setModel' && r.model === 'haiku-test'))
  assert.ok(rows(claudeLog).some((r) => r.kind === 'interrupt'))
  await stopBridge(claude); claude = null

  const acpReg = path.join(scratch, 'acp-reg')
  const acpArgs = ['--reg', acpReg, '--cwd', scratch, '--command', process.execPath, '--args', JSON.stringify([path.resolve('diagnostics/fake-acp-agent.mjs'), 'acp'])]
  acp = await startBridge('lib/p4/acp-bridge.mjs', acpArgs, { FAKE_ACP_LOG: acpLog }, 'Kimi Code bridge 就绪')
  const acpPage = await fetch(acp.origin + '/').then((r) => r.text())
  assert.match(acpPage, /Kimi Code · Person Harness/)
  assert.equal((await rpc(acp, 'agent/capabilities')).dynamicApprovalOptions, true)
  const a1 = await rpc(acp, 'session/create')
  const a2 = await rpc(acp, 'session/create')
  assert.notEqual(a1.sessionId, a2.sessionId)
  const am = await rpc(acp, 'model/list', { sessionId: a1.sessionId })
  assert.equal(am.items.length, 2)
  await rpc(acp, 'model/select', { sessionId: a1.sessionId, model: 'kimi-test-b' })
  const af1 = await follow(acp, a1.sessionId)
  await rpc(acp, 'session/prompt', { sessionId: a1.sessionId, content: [{ type: 'text', text: 'hello' }] })
  await waitFor(() => af1.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Kimi 回复：hello'), 'ACP chunked reply')
  await waitFor(() => af1.events.some((e) => e.type === 'turn/end'), 'ACP first turn end')
  await rpc(acp, 'session/prompt', { sessionId: a1.sessionId, content: [{ type: 'text', text: 'again' }] })
  await waitFor(() => af1.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Kimi 回复：again'), 'ACP second turn')
  await waitFor(() => af1.events.filter((e) => e.type === 'turn/end').length >= 2, 'ACP second turn end')
  const af1History = await follow(acp, a1.sessionId)
  assert.equal(assistantHistory(af1History.snapshot()).length, 2, '两轮回复都必须保留')

  await rpc(acp, 'model/list', { sessionId: a2.sessionId })
  const af2 = await follow(acp, a2.sessionId)
  await rpc(acp, 'session/prompt', { sessionId: a2.sessionId, content: [{ type: 'text', text: 'approve' }] })
  const aa = await waitFor(() => af2.events.find((e) => e.type === 'approval/request'), 'ACP approval')
  assert.deepEqual(aa.data.options.map((o) => o.optionId), ['allow-once', 'allow-always', 'reject'])
  await rpc(acp, 'session/approve', { sessionId: a2.sessionId, reqId: aa.data.reqId, response: 'allow-always', optionId: 'allow-always' })
  await waitFor(() => af2.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Kimi 回复：approve'), 'ACP approved reply')
  await waitFor(() => af2.events.some((e) => e.type === 'turn/end'), 'ACP approved turn end')
  await rpc(acp, 'session/prompt', { sessionId: a2.sessionId, content: [{ type: 'text', text: 'wait' }] })
  await rpc(acp, 'session/cancel', { sessionId: a2.sessionId })
  await waitFor(() => rows(acpLog).some((r) => r.msg?.method === 'session/cancel'), 'ACP native cancel')
  const acpMessages = rows(acpLog).filter((r) => r.kind === 'message').map((r) => r.msg)
  const newIds = acpMessages.filter((m) => m.method === 'session/new').length
  assert.equal(newIds, 2)
  assert.ok(acpMessages.some((m) => m.result?.outcome?.optionId === 'allow-always'))
  assert.ok(acpMessages.some((m) => m.method === 'session/cancel'))
  assert.equal((await rpc(acp, 'session/list')).items.length, 2)
  const acpNativeIds = [a1, a2].map(({ sessionId }) => rows(path.join(acpReg, sessionId + '.jsonl')).filter((r) => r.session?.nativeId).at(-1)?.session.nativeId)
  assert.ok(acpNativeIds.every(Boolean))
  assert.equal(new Set(acpNativeIds).size, 2, '两个 ACP 新对话必须使用不同原生 session')
  const a2Stored = await follow(acp, a2.sessionId)
  assert.deepEqual(assistantHistory(a2Stored.snapshot()).map((r) => r.event.data.message.content), ['Kimi 回复：approve'])
  await stopBridge(acp); acp = null
  cleanupAcp()

  acp = await startBridge('lib/p4/acp-bridge.mjs', acpArgs, { FAKE_ACP_LOG: acpLog }, 'Kimi Code bridge 就绪')
  await rpc(acp, 'model/list', { sessionId: a1.sessionId })
  const resumedMessages = rows(acpLog).filter((r) => r.kind === 'message').map((r) => r.msg)
  assert.ok(resumedMessages.some((m) => m.method === 'session/load'), '重启后应走 session/load')
  const ar = await follow(acp, a1.sessionId)
  assert.equal(assistantHistory(ar.snapshot()).length, 2, 'load 回放不得重复写入历史')
  await rpc(acp, 'session/prompt', { sessionId: a1.sessionId, content: [{ type: 'text', text: 'resumed' }] })
  await waitFor(() => ar.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Kimi 回复：resumed'), 'ACP resumed prompt')
  console.log('next-agent-bridges: Claude SDK + generic ACP/Kimi new sessions, multi-turn, models, approvals, cancel, resume passed')
} finally {
  for (const ws of sockets) ws.close()
  await Promise.all([stopBridge(claude), stopBridge(acp)])
  cleanupAcp()
}
