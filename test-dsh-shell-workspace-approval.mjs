import assert from 'node:assert/strict'
import { AttachSession } from './lib/adapter.mjs'
import { createTargets } from './lib/targets.mjs'

const RealWebSocket = globalThis.WebSocket
const RealFetch = globalThis.fetch
const sockets = []
const calls = []
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
globalThis.fetch = async (url, init) => {
  const parsed = JSON.parse(init.body)
  calls.push({ url: String(url), body: parsed })
  const rpcId = parsed.rpcId
  let value = { accepted: true }
  if (String(url).endsWith('/api/session/list')) {
    value = { items: [
      { sessionId: 'c1', title: '一', cwd: 'D:\\Work\\', updatedAt: 2 },
      { sessionId: 'c2', title: '二', cwd: 'D:\\other', updatedAt: 1 }
    ] }
  } else if (String(url).endsWith('/api/session/create')) {
    value = { sessionId: 'c3' }
  }
  return new Response(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }), {
    status: 200, headers: { 'content-type': 'application/json' }
  })
}

const targets = createTargets({
  cfg: { targets: [
    { name: 'dsh', origin: 'origin:dsh', auth: 'cookie-self' },
    { name: 'kimi', origin: 'http://127.0.0.1:7711', shell: 'dsh', auth: 'none' }
  ] },
  getOrigin: () => 'http://127.0.0.1:3080',
  mintCookie: async () => 'owner-cookie'
})
const frames = []
const attached = new AttachSession({ attachId: 'workspace-approval', peer: {} }, {
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
function decoded () {
  return frames.filter((f) => f.streamId === 'outer' && f.type === 'data')
    .map((f) => JSON.parse(Buffer.from(f.data, 'base64').toString('utf8')))
}
function lastItem (streamId, type) {
  return decoded().filter((m) => m.streamId === streamId && m.value?.type === type).at(-1)
}
let httpSeq = 0
async function request (path, args) {
  const streamId = `http-${++httpSeq}`
  const rpcId = `rpc-${httpSeq}`
  attached._httpOpenPending({ streamId, method: 'POST', path, headers: {} })
  const body = JSON.stringify({ type: 'client-request', rpcId, payload: { args } })
  await attached._onData({ streamId, data: Buffer.from(body).toString('base64'), fin: true })
  const own = frames.filter((f) => f.streamId === streamId)
  const raw = Buffer.concat(own.filter((f) => f.type === 'data').map((f) => Buffer.from(f.data, 'base64')))
  assert.ok(raw.length, `${path} 应返回 RPC body`)
  return JSON.parse(raw.toString('utf8'))
}

try {
  await attached._openWs({ streamId: 'outer', path: '/t/kimi/api/remote.mux', headers: {} })
  await waitFor(() => frames.some((f) => f.streamId === 'outer' && f.status === 101), '目标 WS 打开')
  const target = sockets[0]
  await sendMux({ type: 'open', streamId: 'workspace', endpoint: 'workspace/follow', payload: { args: {} } })
  await sendMux({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })
  await sendMux({ type: 'open', streamId: 'control', endpoint: 'session/control', payload: { args: {} } })
  await sendMux({ type: 'open', streamId: 'session', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'c1' } } } } })
  await waitFor(() => sockets.length === 2, 'dsh WS 打开')
  const dsh = sockets[1]

  const listed = await request('/t/kimi/api/session/list', { request: {} })
  assert.equal(listed.result.ok, true)
  assert.equal(listed.result.value.items[0].blank, false)

  dsh.receive({ type: 'item', streamId: 'control', value: { type: 'baseline', value: { projections: {
    native: { asOfSeq: 4, values: { title: '本机会话' } }
  } } } })
  const controlBaseline = lastItem('control', 'baseline').value.value.projections
  assert.equal(controlBaseline.native.values.title, '本机会话', 'dsh 原生投影必须保留')
  assert.equal(controlBaseline.c1.values.title, '一')
  assert.deepEqual(controlBaseline.c1.values.sessionListMetadata, { blank: false, lastPromptAt: 2 })
  assert.equal(controlBaseline.c2.values.title, '二')

  // 审批可以早于 $events ready 到达，但必须等 ready 后才发 waterfall。
  target.receive({ type: 'item', streamId: 'session', value: { type: 'event', event: {
    type: 'approval/request', seq: 0,
    data: { reqId: 'r1', permission: 'Write', command: 'write one', options: [
      { optionId: 'allow-r1', kind: 'allow_once' }, { optionId: 'reject-r1', kind: 'reject_once' }
    ] }
  } } })
  assert.equal(decoded().some((m) => m.value?.type === 'waterfall'), false)
  dsh.receive({ type: 'item', streamId: 'events', value: { type: 'ready', clientId: 'client-1', host: { home: 'D:\\home' } } })
  const waterfall = await waitFor(() => decoded().find((m) => m.value?.type === 'waterfall'), '审批 waterfall')
  assert.equal(waterfall.streamId, 'events')
  assert.equal(waterfall.value.agentId, 'c1')
  assert.deepEqual(waterfall.value.request, { toolName: 'Write', reason: 'write one' })

  const baseline = { items: [
    { workspaceId: 'w1', path: 'd:\\work', title: 'work', sessionIds: ['native-1'], createdAt: 1, updatedAt: 1 },
    { workspaceId: 'w2', path: 'D:\\other\\', title: 'other', sessionIds: ['native-2'], createdAt: 1, updatedAt: 1 }
  ], archivedSessionIds: [], pinnedSessionIds: [] }
  dsh.receive({ type: 'item', streamId: 'workspace', value: { type: 'baseline', value: baseline } })
  let projected = lastItem('workspace', 'baseline').value.value.items
  assert.deepEqual(projected[0].sessionIds, ['native-1', 'c1'])
  assert.deepEqual(projected[1].sessionIds, ['native-2', 'c2'])

  dsh.receive({ type: 'item', streamId: 'workspace', value: { type: 'replace', value: baseline } })
  projected = lastItem('workspace', 'replace').value.value.items
  assert.deepEqual(projected[0].sessionIds, ['native-1', 'c1'])
  assert.deepEqual(projected[1].sessionIds, ['native-2', 'c2'])

  const created = await request('/t/kimi/api/session/create', { request: { workspaceId: 'w2' } })
  assert.equal(created.result.value.sessionId, 'c3')
  assert.equal(attached.bridgeSessions.get('kimi').get('c3').cwd, 'D:\\other\\')
  assert.equal(attached.streams.get('outer').workspaceStreamId, 'workspace')
  await waitFor(() => lastItem('workspace', 'upsert'), '创建后主动回推工作区 upsert')
  const upserted = lastItem('workspace', 'upsert').value.workspace
  assert.deepEqual(upserted.sessionIds, ['native-2', 'c2', 'c3'])
  assert.equal(upserted.sessionIds.includes('c1'), false, '不同 cwd 不得串会话')
  dsh.receive({ type: 'item', streamId: 'workspace', value: { type: 'upsert', workspace: baseline.items[0] } })
  assert.deepEqual(lastItem('workspace', 'upsert').value.workspace.sessionIds, ['native-1', 'c1'], '上游 upsert 仍须合并外部成员')

  await sendMux({ type: 'open', streamId: 'session3', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'c3' } } } } })
  target.receive({ type: 'item', streamId: 'session3', value: { type: 'event', event: {
    type: 'session/title', seq: 0, data: { title: '首轮手机消息' }
  } } })
  target.receive({ type: 'item', streamId: 'session3', value: { type: 'event', event: {
    type: 'user/message', seq: 0, data: { content: '首轮手机消息' }
  } } })
  const c3Projections = decoded().filter((m) => m.streamId === 'control' && m.value?.type === 'projection' && m.value.sessionId === 'c3')
  assert.equal(c3Projections.filter((m) => m.value.key === 'title').at(-1).value.value, '首轮手机消息')
  const engaged = c3Projections.filter((m) => m.value.key === 'sessionListMetadata').at(-1)
  assert.equal(engaged.value.value.blank, false, '首条用户消息必须让历史树移除空会话占位')
  assert.ok(Number.isFinite(engaged.value.value.lastPromptAt))
  assert.ok(engaged.value.seq > c3Projections.find((m) => m.value.key === 'title' && m.value.value === '首轮手机消息').value.seq)
  assert.equal(attached.bridgeSessions.get('kimi').get('c3').title, '首轮手机消息')
  assert.equal(attached.bridgeSessions.get('kimi').get('c3').blank, false)

  const allowed = await request('/t/kimi/api/$events/result', {
    clientId: 'client-1', eventId: waterfall.value.eventId,
    outcome: { kind: 'result', value: 'allowed-once' }
  })
  assert.equal(allowed.result.ok, true)
  const approvalCall = calls.at(-1)
  assert.equal(approvalCall.url, 'http://127.0.0.1:7711/api/session/approve')
  assert.deepEqual(approvalCall.body.payload.args.request, { sessionId: 'c1', reqId: 'r1', optionId: 'allow-r1', response: 'allow-r1' })

  target.receive({ type: 'item', streamId: 'session', value: { type: 'event', event: {
    type: 'approval/request', seq: 0,
    data: { reqId: 'r2', permission: 'Write', command: 'write two', options: [{ optionId: 'reject-r2', kind: 'reject_once' }] }
  } } })
  const rejectedWaterfall = await waitFor(() => decoded().filter((m) => m.value?.type === 'waterfall').length === 2, '第二个审批 waterfall')
  const rejected = await request('/t/kimi/api/$events/result', {
    clientId: 'client-1', eventId: decoded().filter((m) => m.value?.type === 'waterfall')[1].value.eventId,
    outcome: { kind: 'result', value: 'rejected' }
  })
  assert.equal(rejected.result.ok, true)
  assert.equal(rejectedWaterfall, true)
  assert.deepEqual(calls.at(-1).body.payload.args.request, { sessionId: 'c1', reqId: 'r2', optionId: 'reject-r2', response: 'reject-r2' })

  const unknown = await request('/t/kimi/api/$events/result', {
    clientId: 'client-1', eventId: 'dsh-owned-event', outcome: { kind: 'next' }
  })
  assert.equal(unknown.result.ok, true)
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:3080/api/$events/result', '未知 eventId 必须仍走 dsh')

  console.log('dsh-shell-workspace-approval: blank、baseline/replace/upsert、cwd 隔离、审批映射与 dsh 回退 passed')
} finally {
  attached.detach()
  globalThis.WebSocket = RealWebSocket
  globalThis.fetch = RealFetch
}
