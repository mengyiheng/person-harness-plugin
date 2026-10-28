import assert from 'node:assert/strict'
import { AttachSession } from './lib/adapter.mjs'
import { createTargets } from './lib/targets.mjs'

const RealWebSocket = globalThis.WebSocket
const sockets = []
class FakeWebSocket {
  constructor (url, options) {
    this.url = url
    this.options = options
    this.sent = []
    this.readyState = 0
    sockets.push(this)
    queueMicrotask(() => { this.readyState = 1; this.onopen?.() })
  }

  send (text) { this.sent.push(JSON.parse(text)) }
  receive (value) { this.onmessage?.({ data: JSON.stringify(value) }) }
  close (code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}
globalThis.WebSocket = FakeWebSocket

const targets = createTargets({
  cfg: { targets: [
    { name: 'dsh', origin: 'origin:dsh', auth: 'cookie-self' },
    { name: 'codex', origin: 'http://127.0.0.1:7711', shell: 'dsh', auth: 'none' }
  ] },
  getOrigin: () => 'http://127.0.0.1:3080',
  mintCookie: async () => 'owner-cookie'
})
const frames = []
const attached = new AttachSession({ attachId: 'mux-test', peer: {} }, {
  getOrigin: () => 'http://127.0.0.1:3080',
  mintCookie: async () => 'owner-cookie',
  targets,
  send: (frame) => frames.push(frame),
  log: () => {}
})
async function waitFor (predicate, label) {
  for (let i = 0; i < 100; i++) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待超时: ' + label)
}
async function sendMux (value) {
  await attached._onData({ streamId: 'outer', data: Buffer.from(JSON.stringify(value)).toString('base64') })
}

try {
  await attached._openWs({ streamId: 'outer', path: '/t/codex/api/remote.mux', headers: {} })
  await waitFor(() => frames.some((f) => f.streamId === 'outer' && f.status === 101), '目标 WS 打开')
  assert.equal(sockets.length, 1, '纯会话尚未到来时不得预建 dsh mux')
  const target = sockets[0]
  assert.equal(target.url, 'ws://127.0.0.1:7711/api/remote.mux')

  await sendMux({ type: 'open', streamId: 'workspace', endpoint: 'workspace/follow', payload: { args: {} } })
  await waitFor(() => sockets.length === 2, 'dsh WS 按需打开')
  const dsh = sockets[1]
  assert.equal(dsh.url, 'ws://127.0.0.1:3080/api/remote.mux')
  assert.equal(dsh.options.headers.Cookie, 'owner-cookie')
  await waitFor(() => dsh.sent.length === 1, 'dsh 连接前的消息应排队')

  await sendMux({ type: 'open', streamId: 'session', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'c1' } } } } })
  await sendMux({ type: 'open', streamId: 'account', endpoint: 'account/watch', payload: { args: {} } })
  assert.deepEqual(target.sent.map((m) => m.endpoint), ['session/follow'])
  assert.deepEqual(dsh.sent.map((m) => m.endpoint), ['workspace/follow', 'account/watch'])

  target.receive({ type: 'item', streamId: 'session', value: { type: 'snapshot', cursor: 0, records: [] } })
  await waitFor(() => frames.some((f) => f.streamId === 'outer' && f.type === 'data'), '快照回传')
  const dataFrames = frames.filter((f) => f.streamId === 'outer' && f.type === 'data')
  const snapshot = JSON.parse(Buffer.from(dataFrames[0].data, 'base64').toString('utf8'))
  assert.equal(snapshot.streamId, 'session')
  assert.equal(snapshot.value.header.version, 1)
  assert.equal(snapshot.value.hasMore, false)

  dsh.receive({ type: 'item', streamId: 'workspace', value: { type: 'event', event: { type: 'workspace/ready' } } })
  await waitFor(() => frames.filter((f) => f.streamId === 'outer' && f.type === 'data').length === 2, 'dsh 消息回传')
  const updatedFrames = frames.filter((f) => f.streamId === 'outer' && f.type === 'data')
  const workspace = JSON.parse(Buffer.from(updatedFrames[1].data, 'base64').toString('utf8'))
  assert.equal(workspace.streamId, 'workspace')
  assert.equal(workspace.value.event.type, 'workspace/ready')

  await sendMux({ type: 'close', streamId: 'workspace' })
  assert.equal(dsh.sent.at(-1).type, 'close')
  assert.equal(target.sent.some((m) => m.type === 'close'), false, '关闭 dsh 子通道不得误关会话子通道')
  console.log('dsh-shell-mux: session/dsh 分流、排队、快照与关闭 passed')
} finally {
  attached.detach()
  globalThis.WebSocket = RealWebSocket
}
