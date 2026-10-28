import assert from 'node:assert/strict'
import http from 'node:http'
import { AttachSession } from './lib/adapter.mjs'
import { createTargets } from './lib/targets.mjs'
import { usesDshShell, normalizeBridgeMux } from './lib/dsh-shell.mjs'

const calls = { dsh: [], bridge: [] }
function listen (handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
function rpc (req, value, ok = true) {
  return JSON.stringify({
    type: 'server-response', rpcId: req.rpcId,
    result: ok ? { ok: true, value } : { ok: false, error: { code: 'unsupported', message: value } }
  })
}
async function bodyOf (req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(raw || '{}') } catch { return {} }
}

const dsh = await listen(async (req, res) => {
  const body = await bodyOf(req)
  calls.dsh.push({ url: req.url, cookie: req.headers.cookie || '' })
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>dsh shell</html>')
  } else if (req.url === '/assets/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end('window.shell=true')
  } else if (req.url === '/api/settings/describe') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(rpc(body, { namespaces: [] }))
  } else {
    res.writeHead(500).end('unexpected dsh request')
  }
})
const bridge = await listen(async (req, res) => {
  const body = await bodyOf(req)
  calls.bridge.push({ url: req.url, cookie: req.headers.cookie || '' })
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/api/session/list') {
    res.end(rpc(body, { items: [{ sessionId: 'c1', title: 'Codex 会话', cwd: 'D:\\work', updatedAt: 1234 }] }))
  } else if (req.url === '/api/session/prompt') {
    res.end(rpc(body, {}))
  } else if (req.url === '/api/session/page') {
    res.end(rpc(body, { records: [], cursor: 0 }))
  } else if (req.url === '/api/session/cancel') {
    res.end(rpc(body, '桥不支持 cancel', false))
  } else if (req.url === '/') {
    res.end(rpc(body, { native: true }))
  } else {
    res.end(rpc(body, 'not found', false))
  }
})
const dshOrigin = `http://127.0.0.1:${dsh.address().port}`
const bridgeOrigin = `http://127.0.0.1:${bridge.address().port}`
const targets = createTargets({
  cfg: { targets: [
    { name: 'dsh', origin: 'origin:dsh', auth: 'cookie-self' },
    { name: 'codex', label: 'Codex', origin: bridgeOrigin, shell: 'dsh' },
    { name: 'plain', origin: bridgeOrigin }
  ] },
  getOrigin: () => dshOrigin,
  mintCookie: async () => 'owner-cookie'
})
const frames = []
const attached = new AttachSession({ attachId: 'test', peer: {} }, {
  getOrigin: () => dshOrigin,
  mintCookie: async () => 'owner-cookie',
  targets,
  send: (frame) => frames.push(frame),
  log: () => {}
})
let nextId = 0
async function request (path, { method = 'GET', referer = 'http://local/t/codex/', value = {} } = {}) {
  const streamId = `s${++nextId}`
  attached._httpOpenPending({ streamId, method, path, headers: referer ? { referer } : {} })
  const body = method === 'POST' ? JSON.stringify({ type: 'client-request', rpcId: `rpc-${streamId}`, payload: { args: { request: value } } }) : ''
  await attached._onData({ streamId, data: Buffer.from(body).toString('base64'), fin: true })
  const own = frames.filter((f) => f.streamId === streamId)
  const chunks = own.filter((f) => f.type === 'data')
  assert.equal(chunks.at(-1)?.fin, true, `${path} 必须有 fin`)
  assert.ok(own.some((f) => f.type === 'close'), `${path} 必须关闭`)
  const raw = Buffer.concat(chunks.map((f) => Buffer.from(f.data, 'base64')))
  return {
    raw,
    text: raw.toString('utf8'),
    head: own.find((f) => f.type === 'http-head')
  }
}

try {
  const index = await request('/t/codex/')
  assert.equal(index.text, '<html>dsh shell</html>', '目标根页面应来自 dsh')
  assert.equal(calls.dsh.at(-1).cookie, 'owner-cookie', 'dsh 壳必须携带有权限的 Cookie')

  const asset = await request('/assets/app.js', { referer: 'http://local/t/codex/' })
  assert.equal(asset.text, 'window.shell=true', '根绝对资源应回源到 dsh 壳')
  assert.match(asset.head.headers['cache-control'], /immutable/)

  const settings = await request('/api/settings/describe', { method: 'POST' })
  assert.deepEqual(JSON.parse(settings.text).result.value, { namespaces: [] }, '通用只读配置可由 dsh 提供')

  const list = await request('/api/session/list', { method: 'POST' })
  const listValue = JSON.parse(list.text).result.value
  assert.equal(listValue.items[0].sessionId, 'c1')
  assert.equal(listValue.items[0].blank, false)
  assert.equal(listValue.items[0].projections.kind, 'cached')
  assert.equal(listValue.items[0].projections.values.title, 'Codex 会话')
  assert.equal(listValue.items[0].projections.values.sessionListMetadata.lastPromptAt, 1234)

  const prompt = await request('/api/session/prompt', { method: 'POST', value: { sessionId: 'c1', content: [{ type: 'text', text: 'hi' }] } })
  assert.equal(JSON.parse(prompt.text).result.value.accepted, true, 'prompt 必须有当前契约的 accepted')
  const page = await request('/api/session/page', { method: 'POST' })
  assert.equal(JSON.parse(page.text).result.value.hasMore, false, 'page 必须有 hasMore')

  const beforeLocal = calls.dsh.length + calls.bridge.length
  const catalog = await request('/api/session/modelCatalog', { method: 'POST' })
  const catalogValue = JSON.parse(catalog.text).result.value
  assert.equal(catalogValue.default.provider, 'codex')
  assert.equal(catalogValue.groups[0].name, 'Codex')
  const commands = await request('/api/commands/list', { method: 'POST' })
  assert.deepEqual(JSON.parse(commands.text).result.value, { commands: [] }, '不得把 dsh 命令伪装成外部 Agent 命令')
  assert.equal(calls.dsh.length + calls.bridge.length, beforeLocal, '本地兼容响应不应访问任何上游')

  const dshBeforeCancel = calls.dsh.length
  const cancel = await request('/api/session/cancel', { method: 'POST' })
  assert.equal(JSON.parse(cancel.text).result.ok, false)
  assert.equal(calls.dsh.length, dshBeforeCancel, '未支持的会话操作绝不能落到 dsh 本体')

  const plain = await request('/t/plain/')
  assert.equal(JSON.parse(plain.text).result.value.native, true, '普通 Web 目标行为必须保持不变')

  assert.equal(usesDshShell({ shell: 'dsh' }, '/api/session/list'), false)
  assert.equal(usesDshShell({ shell: 'dsh' }, '/assets/index.js'), true)
  const snapshot = JSON.parse(normalizeBridgeMux(JSON.stringify({
    type: 'item', streamId: 'w1', value: {
      type: 'snapshot', header: { id: 'c1', cwd: 'codex' }, cursor: 7,
      records: [{ type: 'event', event: { type: 'session/title', seq: 0, data: { title: 'Codex 会话' } } }]
    }
  }))).value
  assert.equal(snapshot.header.version, 1)
  assert.equal(snapshot.header.createdAt, 0)
  assert.equal(snapshot.header.isSeeded, false)
  assert.equal(snapshot.hasMore, false)
  assert.equal(snapshot.projections.asOfSeq, 7)
  assert.equal(snapshot.projections.values.title, 'Codex 会话')

  console.log('dsh-shell: 12 tests passed')
} finally {
  attached.detach()
  await Promise.all([
    new Promise((resolve) => dsh.close(resolve)),
    new Promise((resolve) => bridge.close(resolve))
  ])
}
