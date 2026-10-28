import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { AttachSession } from './lib/adapter.mjs'
import { createTargets } from './lib/targets.mjs'
import { createDeviceRoutes } from './lib/device-routes.mjs'

const scratch = path.resolve('diagnostics/.test-codex-chat-shell')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const fakeLog = path.join(scratch, 'fake-app-server.jsonl')
const fakePid = () => JSON.parse(fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/)[0]).ready
const requests = () => !fs.existsSync(fakeLog) ? [] : fs.readFileSync(fakeLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor (predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await sleep(20)
  }
  throw new Error(`等待超时: ${label}\n${bridgeLog}`)
}
const probe = net.createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))

const child = spawn(process.execPath, [
  'lib/p4/codex-bridge.mjs', '--port', String(port),
  '--codex-script', path.resolve('diagnostics/fake-codex-app-server.mjs'),
  '--codex-home', path.join(scratch, 'codex-home')
], { cwd: process.cwd(), env: { ...process.env, FAKE_CODEX_LOG: fakeLog }, stdio: ['ignore', 'pipe', 'pipe'] })
let bridgeLog = ''
child.stdout.on('data', (data) => { bridgeLog += data })
child.stderr.on('data', (data) => { bridgeLog += data })
const origin = `http://127.0.0.1:${port}`
let rpcCounter = 0
async function rpc (method, request = {}) {
  const rpcId = `rpc-${method}-${++rpcCounter}`
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, payload: { args: { request } } }),
    signal: AbortSignal.timeout(5000)
  })
  const msg = await response.json()
  assert.equal(msg.rpcId, rpcId)
  assert.equal(msg.result?.ok, true, JSON.stringify(msg.result))
  return msg.result.value
}
async function openFollow (sessionId, streamId = `follow-${sessionId}`) {
  const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`)
  const events = []
  let snapshot
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.value?.type === 'snapshot') snapshot = msg.value
    if (msg.value?.type === 'event') events.push(msg.value.event)
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }))
  await waitFor(() => snapshot, `snapshot ${sessionId}`)
  return { ws, events, snapshot }
}

let attached
const liveSockets = new Set()
try {
  await waitFor(() => bridgeLog.includes('P4 codex-bridge 就绪'), 'bridge ready')
  await waitFor(() => requests().some((entry) => entry.receive?.method === 'initialize'), 'fake initialize')

  const page = await fetch(`${origin}/`)
  const html = await page.text()
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  assert.match(html, /Person Harness/)
  assert.match(html, /const AGENT="Codex"/)
  assert.doesNotMatch(html, /href="\/__ph\/webos">文件工具/)
  assert.doesNotMatch(html, /href="\/__ph\/devices">设备/)
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  assert.ok(script)
  new Function(script) // 仅解析页面脚本，不执行 DOM 或网络请求。
  assert.ok(!html.includes('/api/settings/'), '轻量壳不得依赖 dsh 设置接口')
  assert.ok(!html.includes('session/modelCatalog'), '轻量壳不得依赖 dsh 模型目录')

  const models = await rpc('model/list')
  assert.deepEqual(models.items.map((model) => model.id), ['model-a', 'model-b'])
  assert.equal(models.selected, 'model-a')
  await rpc('model/select', { model: 'model-b' })
  const created = await rpc('session/create')
  const createCall = requests().find((entry) => entry.receive?.method === 'thread/start')
  assert.equal(createCall.receive.params.model, 'model-b')
  assert.equal((await rpc('model/list', { sessionId: created.sessionId })).selected, 'model-b')
  await rpc('model/select', { sessionId: created.sessionId, model: 'model-a' })

  const history = await openFollow('existing', 'history')
  assert.deepEqual(history.snapshot.records.filter((record) => ['user/message', 'assistant/message'].includes(record.event.type)).map((record) => record.event.data?.content || record.event.data?.message?.content), ['历史问题', '历史回答'])
  history.ws.close()

  const live = await openFollow(created.sessionId, 'live')
  await rpc('session/prompt', { sessionId: created.sessionId, content: [{ type: 'text', text: '你好' }] })
  await waitFor(() => live.events.some((event) => event.type === 'turn/end'), 'normal turn end')
  const turnStart = requests().filter((entry) => entry.receive?.method === 'turn/start').at(-1)
  assert.equal(turnStart.receive.params.model, 'model-a')
  assert.equal(live.events.find((event) => event.type === 'user/message').data.content, '你好')
  assert.deepEqual(live.events.filter((event) => event.type === 'assistant/message').map((event) => event.data.message.content), ['你好', '你好，世界', '你好，世界'])

  for (const [response, decision] of [['once', 'accept'], ['always', 'acceptForSession'], ['reject', 'decline']]) {
    await rpc('session/prompt', { sessionId: created.sessionId, content: [{ type: 'text', text: `审批 ${response}` }] })
    const approval = await waitFor(() => live.events.find((event) => event.type === 'approval/request' && event.data.command.endsWith(response)), `approval ${response}`)
    const result = await rpc('session/approve', { sessionId: created.sessionId, reqId: approval.data.reqId, response })
    assert.equal(result.accepted, true)
    await waitFor(() => requests().some((entry) => !entry.receive?.method && String(entry.receive?.id) === approval.data.reqId && entry.receive?.result?.decision === decision), `decision ${decision}`)
    await waitFor(() => live.events.filter((event) => event.type === 'turn/end').length >= (response === 'once' ? 2 : response === 'always' ? 3 : 4), `approval turn end ${response}`)
  }

  await rpc('session/prompt', { sessionId: created.sessionId, content: [{ type: 'text', text: '等待停止' }] })
  await waitFor(() => live.events.filter((event) => event.type === 'turn/start').length >= 5, 'interrupt turn start')
  const runningFollow = await openFollow(created.sessionId, 'running-follow')
  assert.equal(runningFollow.snapshot.header.running, true)
  runningFollow.ws.close()
  assert.equal((await rpc('session/cancel', { sessionId: created.sessionId })).accepted, true)
  const interrupt = await waitFor(() => requests().find((entry) => entry.receive?.method === 'turn/interrupt'), 'interrupt request')
  const lastStart = requests().filter((entry) => entry.receive?.method === 'turn/start').at(-1)
  const startResponse = requests().find((entry) => entry.send?.id === lastStart.receive.id)
  assert.equal(interrupt.receive.params.threadId, created.sessionId)
  assert.equal(interrupt.receive.params.turnId, startResponse.send.result.turn.id)
  live.ws.close()

  const targets = createTargets({ cfg: { targets: [{ name: 'codex', label: 'Codex', origin }] }, getOrigin: () => origin, mintCookie: async () => '' })
  const revoked = []
  const deviceRoutes = createDeviceRoutes({
    identity: {
      deviceId: 'pc-test',
      listPairs: async () => [{ pairId: 'pair-1', createdAt: 1, phone: { name: '测试手机' } }],
      requestPairCode: async () => ({ code: '123456', expiresInSec: 300 }),
      removePair: async (pairId) => revoked.push(pairId)
    },
    getTunnel: () => ({ connected: true }), server: 'http://relay.test', agent: 'Codex', deviceName: '测试电脑'
  })
  const frames = []
  attached = new AttachSession({ attachId: 'codex-chat-shell', peer: {} }, {
    getOrigin: () => origin, mintCookie: async () => '', targets,
    onInternalRequest: async (requestPath, method, body) => {
      if (requestPath === '/__ph/webos') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html>现有文件工具</html>' }
      return (await deviceRoutes(requestPath, method, body)) || { status: 404, body: { error: 'not found' } }
    },
    send: (frame) => frames.push(frame), log: () => {}
  })
  async function relayHttp (streamId, method, requestPath, request) {
    attached._httpOpenPending({ streamId, method, path: requestPath, headers: { referer: 'http://local/t/codex/' } })
    const body = method === 'POST'
      ? (requestPath.startsWith('/__ph/') ? JSON.stringify(request || {}) : JSON.stringify({ type: 'client-request', rpcId: streamId, payload: { args: { request } } }))
      : ''
    await attached._onData({ streamId, data: Buffer.from(body).toString('base64'), fin: true })
    await waitFor(() => frames.some((frame) => frame.streamId === streamId && frame.type === 'close'), `relay ${requestPath}`)
    const raw = Buffer.concat(frames.filter((frame) => frame.streamId === streamId && frame.type === 'data').map((frame) => Buffer.from(frame.data, 'base64')))
    return raw.toString('utf8')
  }
  assert.match(await relayHttp('relay-html', 'GET', '/t/codex/'), /Person Harness/)
  const relayModels = JSON.parse(await relayHttp('relay-models', 'POST', '/api/model/list', { sessionId: created.sessionId }))
  assert.equal(relayModels.result.value.selected, 'model-a')
  assert.match(await relayHttp('relay-tools', 'GET', '/__ph/webos'), /现有文件工具/)
  const devicePage = await relayHttp('relay-devices', 'GET', '/__ph/devices')
  assert.match(devicePage, /设备与配对/)
  new Function(devicePage.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '')
  assert.match(frames.find((frame) => frame.streamId === 'relay-devices' && frame.type === 'http-head').headers['content-type'], /text\/html/)
  const deviceStatus = JSON.parse(await relayHttp('relay-device-status', 'POST', '/__ph/status'))
  assert.equal(deviceStatus.deviceName, '测试电脑')
  assert.equal(deviceStatus.connected, true)
  const deviceList = JSON.parse(await relayHttp('relay-device-list', 'POST', '/__ph/devices/list'))
  assert.equal(deviceList.items[0].phone.name, '测试手机')
  const pair = JSON.parse(await relayHttp('relay-device-pair', 'POST', '/__ph/devices/pair'))
  assert.equal(pair.code, '123456')
  assert.match(pair.qr, /^data:image\/png;base64,/)
  await relayHttp('relay-device-revoke', 'POST', '/__ph/devices/revoke', { pairId: 'pair-1' })
  assert.deepEqual(revoked, ['pair-1'])
  await attached._openWs({ streamId: 'relay-ws', path: '/t/codex/api/remote.mux', headers: { referer: 'http://local/t/codex/' } })
  await waitFor(() => frames.some((frame) => frame.streamId === 'relay-ws' && frame.status === 101), 'relay ws open')
  const open = { type: 'open', streamId: 'relay-ws', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 'existing' } } } } }
  await attached._onData({ streamId: 'relay-ws', data: Buffer.from(JSON.stringify(open)).toString('base64') })
  const snapshotFrame = await waitFor(() => frames.find((frame) => frame.streamId === 'relay-ws' && frame.type === 'data'), 'relay snapshot')
  const relaySnapshot = JSON.parse(Buffer.from(snapshotFrame.data, 'base64').toString('utf8')).value
  assert.equal(relaySnapshot.type, 'snapshot')
  assert.equal(relaySnapshot.header.id, 'existing')
  assert.equal(relaySnapshot.records.find((record) => record.event.type === 'user/message').event.data.content, '历史问题')
  console.log('codex-chat-shell: HTML + models + prompt/stream + 3 approvals + cancel + relay HTTP/WS passed')
} finally {
  for (const ws of liveSockets) ws.close()
  attached?.detach()
  if (child.exitCode == null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, sleep(3000)])
  }
  await sleep(100)
  if (fs.existsSync(fakeLog)) {
    let alive = true
    try { process.kill(fakePid(), 0) } catch { alive = false }
    assert.equal(alive, false, '模拟 app-server 必须随桥接进程退出')
  }
}
