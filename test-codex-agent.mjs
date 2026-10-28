// 通用独立 Agent 启动层 Codex 驱动回归：
// 配置 CLI 启动 → 双工作区 cwd 隔离 → 流式回复 → 模型列表/切换 → 取消 →
// 重启后审批恢复（thread/resume + 相同操作自动承接）。
// 全部使用 fake codex app-server，不访问真实模型、真实隧道或 dsh。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-codex-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const mainCwd = path.join(scratch, 'main')
const secondaryCwd = path.join(scratch, 'secondary')
fs.mkdirSync(mainCwd)
fs.mkdirSync(secondaryCwd)
const fakeCodexLog = path.join(scratch, 'fake-codex.jsonl')
const home = path.join(scratch, 'home-codex')
const configOptions = {
  name: 'codex-one', label: 'Codex One', cwd: '.',
  home,
  workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
  driver: { type: 'codex', command: process.execPath, args: [path.resolve('diagnostics/fake-codex-app-server.mjs'), 'app-server'], env: { FAKE_CODEX_LOG: fakeCodexLog } }
}
const children = []
const sockets = []
let port

const waitFor = async (predicate, label, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时: ' + label)
}
async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const value = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return value
}
async function startConfiguredAgent () {
  port = port || await freePort()
  const file = path.join(scratch, 'codex-one.json')
  fs.writeFileSync(file, JSON.stringify({ ...configOptions, port }, null, 2))
  const child = spawn(process.execPath, ['lib/p4/agent.mjs', '--config', file, '--no-tunnel'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(configOptions.driver.env || {}) }
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  await waitFor(() => log.includes('独立 Agent 已就绪') || child.exitCode != null, 'codex agent ready')
  assert.equal(child.exitCode, null, log)
  return { child, origin: `http://127.0.0.1:${port}`, log: () => log }
}
async function rpc (agent, method, request = {}) {
  const response = await fetch(`${agent.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(6000)
  })
  const message = await response.json()
  assert.equal(message.result.ok, true, `${method}: ${JSON.stringify(message.result.error)}\n${agent.log()}`)
  return message.result.value
}
async function follow (agent, sessionId) {
  const events = []
  const ws = new WebSocket(`${agent.origin.replace('http', 'ws')}/api/remote.mux`)
  sockets.push(ws)
  ws.addEventListener('error', () => { try { ws.close() } catch { } })
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.value?.type === 'snapshot') events.push(...message.value.records.filter((row) => row.type === 'event').map((row) => row.event))
    if (message.value?.type === 'event') events.push(message.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow-' + sessionId, endpoint: 'session/follow', payload: { args: { request: { address: { sessionId } } } } }))
  return events
}
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []

try {
  const exited = (child) => new Promise((resolve) => child.once('exit', resolve))
  let agent = await startConfiguredAgent()
  const capabilities = await rpc(agent, 'agent/capabilities')
  assert.equal(capabilities.transport, 'codex app-server')

  assert.match(await fetch(agent.origin).then((response) => response.text()), /Codex One · Person Harness/)

  // 1. 双工作区：两个会话各自 thread/start 必须用各自 cwd
  const first = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const second = await rpc(agent, 'session/create', { workspaceId: 'main' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(fs.existsSync(path.join(home, 'sessions', first.sessionId + '.jsonl')))

  const firstEvents = await follow(agent, first.sessionId)
  const secondEvents = await follow(agent, second.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'from-codex' }] })
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: 'from-codex-main' }] })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content === '你好，世界'), 'codex secondary reply')
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content === '你好，世界'), 'codex main reply')
  const threadStarts = rows(fakeCodexLog).filter((row) => row.receive?.method === 'thread/start')
  assert.equal(threadStarts.length, 2, '每个会话一次 thread/start')
  assert.equal(threadStarts[0].receive.params.cwd, secondaryCwd, '第一个会话必须使用 Secondary 工作区')
  assert.equal(threadStarts[1].receive.params.cwd, mainCwd, '第二个会话必须使用 Main 工作区')

  // 2. 模型列表与切换
  const models = await rpc(agent, 'model/list', { sessionId: first.sessionId })
  assert.deepEqual(models.items.map((m) => m.id).sort(), ['model-a', 'model-b'])
  await rpc(agent, 'model/select', { sessionId: first.sessionId, model: 'model-b' })
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'with-model' }] })
  await waitFor(() => rows(fakeCodexLog).some((row) => row.receive?.method === 'turn/start' && row.receive.params.model === 'model-b'), 'turn/start with model-b')
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'with-model turn finished')
  assert.ok(rows(fakeCodexLog).some((row) => row.receive?.method === 'thread/resume'), '同一会话第二轮 prompt 应幂等 resume 原 thread')

  // 3. 动态审批：批准一次 → 决策回传 accept
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '审批 操作X' }] })
  await waitFor(() => firstEvents.some((event) => event.type === 'approval/request'), 'approval request')
  await rpc(agent, 'session/approve', { sessionId: first.sessionId, reqId: firstEvents.findLast((event) => event.type === 'approval/request').data.reqId, optionId: 'once', response: 'approve' })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content?.includes('· accept')), 'approval decision reply')
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.approval.json')).length, 0, '审批台账应清空')

  // 4. 取消运行中的轮次
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: '等待' }] })
  await waitFor(async () => (await rpc(agent, 'session/list')).items.find((item) => item.sessionId === second.sessionId)?.running, 'running state')
  await rpc(agent, 'session/cancel', { sessionId: second.sessionId })
  await waitFor(() => secondEvents.some((event) => event.type === 'turn/end'), 'turn end after cancel')

  // 5. 重启恢复：待审批落盘 → 关停 Agent 与 fake → 重启 → 快照恢复同一 reqId → 批准自动承接
  const recovery = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const recoveryEvents = await follow(agent, recovery.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: recovery.sessionId, content: [{ type: 'text', text: '审批 恢复操作' }] })
  const approval = await waitFor(() => recoveryEvents.find((event) => event.type === 'approval/request')?.data, 'recovery approval request')
  const approvalFile = fs.readdirSync(path.join(home, 'sessions')).find((name) => name.startsWith(recovery.sessionId) && name.endsWith('.approval.json'))
  assert.ok(approvalFile, '待审批必须落盘')

  const oldChildren = [...children]
  for (const child of oldChildren) if (child.exitCode == null) child.kill()
  children.length = 0
  for (const ws of sockets) try { ws.close() } catch { }
  sockets.length = 0
  await Promise.all(oldChildren.map((child) => child.exitCode == null ? exited(child) : null))
  agent = await startConfiguredAgent()
  await waitFor(async () => { try { return (await fetch(agent.origin)).status === 200 } catch { return false } }, 'restarted agent ready', 10000)
  const restoredEvents = await follow(agent, recovery.sessionId)
  const restored = await waitFor(
    () => restoredEvents.find((event) => event.type === 'approval/request' && event.data?.reqId === approval.reqId)?.data,
    'restored approval snapshot with same reqId'
  )
  assert.equal(restored.command, approval.command, '恢复的审批必须与原命令一致')
  await rpc(agent, 'session/approve', { sessionId: recovery.sessionId, reqId: approval.reqId, optionId: 'once', response: 'approve' })
  await waitFor(() => restoredEvents.some((event) => event.data?.message?.content?.includes('· accept')), 'recovered approval auto-carried reply')
  assert.ok(
    rows(fakeCodexLog).some((row) => row.receive?.method === 'turn/start' && row.receive.params.input?.[0]?.text?.startsWith('RECOVER_APPROVAL:')),
    '恢复路径必须通过 RECOVER_APPROVAL 重放原操作'
  )
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.approval.json')).length, 0, '恢复后审批台账应清空')

  console.log('codex-agent: generic launch layer + codex driver (workspaces/models/approval/cancel/restart-recovery) passed')
} finally {
  for (const ws of sockets) try { ws.close() } catch { }
  for (const child of children) if (child.exitCode == null) child.kill()
}
