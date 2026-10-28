import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { AttachSession } from './lib/adapter.mjs'
import { createTargets } from './lib/targets.mjs'

const sockets = new Set()
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': connected\n\n')
    return
  }
  if (req.url === '/session') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ id: 's1', title: '真实桥标题', directory: 'D:\\work', time: { updated: 1234 } }]))
    return
  }
  if (req.url === '/session/s1') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 's1', title: '真实桥标题' }))
    return
  }
  if (req.url === '/session/s1/message') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{ info: { id: 'm1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hello' }] }]))
    return
  }
  res.writeHead(404).end()
})
upstream.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`

async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return port
}
const bridgePort = await freePort()
const child = spawn(process.execPath, ['lib/p4/opencode-bridge.mjs', '--port', String(bridgePort), '--origin', upstreamOrigin], {
  cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
})
let bridgeLog = ''
child.stdout.on('data', (d) => { bridgeLog += d })
child.stderr.on('data', (d) => { bridgeLog += d })
const bridgeOrigin = `http://127.0.0.1:${bridgePort}`

const dsh = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }).end('<html>dsh shell</html>')
})
await new Promise((resolve) => dsh.listen(0, '127.0.0.1', resolve))
const dshOrigin = `http://127.0.0.1:${dsh.address().port}`
const targets = createTargets({
  cfg: { targets: [
    { name: 'dsh', origin: 'origin:dsh', auth: 'cookie-self' },
    { name: 'opencode', origin: bridgeOrigin, shell: 'dsh' }
  ] },
  getOrigin: () => dshOrigin,
  mintCookie: async () => 'owner-cookie'
})
const frames = []
const attached = new AttachSession({ attachId: 'real-bridge', peer: {} }, {
  getOrigin: () => dshOrigin,
  mintCookie: async () => 'owner-cookie',
  targets,
  send: (frame) => frames.push(frame),
  log: () => {}
})
async function waitFor (predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待超时: ${label}\n${bridgeLog}`)
}

try {
  await waitFor(() => bridgeLog.includes('P4 opencode-bridge 就绪'), 'bridge ready')
  await waitFor(() => bridgeLog.includes('SSE 增量订阅已建立'), 'SSE ready')

  attached._httpOpenPending({ streamId: 'http1', method: 'POST', path: '/t/opencode/api/session/list', headers: {} })
  const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc1', payload: { args: { _request: {} } } })
  await attached._onData({ streamId: 'http1', data: Buffer.from(body).toString('base64'), fin: true })
  const chunks = frames.filter((f) => f.streamId === 'http1' && f.type === 'data')
  const response = JSON.parse(Buffer.concat(chunks.map((f) => Buffer.from(f.data, 'base64'))).toString('utf8'))
  const item = response.result.value.items[0]
  assert.equal(item.sessionId, 's1')
  assert.equal(item.projections.values.title, '真实桥标题')

  await attached._openWs({ streamId: 'ws1', path: '/t/opencode/api/remote.mux', headers: { referer: 'http://local/t/opencode/' } })
  await waitFor(() => frames.some((f) => f.streamId === 'ws1' && f.type === 'http-head' && f.status === 101), 'WS open')
  const open = {
    type: 'open', streamId: 'ws1', endpoint: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId: 's1' } } } }
  }
  await attached._onData({ streamId: 'ws1', data: Buffer.from(JSON.stringify(open)).toString('base64') })
  const snapshotFrame = await waitFor(() => frames.find((f) => f.streamId === 'ws1' && f.type === 'data'), 'follow snapshot')
  const snapshot = JSON.parse(Buffer.from(snapshotFrame.data, 'base64').toString('utf8')).value
  assert.equal(snapshot.type, 'snapshot')
  assert.equal(snapshot.header.version, 1)
  assert.equal(snapshot.hasMore, false)
  assert.equal(snapshot.records[0].event.data.title, '真实桥标题')
  assert.deepEqual(snapshot.records[1].event.data.content, [{ type: 'text', text: 'hello' }])
  assert.equal(snapshot.projections.values.title, '真实桥标题')
  console.log('p4-opencode-shell: HTTP list + WS follow passed')
} finally {
  attached.detach()
  child.kill()
  await Promise.all([
    new Promise((resolve) => dsh.close(resolve)),
    new Promise((resolve) => { for (const socket of sockets) socket.destroy(); upstream.close(resolve) })
  ])
}
