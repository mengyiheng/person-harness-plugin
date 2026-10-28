// 通用独立 Agent 启动层 Cursor 驱动回归：
// 配置 CLI 启动 → 双工作区 cwd 隔离（进程 cwd）→ 流式回复 → chatId 续会话（--resume）→ 错误透传。
// 使用 fake cursor agent（cmd /c node fake.mjs），不访问真实模型、真实隧道或 dsh。
// 注意：Cursor print 模式无动态审批/取消，Capabilities 如实声明。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-cursor-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const mainCwd = path.join(scratch, 'main')
const secondaryCwd = path.join(scratch, 'secondary')
fs.mkdirSync(mainCwd)
fs.mkdirSync(secondaryCwd)
const fakeLog = path.join(scratch, 'fake-cursor.jsonl')
const home = path.join(scratch, 'home-cursor')

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

const fakeScript = path.resolve('diagnostics/fake-cursor-agent.mjs')
const configOptions = {
  name: 'cursor-one', label: 'Cursor One', cwd: '.',
  home,
  workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
  driver: {
    type: 'cursor',
    command: process.execPath,
    args: [fakeScript],
    models: ['gpt-5', 'sonnet-4-thinking'],
    env: { FAKE_CURSOR_LOG: fakeLog }
  }
}
const children = []
const childLogs = []
const sockets = []

process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT:', error, '\nAGENT LOGS:', childLogs.map((dump) => dump().slice(-1500)).join('\n===\n'))
  process.exit(1)
})

async function startConfiguredAgent () {
  const file = path.join(scratch, 'cursor-one.json')
  fs.writeFileSync(file, JSON.stringify({ ...configOptions, port: await freePort() }, null, 2))
  const child = spawn(process.execPath, ['lib/p4/agent.mjs', '--config', file, '--no-tunnel'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FAKE_CURSOR_LOG: fakeLog }
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  childLogs.push(() => log)
  await waitFor(() => log.includes('独立 Agent 已就绪') || child.exitCode != null, 'cursor agent ready')
  assert.equal(child.exitCode, null, log)
  const port = JSON.parse(fs.readFileSync(file, 'utf8')).port
  return { child, origin: `http://127.0.0.1:${port}`, log: () => log }
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
  assert.equal(capabilities.transport, 'cursor agent --print stream-json')
  assert.match(await fetch(agent.origin).then((response) => response.text()), /Cursor One · Person Harness/)

  // 1. 双工作区：每轮 cursor 进程必须以各自 cwd 启动
  const first = await rpc(agent, 'session/create', { workspaceId: 'secondary' })
  const second = await rpc(agent, 'session/create', { workspaceId: 'main' })
  assert.notEqual(first.sessionId, second.sessionId)
  assert.ok(fs.existsSync(path.join(home, 'sessions', first.sessionId + '.jsonl')))

  const firstEvents = await follow(agent, first.sessionId)
  const secondEvents = await follow(agent, second.sessionId)
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'from-cursor' }] })
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: 'from-cursor-main' }] })
  await waitFor(() => firstEvents.some((event) => event.data?.message?.content === '你好，世界'), 'cursor secondary reply')
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content === '你好，世界'), 'cursor main reply')
  const starts = rows(fakeLog).filter((row) => row.start)
  assert.ok(starts.some((row) => row.start.cwd === secondaryCwd && !row.start.resume), 'Secondary 会话首轮新会话')
  assert.ok(starts.some((row) => row.start.cwd === mainCwd && !row.start.resume), 'Main 会话首轮新会话')

  // 2. 第二轮 prompt 必须 --resume 首轮回传的 chatId
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: '第二轮' }] })
  const resumed = await waitFor(() => rows(fakeLog).filter((row) => row.start?.resume).length > 0, 'second turn --resume')
    .then(() => rows(fakeLog).filter((row) => row.start?.resume))
  assert.equal(resumed.length, 1, '第二轮必须 --resume')
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'second turn finished')
  assert.ok(fs.readFileSync(path.join(home, 'sessions', first.sessionId + '.jsonl'), 'utf8').includes('nativeId'), 'chatId 必须落台账 nativeId')

  // 3. 模型：配置列表 + --model 下发
  const models = await rpc(agent, 'model/list', { sessionId: first.sessionId })
  assert.deepEqual(models.items.map((m) => m.id), ['gpt-5', 'sonnet-4-thinking'])
  await rpc(agent, 'model/select', { sessionId: first.sessionId, model: 'sonnet-4-thinking' })
  await rpc(agent, 'session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'with-model' }] })
  await waitFor(() => rows(fakeLog).some((row) => row.start?.model === 'sonnet-4-thinking'), '--model forwarded')
  await waitFor(async () => !((await rpc(agent, 'session/list')).items.find((item) => item.sessionId === first.sessionId)?.running), 'with-model turn finished')

  // 4. 错误透传：非零退出 + stderr Error 提取
  await rpc(agent, 'session/prompt', { sessionId: second.sessionId, content: [{ type: 'text', text: '失败一下' }] })
  await waitFor(() => secondEvents.some((event) => event.data?.message?.content?.includes('❌') && event.data?.message?.content?.includes('受控失败')), 'error surfaced')

  console.log('cursor-agent: generic launch layer + cursor driver (workspaces/resume/models/error) passed')
} finally {
  for (const ws of sockets) try { ws.close() } catch { }
  for (const child of children) if (child.exitCode == null) child.kill()
}
