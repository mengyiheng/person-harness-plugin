import assert from 'node:assert/strict'
import http from 'node:http'
import { AttachSession } from './lib/adapter.mjs'
import { SessionListCache } from './lib/session-list-cache.mjs'

let listCalls = 0
let createCalls = 0
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const rpcId = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').rpcId || 'unknown'
  if (req.url === '/api/session/list') {
    listCalls++
    await new Promise((resolve) => setTimeout(resolve, 80))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      type: 'server-response', rpcId,
      result: { ok: true, value: { items: [{ sessionId: `scan-${listCalls}` }] } }
    }))
    return
  }
  if (req.url === '/api/session/create') {
    createCalls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { sessionId: 'new' } } }))
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
const frames = []
const sessionListCache = new SessionListCache({ ttlMs: 1500 })
const sessions = ['a', 'b'].map((suffix) => new AttachSession(
  { attachId: `att_${suffix}`, peer: {} },
  {
    getOrigin: () => origin,
    mintCookie: async () => 'test-cookie',
    sessionListCache,
    send: (frame) => frames.push(frame),
    log: () => {}
  }
))

function request (session, streamId, path) {
  session._httpOpenPending({ streamId, method: 'POST', path, headers: {} })
  const body = JSON.stringify({
    type: 'client-request', rpcId: `rpc-${streamId}`,
    method: path.slice('/api/'.length), payload: { args: { _request: {} } }
  })
  return session._onData({ streamId, data: Buffer.from(body).toString('base64'), fin: true })
}
function responseBody (streamId) {
  const chunks = frames.filter((f) => f.streamId === streamId && f.type === 'data')
  assert.equal(chunks.at(-1)?.fin, true, `${streamId} 必须有 fin`)
  assert.ok(frames.some((f) => f.streamId === streamId && f.type === 'close'))
  const payload = JSON.parse(Buffer.concat(chunks.map((f) => Buffer.from(f.data, 'base64'))).toString('utf8'))
  assert.equal(payload.rpcId, `rpc-${streamId}`, '响应必须属于发起它的调用者')
  return payload.result.value
}

try {
  await Promise.all([
    request(sessions[0], 'list-1', '/api/session/list'),
    request(sessions[0], 'list-2', '/api/session/list'),
    request(sessions[1], 'list-3', '/api/session/list')
  ])
  assert.equal(listCalls, 1, '跨请求、跨 attach 的相同列表应共享一次上游扫描')
  for (const id of ['list-1', 'list-2', 'list-3']) {
    assert.deepEqual(responseBody(id), { items: [{ sessionId: 'scan-1' }] })
  }

  await request(sessions[0], 'list-cached', '/api/session/list')
  assert.equal(listCalls, 1, '短窗口内应直接复用完整响应')
  assert.deepEqual(responseBody('list-cached'), { items: [{ sessionId: 'scan-1' }] })

  await request(sessions[0], 'create', '/api/session/create')
  assert.equal(createCalls, 1)
  await request(sessions[0], 'list-after-create', '/api/session/list')
  assert.equal(listCalls, 2, '会话写操作后必须重新扫描')
  assert.deepEqual(responseBody('list-after-create'), { items: [{ sessionId: 'scan-2' }] })
  console.log('adapter-session-list: 4 tests passed')
} finally {
  sessions.forEach((session) => session.detach())
  await new Promise((resolve) => server.close(resolve))
}
