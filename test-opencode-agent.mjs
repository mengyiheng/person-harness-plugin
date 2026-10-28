// 通用独立 Agent 启动层 OpenCode 驱动回归：
// 配置 CLI 启动 → 双工作区 directory 隔离 → 流式回复 → 模型列表/切换 → 审批 once → 取消 →
// 重启后审批恢复（同 reqId 快照 + 相同操作自动承接）。
// 全部使用 fake opencode serve（origin 模式），不访问真实模型、真实隧道或 dsh。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-opencode-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const mainCwd = path.join(scratch, 'main')
const secondaryCwd = path.join(scratch, 'secondary')
fs.mkdirSync(mainCwd)
fs.mkdirSync(secondaryCwd)
const fakeLog = path.join(scratch, 'fake-opencode.jsonl')
const home = path.join(scratch, 'home-opencode')

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
const rows = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []

let port = await freePort()
const fakeServer = spawn(process.execPath, [path.resolve('diagnostics/fake-opencode-server.mjs')], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, FAKE_OPENCODE_LOG: fakeLog, FAKE_OPENCODE_PORT: String(port) }
})
let fakeErr = ''
fakeServer.stderr.on('data', (data) => { fakeErr += data })
fakeServer.on('exit', (code) => { fakeErr += `\n[fake opencode exited code=${code}]` })
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT:', error, '\nFAKE STDERR:', fakeErr.slice(-1000), '\nAGENT LOGS:', childLogs.map((dump) => dump().slice(-1500)).join('\n===\n'))
  process.exit(1)
})
await waitFor(async () => {
  try { return (await fetch(`http://127.0.0.1:${port}/session`)).ok } catch { return false }
}, 'fake opencode ready')

const configOptions = {
  name: 'opencode-one', label: 'OpenCode One', cwd: '.',
  home,
  workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
  driver: { type: 'opencode', origin: `http://127.0.0.1:${port}`, env: {} }
}
const children = []
const childLogs = []
const sockets = []

async function startConfiguredAgent () {
  const file = path.join(scratch, 'opencode-one.json')
  fs.writeFileSync(file, JSON.stringify({ ...configOptions, port: await freePort() }, null, 2))
  const child = spawn(process.execPath, ['lib/p4/agent.mjs', '--config', file, '--no-tunnel'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env }
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  childLogs.push(() => log)
  await waitFor(() => log.includes('独立 Agent 已就绪') || child.exitCode != null, 'opencode agent ready')
  assert.equal(child.exitCode, null, log)
  const agentPort = JSON.parse(fs.readFileSync(file, 'utf8')).port
  const origin = `http://127.0.0.1:${agentPort}`
  // “已就绪”日志先于 HTTP listen；必须等真实端口可访问，避免启动竞态造成偶发 ECONNREFUSED / WS error。
  await waitFor(async () => {
    try { return (await fetch(origin)).ok } catch { return false }
  }, 'opencode agent HTTP ready')
  return { child, origin, log: () => log }
}
async function rpc (agent, method, request = {}) {
  const response = await fetch(`${agent.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(6000)
  })
  const message = await response.json()
  assert.equal(message.result.ok, true, `${method}: ${JSON.stringify(message.result.error)}\n${agent.log()}\n${fakeErr}`)
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

try {
  let agent = await startConfiguredAgent()
  const capabilities = await rpc(agent, 'agent/capabilities')
  assert.equal(capabilities.transport, 'opencode serve')
  assert.match(await fetch(agent.origin).then((response) => response.text()), /OpenCode One · Person Harness/)

  // 1. 双工作区：两个会话的 /session 创建必须携带各自 directory
  const first = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const second = await rpc(agent, 'session/create', { workspaceId: 'main' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(fs.existsSync(path.join(home, 'sessions', first.sessionId + '.jsonl')))

  const firstEvents = await follow(agent, first.sessionId)
  const secondEvents = await follow(agent, second.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'from-opencode' }] })
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: 'from-opencode-main' }] })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content === '你好，世界'), 'opencode secondary reply')
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content === '你好，世界'), 'opencode main reply')
  const created = rows(fakeLog).filter((row) => /^POST \/session(\?|$)/.test(row.send?.http || ''))
  assert.equal(created.length, 2, '每个会话一次 /session 创建')
  assert.ok(created.every((row) => row.send.status === 200), '/session 创建必须成功')
  const sessionCreates = rows(fakeLog).filter((row) => row.run)
  const runDirs = sessionCreates.map((row) => row.run.directory)
  assert.ok(runDirs.includes(secondaryCwd) && runDirs.includes(mainCwd), 'prompt 必须携带会话工作区 directory: ' + JSON.stringify(runDirs))

  // 2. 模型列表与切换（provider/model 联合 ID，随 prompt 下发）
  const models = await rpc(agent, 'model/list', { sessionId: first.sessionId })
  assert.deepEqual(models.items.map((m) => m.id).sort(), ['provider-a/model-a', 'provider-a/model-b'])
  assert.equal(models.selected, 'provider-a/model-a')
  await rpc(agent, 'model/select', { sessionId: first.sessionId, model: 'provider-a/model-b' })
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'with-model' }] })
  await waitFor(() => rows(fakeLog).some((row) => row.run?.model?.modelID === 'model-b'), 'prompt with model-b')
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'with-model turn finished')

  // 3. 动态审批：批准一次 → response 'once'
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '审批 操作X' }] })
  const approval = await waitFor(() => firstEvents.find((event) => event.type === 'approval/request')?.data, 'approval request')
  assert.equal(approval.permission, 'bash')
  await rpc(agent, 'session/approve', { sessionId: first.sessionId, reqId: approval.reqId, optionId: 'once', response: 'approve' })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content?.includes('· once')), 'approval once reply')
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.approval.json')).length, 0, '审批台账应清空')

  // 4. 取消运行中的轮次
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: '等待' }] })
  await waitFor(async () => (await rpc(agent, 'session/list')).items.find((item) => item.sessionId === second.sessionId)?.running, 'running state')
  await rpc(agent, 'session/cancel', { sessionId: second.sessionId })
  await waitFor(() => secondEvents.some((event) => event.type === 'turn/end'), 'turn end after cancel')

  // 5. 重启恢复：待审批落盘 → 关停 Agent → 重启 → 快照恢复同一 reqId → 批准自动承接
  const recovery = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const recoveryEvents = await follow(agent, recovery.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: recovery.sessionId, content: [{ type: 'text', text: '审批 恢复操作' }] })
  const recoveryApproval = await waitFor(() => recoveryEvents.find((event) => event.type === 'approval/request')?.data, 'recovery approval request')
  const approvalFile = fs.readdirSync(path.join(home, 'sessions')).find((name) => name.startsWith(recovery.sessionId) && name.endsWith('.approval.json'))
  assert.ok(approvalFile, '待审批必须落盘')

  const oldChildren = [...children]
  for (const child of oldChildren) if (child.exitCode == null) child.kill()
  children.length = 0
  for (const ws of sockets) try { ws.close() } catch { }
  sockets.length = 0
  const exited = (child) => new Promise((resolve) => child.once('exit', resolve))
  await Promise.all(oldChildren.map((child) => child.exitCode == null ? exited(child) : null))

  agent = await startConfiguredAgent()
  const restoredEvents = await follow(agent, recovery.sessionId)
  const restored = await waitFor(
    () => restoredEvents.find((event) => event.type === 'approval/request' && event.data?.reqId === recoveryApproval.reqId)?.data,
    'restored approval snapshot with same reqId'
  )
  assert.equal(restored.command, recoveryApproval.command, '恢复的审批必须与原命令一致')
  await rpc(agent, 'session/approve', { sessionId: recovery.sessionId, reqId: recoveryApproval.reqId, optionId: 'once', response: 'approve' })
  await waitFor(() => restoredEvents.some((event) => event.data?.message?.content?.includes('· once')), 'recovered approval auto-carried reply')
  assert.ok(
    rows(fakeLog).some((row) => row.run?.text?.startsWith('RECOVER_APPROVAL:')),
    '恢复路径必须通过 RECOVER_APPROVAL 重放原操作'
  )
  assert.equal(fs.readdirSync(path.join(home, 'sessions')).filter((name) => name.endsWith('.approval.json')).length, 0, '恢复后审批台账应清空')

  console.log('opencode-agent: generic launch layer + opencode driver (workspaces/models/approval/cancel/restart-recovery) passed')
} finally {
  for (const ws of sockets) try { ws.close() } catch { }
  for (const child of children) if (child.exitCode == null) child.kill()
  fakeServer.kill()
}
