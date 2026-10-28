import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-p4-cli-chat')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const fakeLogs = [path.join(scratch, 'pi-log.jsonl'), path.join(scratch, 'gemini-log.jsonl')]

async function freePort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function startBridge (file, extra, env = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, [file, '--port', String(port), ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  await waitFor(() => log.includes('就绪') || child.exitCode != null, file + ' ready')
  assert.equal(child.exitCode, null, log)
  return { child, port, origin: `http://127.0.0.1:${port}`, log: () => log }
}
async function stopBridge (bridge) {
  if (!bridge || bridge.child.exitCode != null) return
  const exited = new Promise((resolve) => bridge.child.once('exit', resolve))
  bridge.child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
}
async function waitFor (predicate, label, timeout = 7000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时: ' + label)
}
async function request (bridge, method, body = {}) {
  const res = await fetch(`${bridge.origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: method, payload: { args: { request: body } } }),
    signal: AbortSignal.timeout(5000)
  })
  return res.json()
}
async function rpc (bridge, method, body = {}) {
  const msg = await request(bridge, method, body)
  assert.equal(msg.result.ok, true, `${method}: ${JSON.stringify(msg.result.error)}`)
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
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId } } } } }))
  await waitFor(() => snapshot, 'snapshot')
  return { ws, events, snapshot: () => snapshot }
}
function readJsonLines (file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}
function cleanupFakeProcesses () {
  for (const file of fakeLogs) {
    for (const row of readJsonLines(file)) {
      const pid = row.pid
      if (pid) { try { process.kill(pid) } catch { } }
    }
  }
}

let pi
let gemini
const sockets = []
try {
  pi = await startBridge('lib/p4/pi-bridge.mjs', [
    '--node', process.execPath,
    '--pi', path.resolve('diagnostics/fake-pi-rpc.mjs'),
    '--sessions', path.join(scratch, 'pi-sessions'),
    '--cwd', scratch
  ], { FAKE_PI_LOG: fakeLogs[0] })
  const piPage = await fetch(pi.origin + '/').then((r) => r.text())
  assert.match(piPage, /Pi · Person Harness/)
  assert.match(piPage, /ALWAYS_APPROVAL=false/)
  const pc = await rpc(pi, 'session/create')
  const models = await rpc(pi, 'model/list', { sessionId: pc.sessionId })
  assert.equal(models.items.length, 2)
  assert.equal(models.selected, 'p1/m1')
  await rpc(pi, 'model/select', { sessionId: pc.sessionId, model: 'p2/m2' })
  const pf = await follow(pi, pc.sessionId)
  sockets.push(pf.ws)
  assert.equal((await rpc(pi, 'session/prompt', { sessionId: pc.sessionId, content: [{ type: 'text', text: 'hello' }] })).accepted, true)
  await waitFor(() => pf.events.some((e) => e.type === 'assistant/message' && e.data.message.content === '模拟回复'), 'Pi streaming reply')

  await rpc(pi, 'session/prompt', { sessionId: pc.sessionId, content: [{ type: 'text', text: 'approve' }] })
  await waitFor(() => pf.events.some((e) => e.type === 'approval/request'), 'Pi approval request')
  await rpc(pi, 'session/approve', { sessionId: pc.sessionId, reqId: 'permission-1', response: 'once' })
  await rpc(pi, 'session/prompt', { sessionId: pc.sessionId, content: [{ type: 'text', text: 'approve' }] })
  await waitFor(() => pf.events.filter((e) => e.type === 'approval/request').length >= 2, 'Pi second approval')
  await rpc(pi, 'session/approve', { sessionId: pc.sessionId, reqId: 'permission-1', response: 'reject' })
  const always = await request(pi, 'session/approve', { sessionId: pc.sessionId, response: 'always' })
  assert.equal(always.result.ok, false)

  await rpc(pi, 'session/prompt', { sessionId: pc.sessionId, content: [{ type: 'text', text: 'wait' }] })
  await rpc(pi, 'session/cancel', { sessionId: pc.sessionId })
  const piRows = readJsonLines(fakeLogs[0])
  assert.ok(piRows[0].argv.includes('--session-id'))
  assert.ok(piRows[0].argv.includes(pc.sessionId))
  assert.ok(piRows[0].argv.includes('--session-dir'))
  const piCommands = piRows.filter((r) => r.kind === 'command').map((r) => r.command)
  assert.ok(piCommands.some((c) => c.type === 'set_model' && c.provider === 'p2' && c.modelId === 'm2'))
  assert.ok(piCommands.some((c) => c.type === 'abort'))
  assert.ok(piCommands.some((c) => c.type === 'extension_ui_response' && c.confirmed === true))
  assert.ok(piCommands.some((c) => c.type === 'extension_ui_response' && c.confirmed === false))
  await stopBridge(pi); pi = null

  gemini = await startBridge('lib/p4/gemini-bridge.mjs', [
    '--node', process.execPath,
    '--gemini', path.resolve('diagnostics/fake-gemini-cli.mjs'),
    '--reg', path.join(scratch, 'gemini-reg'),
    '--cwd', scratch,
    '--model', 'test-a',
    '--models', 'test-a,test-b'
  ], { FAKE_GEMINI_LOG: fakeLogs[1] })
  const geminiPage = await fetch(gemini.origin + '/').then((r) => r.text())
  assert.match(geminiPage, /Gemini · Person Harness/)
  const gc = await rpc(gemini, 'session/create')
  const gm = await rpc(gemini, 'model/list', { sessionId: gc.sessionId })
  assert.equal(gm.selected, 'test-a')
  assert.deepEqual(gm.items.map((m) => m.id), ['test-a', 'test-b'])
  await rpc(gemini, 'model/select', { sessionId: gc.sessionId, model: 'test-b' })
  const gf = await follow(gemini, gc.sessionId)
  sockets.push(gf.ws)
  assert.equal((await rpc(gemini, 'session/prompt', { sessionId: gc.sessionId, content: [{ type: 'text', text: 'hello' }] })).accepted, true)
  await waitFor(() => gf.events.some((e) => e.type === 'assistant/message' && e.data.message.content === 'Gemini 模拟回复'), 'Gemini streaming reply')
  await waitFor(() => gf.events.some((e) => e.type === 'turn/end'), 'Gemini turn end')
  await rpc(gemini, 'session/prompt', { sessionId: gc.sessionId, content: [{ type: 'text', text: 'wait' }] })
  await waitFor(() => readJsonLines(fakeLogs[1]).length >= 2, 'Gemini second process')
  await rpc(gemini, 'session/cancel', { sessionId: gc.sessionId })
  const unsupported = await request(gemini, 'session/approve', { sessionId: gc.sessionId, response: 'once' })
  assert.equal(unsupported.result.ok, false)
  const geminiRows = readJsonLines(fakeLogs[1])
  assert.equal(geminiRows.length, 2)
  for (const row of geminiRows) assert.equal(row.argv.includes('--yolo'), false)
  assert.ok(geminiRows[0].argv.includes('--session-id'))
  assert.ok(geminiRows[0].argv.includes('test-b'))
  assert.ok(geminiRows[1].argv.includes('--resume'))
  console.log('p4-cli-chat: Pi + Gemini HTML/models/streaming/approvals/cancel/CLI args passed')
} finally {
  for (const ws of sockets) ws.close()
  await Promise.all([stopBridge(pi), stopBridge(gemini)])
  cleanupFakeProcesses()
}
