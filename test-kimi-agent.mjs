import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { startKimiAgent } from './lib/p4/kimi-agent.mjs'

const scratch = path.resolve('diagnostics/.test-kimi-agent')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
const acpLog = path.join(scratch, 'acp.jsonl')
const probe = net.createServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise((resolve) => probe.close(resolve))

class FakeIdentity {
  constructor (dir, server) { this.dir = dir; this.serverUrl = server; this.deviceId = null; this.deviceToken = null }
  async loadOrCreate () { this.privateKey = 'test-key' }
  get registered () { return !!this.deviceId }
  async register (name) { this.deviceId = 'phone-kimi-device'; this.deviceToken = 'token'; this.registeredAs = name }
  async ensureRegistered () { if (!this.registered) await this.register('kimi-code') }
  async requestPairCode () { return { code: '123456', expiresInSec: 300 } }
  async api () { return {} }
}
let tunnelOptions
class FakeTunnel {
  constructor (options) { tunnelOptions = options; this.options = options; this.connected = false }
  start () { this.connected = true }
  stop () { this.connected = false }
  async sendWebLoginApprove () { return { ok: true } }
  async sendLinkApprove () { return { ok: true } }
}
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('等待超时: ' + label)
}
const rows = () => fs.existsSync(acpLog) ? fs.readFileSync(acpLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
let agent
let ws
try {
  agent = await startKimiAgent({
    port,
    cwd: scratch,
    workspaces: [{ id: 'main', name: '主工作区', cwd: scratch }, { id: 'secondary', name: '第二工作区', cwd: path.join(scratch, 'secondary') }],
    home: path.join(scratch, 'home'),
    command: process.execPath,
    args: [path.resolve('diagnostics/fake-acp-agent.mjs'), 'acp'],
    env: { ...process.env, FAKE_ACP_LOG: acpLog },
    identityFactory: (dir, server) => new FakeIdentity(dir, server),
    tunnelFactory: (options) => new FakeTunnel(options)
  })
  assert.equal(agent.identity.deviceId, 'phone-kimi-device')
  assert.equal(agent.identity.registeredAs, 'kimi-code')
  assert.equal(agent.tunnel.connected, true)
  assert.equal(tunnelOptions.deps.getOrigin(), agent.origin)
  assert.equal(await tunnelOptions.deps.mintCookie(), '')
  assert.equal(tunnelOptions.relayUrl, 'ws://8.137.177.62:9400/api/v1/tunnel')
  const targets = await tunnelOptions.deps.onInternalRequest('/__ph/targets', 'GET', Buffer.alloc(0))
  assert.deepEqual(targets.body.targets, [{ name: 'kimi-code', label: 'Kimi Code' }])
  const ping = await tunnelOptions.deps.onInternalRequest('/__ph/transport-ping', 'GET', Buffer.alloc(0))
  assert.equal(ping.status, 200)
  assert.equal(ping.body.ok, true)
  const pair = await agent.pair()
  assert.equal(pair.code, '123456')
  assert.ok(fs.statSync(pair.pngPath).size > 100)

  const page = await fetch(agent.origin + '/').then((response) => response.text())
  assert.match(page, /Kimi Code · Person Harness/)
  assert.doesNotMatch(page, /文件工具|plugin-nav|id="stop"/)
  assert.match(page, /id="workspace"/)
  assert.match(page, /\$\('send'\)\.textContent=v\?'停止':'发送'/)
  const rpc = async (method, request = {}) => {
    const response = await fetch(`${agent.origin}/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rpcId: method, payload: { args: { request } } })
    })
    const message = await response.json()
    assert.equal(message.result.ok, true, JSON.stringify(message.result.error))
    return message.result.value
  }
  const workspaceList = await rpc('workspace/list')
  assert.deepEqual(workspaceList.items.map((item) => item.id), ['main', 'secondary'])
  const createdCwd = path.join(scratch, 'created')
  fs.mkdirSync(createdCwd)
  const createdWorkspace = await rpc('workspace/create', { name: '新建工作区', cwd: createdCwd })
  assert.equal(createdWorkspace.name, '新建工作区')
  assert.equal(createdWorkspace.cwd, createdCwd)
  const duplicateWorkspace = await rpc('workspace/create', { name: '重复名称', cwd: createdCwd })
  assert.equal(duplicateWorkspace.id, createdWorkspace.id)
  assert.ok(JSON.parse(fs.readFileSync(path.join(scratch, 'home', 'sessions', 'workspaces.json'), 'utf8')).items.some((item) => item.id === createdWorkspace.id))
  const first = await rpc('session/create', { workspaceId: 'main' })
  const second = await rpc('session/create', { workspaceId: 'secondary' })
  assert.notEqual(first.sessionId, second.sessionId)
  const stored = await rpc('session/list')
  assert.equal(stored.items.find((item) => item.sessionId === first.sessionId).workspaceId, 'main')
  assert.equal(stored.items.find((item) => item.sessionId === second.sessionId).workspaceId, 'secondary')
  assert.equal(stored.items.find((item) => item.sessionId === second.sessionId).cwd, path.join(scratch, 'secondary'))
  const events = []
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.value?.type === 'event') events.push(message.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: first.sessionId } } } } }))
  await rpc('session/prompt', { sessionId: first.sessionId, content: [{ type: 'text', text: 'approve' }] })
  const approval = await waitFor(() => events.find((event) => event.type === 'approval/request'), '手机审批事件')
  await rpc('session/approve', { sessionId: first.sessionId, reqId: approval.data.reqId, response: 'allow-once', optionId: 'allow-once' })
  await waitFor(() => events.some((event) => event.type === 'assistant/message' && event.data.message.content === 'Kimi 回复：approve'), '审批后的 Kimi 回复')
  await waitFor(() => events.some((event) => event.type === 'turn/end'), '轮次结束')
  await rpc('model/list', { sessionId: second.sessionId })
  const list = await rpc('session/list')
  assert.equal(list.items.length, 2)
  assert.ok(list.items.find((item) => item.sessionId === first.sessionId)?.title.includes('approve'))
  assert.ok(rows().some((row) => row.msg?.result?.outcome?.optionId === 'allow-once'))
  const newCwds = rows().filter((row) => row.msg?.method === 'session/new').map((row) => row.msg.params.cwd)
  assert.ok(newCwds.includes(scratch))
  assert.ok(newCwds.includes(path.join(scratch, 'secondary')))
  const recoverSession = await rpc('session/create', { workspaceId: 'main' })
  const recoveryEvents = []
  ws.close()
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.value?.type === 'snapshot') recoveryEvents.push(...message.value.records.filter((row) => row.type === 'event').map((row) => row.event))
    if (message.value?.type === 'event') recoveryEvents.push(message.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow-recovery', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: recoverSession.sessionId } } } } }))
  await rpc('session/prompt', { sessionId: recoverSession.sessionId, content: [{ type: 'text', text: 'approve' }] })
  const recoverApproval = await waitFor(() => recoveryEvents.find((event) => event.type === 'approval/request'), '重启前审批事件')
  assert.ok(fs.readdirSync(path.join(scratch, 'home', 'sessions')).some((name) => name.endsWith('.approval.json')), '待审批必须落盘')
  ws.close()
  agent.tunnel.stop()
  await new Promise((resolve) => agent.bridge.close(resolve))
  agent = await startKimiAgent({
    port, cwd: scratch, home: path.join(scratch, 'home'), localOnly: true,
    workspaces: [{ id: 'main', name: '主工作区', cwd: scratch }, { id: 'secondary', name: '第二工作区', cwd: path.join(scratch, 'secondary') }],
    command: process.execPath, args: [path.resolve('diagnostics/fake-acp-agent.mjs'), 'acp'],
    env: { ...process.env, FAKE_ACP_LOG: acpLog }
  })
  const afterRestart = await rpc('workspace/list')
  assert.ok(afterRestart.items.some((item) => item.id === createdWorkspace.id && item.cwd === createdCwd), '重启后必须保留新建工作区')
  const restoredEvents = []
  ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.value?.type === 'snapshot') restoredEvents.push(...message.value.records.filter((row) => row.type === 'event').map((row) => row.event))
    if (message.value?.type === 'event') restoredEvents.push(message.value.event)
  }
  ws.send(JSON.stringify({ type: 'open', streamId: 'follow-restored', endpoint: 'session/follow', payload: { args: { request: { address: { sessionId: recoverSession.sessionId } } } } }))
  const restoredApproval = await waitFor(() => restoredEvents.find((event) => event.type === 'approval/request'), '重启后的审批快照')
  assert.equal(restoredApproval.data.reqId, recoverApproval.data.reqId)
  await rpc('session/approve', { sessionId: recoverSession.sessionId, reqId: restoredApproval.data.reqId, response: 'allow-once', optionId: 'allow-once' })
  await waitFor(() => restoredEvents.some((event) => event.type === 'assistant/message' && event.data.message.content === 'Kimi 回复：approve'), '重启恢复审批后的回复')
  assert.ok(rows().some((row) => row.msg?.method === 'session/load' && row.msg.params.sessionId), '恢复审批必须加载原会话')
  assert.ok(rows().some((row) => row.msg?.method === 'session/prompt' && row.msg.params.prompt?.[0]?.text?.startsWith('RECOVER_APPROVAL:')), '恢复审批必须重试原操作')
  assert.ok(!fs.readdirSync(path.join(scratch, 'home', 'sessions')).some((name) => name.endsWith('.approval.json')), '审批完成后必须清除台账')
  console.log('kimi-agent: independent shell + pairing/tunnel + persistent workspaces + sessions/approval + restart approval recovery passed')
} finally {
  ws?.close()
  agent?.close()
  for (const row of rows()) {
    if (row.kind === 'argv') { try { process.kill(row.pid) } catch { } }
  }
}
