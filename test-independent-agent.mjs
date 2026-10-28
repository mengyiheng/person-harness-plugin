import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-independent-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const mainCwd = path.join(scratch, 'main')
const secondaryCwd = path.join(scratch, 'secondary')
fs.mkdirSync(mainCwd)
fs.mkdirSync(secondaryCwd)
const acpLog = path.join(scratch, 'acp.jsonl')
const claudeLog = path.join(scratch, 'claude.jsonl')
const children = []
const sockets = []

const waitFor = async (predicate, label, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时: ' + label)
}
async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
async function startConfiguredAgent (config) {
  const port = config.port
  const file = path.join(scratch, config.name + '.json')
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  const child = spawn(process.execPath, ['lib/p4/agent.mjs', '--config', file, '--no-tunnel'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(config.driver.env || {}) }
  })
  children.push(child)
  let log = ''
  child.stdout.on('data', (data) => { log += data })
  child.stderr.on('data', (data) => { log += data })
  await waitFor(() => log.includes('独立 Agent 已就绪') || child.exitCode != null, config.name + ' ready')
  assert.equal(child.exitCode, null, log)
  return { child, port, origin: `http://127.0.0.1:${port}`, log: () => log }
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
  const acp = await startConfiguredAgent({
    name: 'acp-one', label: 'ACP One', port: await freePort(), cwd: '.',
    home: path.join(scratch, 'home-acp'),
    workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
    driver: { type: 'acp', command: process.execPath, args: [path.resolve('diagnostics/fake-acp-agent.mjs'), 'acp'], env: { FAKE_ACP_LOG: acpLog } }
  })
  const claude = await startConfiguredAgent({
    name: 'claude-one', label: 'Claude One', port: await freePort(), cwd: '.',
    home: path.join(scratch, 'home-claude'),
    workspaces: [{ id: 'main', name: 'Main', cwd: mainCwd }, { id: 'secondary', name: 'Secondary', cwd: secondaryCwd }],
    driver: { type: 'claude', sdkModule: path.resolve('diagnostics/fake-claude-agent-sdk.mjs'), env: { FAKE_CLAUDE_LOG: claudeLog } }
  })
  assert.match(await fetch(acp.origin).then((response) => response.text()), /ACP One · Person Harness/)
  assert.match(await fetch(claude.origin).then((response) => response.text()), /Claude One · Person Harness/)

  const a = await rpc(acp, 'session/create', { workspaceId: 'secondary' })
  const c = await rpc(claude, 'session/create', { workspaceId: 'secondary' })
  assert.notEqual(a.sessionId, c.sessionId)
  assert.equal((await rpc(acp, 'session/list')).items.length, 1)
  assert.equal((await rpc(claude, 'session/list')).items.length, 1)
  assert.ok(fs.existsSync(path.join(scratch, 'home-acp', 'sessions', a.sessionId + '.jsonl')))
  assert.ok(fs.existsSync(path.join(scratch, 'home-claude', 'sessions', c.sessionId + '.jsonl')))
  assert.ok(!fs.existsSync(path.join(scratch, 'home-acp', 'sessions', c.sessionId + '.jsonl')))

  const acpEvents = await follow(acp, a.sessionId)
  const claudeEvents = await follow(claude, c.sessionId)
  await rpc(acp, 'session/prompt', { sessionId: a.sessionId, content: [{ type: 'text', text: 'from-acp' }] })
  await rpc(claude, 'session/prompt', { sessionId: c.sessionId, content: [{ type: 'text', text: 'from-claude' }] })
  await waitFor(() => acpEvents.some((event) => event.data?.message?.content === 'Kimi 回复：from-acp'), 'generic ACP reply')
  await waitFor(() => claudeEvents.some((event) => event.data?.message?.content === 'Claude 回复：from-claude'), 'generic Claude reply')
  assert.ok(rows(acpLog).some((row) => row.msg?.method === 'session/new' && row.msg.params.cwd === secondaryCwd), 'ACP 必须使用会话工作区')
  assert.ok(rows(claudeLog).some((row) => row.kind === 'query' && row.options.cwd === secondaryCwd), 'Claude 必须使用会话工作区')
  assert.ok(!acpEvents.some((event) => event.data?.message?.content?.includes('from-claude')))
  assert.ok(!claudeEvents.some((event) => event.data?.message?.content?.includes('from-acp')))
  console.log('independent-agent: config CLI + ACP/Claude parallel instances + isolated homes/sessions/workspaces passed')
} finally {
  for (const ws of sockets) ws.close()
  for (const child of children) if (child.exitCode == null) child.kill()
  for (const row of rows(acpLog)) if (row.kind === 'argv') { try { process.kill(row.pid) } catch { } }
}
