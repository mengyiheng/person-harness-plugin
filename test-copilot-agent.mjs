// 通用独立 Agent 启动层 Copilot 驱动回归：
// 配置 CLI 启动 → 双工作区 cwd 隔离（进程 cwd）→ --session-id 固定会话（同 sid 跨轮复用，跨进程重建）→
// --model 下发 → 错误透传。使用 fake copilot（node fake.mjs），不访问真实模型、真实隧道或 dsh。
// 注意：Copilot print 模式无流式/动态审批/取消，Capabilities 如实声明。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-copilot-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const mainCwd = path.join(scratch, 'main')
const secondaryCwd = path.join(scratch, 'secondary')
fs.mkdirSync(mainCwd)
fs.mkdirSync(secondaryCwd)
const fakeLog = path.join(scratch, 'fake-copilot.jsonl')
const home = path.join(scratch, 'home-copilot')

const waitFor = async (predicate, label, timeout = 10000) => {
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

const fakeScript = path.resolve('diagnostics/fake-copilot-cli.mjs')
const configOptions = {
  name: 'copilot-one', label: 'Copilot One', cwd: '.',
  home,
  workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
  driver: {
    type: 'copilot',
    command: process.execPath,
    args: [fakeScript],
    models: ['gpt-5', 'claude-sonnet'],
    env: { FAKE_COPILOT_LOG: fakeLog }
  }
}
const children = []
const childLogs = []
const sockets = []

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT:', error, error.stack, '\nAGENT LOGS:', childLogs.map((dump) => dump().slice(-1200)).join('\n===\n'))
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  console.error('UNHANDLED REJECTION:', error, '\nAGENT LOGS:', childLogs.map((dump) => dump().slice(-1200)).join('\n===\n'))
  process.exit(1)
})

async function startConfiguredAgent () {
  const file = path.join(scratch, 'copilot-one.json')
  fs.writeFileSync(file, JSON.stringify({ ...configOptions, port: await freePort() }, null, 2))
  const child = spawn(process.execPath, ['lib/p4/agent.mjs', '--config', file, '--no-tunnel'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_COPILOT_LOG: fakeLog }
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  childLogs.push(() => log)
  await waitFor(() => log.includes('独立 Agent 已就绪') || child.exitCode != null, 'copilot agent ready')
  assert.equal(child.exitCode, null, log)
  const port = JSON.parse(fs.readFileSync(file, 'utf8')).port
  const origin = `http://127.0.0.1:${port}`
  await waitFor(async () => { try { return (await fetch(origin)).status === 200 } catch { return false } }, 'bridge http ready', 10000)
  return { child, origin, log: () => log }
}
async function rpc (agent, method, request = {}) {
  const response = await fetch(`${agent.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(10000)
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

try {
  let agent = await startConfiguredAgent()
  const capabilities = await rpc(agent, 'agent/capabilities')
  assert.equal(capabilities.transport, 'copilot -p（非交互 print）')
  assert.match(await fetch(agent.origin).then((response) => response.text()), /Copilot One · Person Harness/)

  // 1. 双工作区：每轮 copilot 进程以各自 cwd 启动，同一会话固定同一 --session-id
  const first = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const second = await rpc(agent, 'session/create', { workspaceId: 'main' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(fs.existsSync(path.join(home, 'sessions', first.sessionId + '.jsonl')))

  const firstEvents = await follow(agent, first.sessionId)
  const secondEvents = await follow(agent, second.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'from-copilot' }] })
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: 'from-copilot-main' }] })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content?.includes('Copilot 回复：from-copilot')), 'copilot secondary reply')
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content?.includes('from-copilot-main')), 'copilot main reply')
  const starts = rows(fakeLog).filter((row) => row.start)
  const firstSessionStarts = starts.filter((row) => row.start.cwd === secondaryCwd)
  assert.equal(firstSessionStarts.length, 1, 'Secondary 会话首轮一进程')
  assert.ok(firstSessionStarts[0].start.sessionId, '--session-id 必须携带')

  // 2. 第二轮：同 sid 必须复用同一 --session-id
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '第二轮' }] })
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'second turn finished')
  const secondStart = rows(fakeLog).filter((row) => row.start?.cwd === secondaryCwd && row.start.prompt === '第二轮')
  assert.equal(secondStart.length, 1, '第二轮一进程')
  assert.equal(secondStart[0].start.sessionId, firstSessionStarts[0].start.sessionId, '同会话必须复用同一 session id')
  assert.ok(fs.readFileSync(path.join(home, 'sessions', first.sessionId + '.jsonl'), 'utf8').includes('nativeId'), 'session id 必须落台账 nativeId')

  // 3. 模型：配置列表 + --model 下发
  const models = await rpc(agent, 'model/list', { sessionId: first.sessionId })
  assert.deepEqual(models.items.map((m) => m.id), ['gpt-5', 'claude-sonnet'])
  await rpc(agent, 'model/select', { sessionId: first.sessionId, model: 'claude-sonnet' })
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'with-model' }] })
  await waitFor(() => rows(fakeLog).some((row) => row.start?.model === 'claude-sonnet'), '--model forwarded')
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'with-model turn finished')

  // 4. 错误透传：非零退出 + stderr Error 提取
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: '失败一下' }] })
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content?.includes('❌') && event.data?.message?.content?.includes('受控失败')), 'error surfaced')

  // 5. 重启后会话续用：nativeId 落台账 → 新进程以同一 --session-id 恢复
  const oldChildren = [...children]
  for (const child of oldChildren) if (child.exitCode == null) child.kill()
  children.length = 0
  for (const ws of sockets) try { ws.close() } catch { }
  sockets.length = 0
  const exited = (child) => new Promise((resolve) => child.once('exit', resolve))
  await Promise.all(oldChildren.map((child) => child.exitCode == null ? exited(child) : null))
  agent = await startConfiguredAgent()
  const resumedEvents = await follow(agent, first.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '重启后续聊' }] })
  await waitFor(() => resumedEvents.some((event) => event.data?.message?.content?.includes('重启后续聊')), 'post-restart reply')
  const restartStarts = rows(fakeLog).filter((row) => row.start?.prompt === '重启后续聊')
  assert.equal(restartStarts.length, 1, '重启后一轮一进程')
  assert.equal(restartStarts[0].start.sessionId, firstSessionStarts[0].start.sessionId, '重启后必须复用台账 nativeId 作 session id')

  console.log('copilot-agent: generic launch layer + copilot driver (workspaces/session-id/models/error/restart) passed')
} finally {
  for (const ws of sockets) try { ws.close() } catch { }
  for (const child of children) if (child.exitCode == null) child.kill()
}
