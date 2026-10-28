import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'

const sockets = new Set()
const eventClients = new Set()
const prompts = []
const approvals = []
const aborts = []
const json = (res, value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value))
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': connected\n\n')
    eventClients.add(res)
    req.on('close', () => eventClients.delete(res))
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const parsed = body ? JSON.parse(body) : {}
  if (req.url === '/provider') return json(res, {
    all: [
      { id: 'p1', models: { m1: { name: 'Model One' } } },
      { id: 'p2', models: { m2: { name: 'Model Two' } } }
    ],
    default: { p1: 'm1' }, connected: ['p1']
  })
  if (req.url === '/session' && req.method === 'GET') return json(res, [{ id: 's2', title: '测试会话', directory: 'D:\\work' }])
  if (req.url === '/session' && req.method === 'POST') return json(res, { id: 's2' })
  if (req.url === '/session/s2') return json(res, { id: 's2', title: '测试会话' })
  if (req.url === '/session/s2/message') return json(res, [])
  if (req.url === '/session/s2/prompt_async') { prompts.push(parsed); return json(res, {}) }
  if (req.url === '/session/s2/abort') { aborts.push(parsed); return json(res, {}) }
  if (req.url.startsWith('/session/s2/permissions/')) { approvals.push({ id: req.url.split('/').pop(), ...parsed }); return json(res, {}) }
  res.writeHead(404).end()
})
upstream.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const port = await freePort()
const child = spawn(process.execPath, ['lib/p4/opencode-bridge.mjs', '--port', String(port), '--origin', `http://127.0.0.1:${upstream.address().port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })
const origin = `http://127.0.0.1:${port}`
let ws
async function waitFor (predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时: ${label}\n${log}`)
}
async function request (method, request = {}) {
  const res = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rpcId: method, payload: { args: { request } } }) })
  return res.json()
}
async function rpc (method, body = {}) {
  const msg = await request(method, body)
  assert.equal(msg.result.ok, true, JSON.stringify(msg.result.error))
  return msg.result.value
}
function pushEvent (type, properties) {
  const data = `data: ${JSON.stringify({ type, properties })}\n\n`
  for (const res of eventClients) {
    res.write(data.slice(0, 17))
    res.write(data.slice(17))
  }
}
try {
  await waitFor(() => log.includes('SSE 增量订阅已建立'), 'bridge ready')
  const page = await fetch(origin + '/').then((r) => r.text())
  assert.match(page, /OpenCode · Person Harness/)
  assert.match(page, /const AGENT="OpenCode"/)
  assert.match(page, /工作区/)
  const models = await rpc('model/list', { sessionId: 's2' })
  assert.equal(models.selected, 'p1/m1')
  assert.equal(models.items.length, 2)
  await rpc('model/select', { sessionId: 's2', model: 'p2/m2' })
  assert.equal((await rpc('session/prompt', { sessionId: 's2', content: [{ type: 'text', text: 'hello' }] })).accepted, true)
  assert.deepEqual(prompts[0].model, { providerID: 'p2', modelID: 'm2' })
  assert.equal(prompts[0].parts[0].text, 'hello')

  const events = []
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.value?.type === 'event') events.push(msg.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: 's2' } } } } }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  pushEvent('message.updated', { sessionID: 's2', info: { id: 'a1', role: 'assistant' } })
  pushEvent('message.part.updated', { sessionID: 's2', part: { id: 'part1', messageID: 'a1', type: 'text', text: '分块回复' } })
  await waitFor(() => events.some((e) => e.type === 'assistant/message' && e.data.message.content === '分块回复'), 'chunked SSE assistant event')

  for (const response of ['once', 'always', 'reject']) {
    pushEvent('permission.asked', { sessionID: 's2', id: `req-${response}`, permission: 'bash', metadata: { command: 'npm test' } })
    await waitFor(() => events.some((e) => e.type === 'approval/request' && e.data.reqId === `req-${response}`), 'approval event')
    await rpc('session/approve', { sessionId: 's2', reqId: `req-${response}`, response })
  }
  assert.deepEqual(approvals.map((a) => a.response), ['once', 'always', 'reject'])
  await rpc('session/cancel', { sessionId: 's2' })
  assert.equal(aborts.length, 1)
  console.log('p4-opencode-chat: HTML + models + chunked SSE + approvals + cancel passed')
} finally {
  if (ws) ws.close()
  child.kill()
  for (const res of eventClients) res.end()
  for (const socket of sockets) socket.destroy()
  await new Promise((resolve) => upstream.close(resolve))
}
