import assert from 'node:assert/strict'
import { SessionListCache } from './lib/session-list-cache.mjs'

const request = (rpcId = 'one', listRequest = {}) => ({
  origin: 'http://127.0.0.1:3080',
  path: '/api/session/list',
  method: 'POST',
  body: Buffer.from(JSON.stringify({
    type: 'client-request', rpcId, method: 'session/list',
    payload: { args: { _request: listRequest } }
  }))
})
const reply = async (value, status = 200, rpcId = 'one') => new Response(JSON.stringify({
  type: 'server-response', rpcId, result: status === 200 ? { ok: true, value } : { ok: false, error: value }
}), {
  status,
  headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }
})
const read = async (res) => {
  const payload = await res.json()
  return { status: res.status, rpcId: payload.rpcId, body: payload.result.value || payload.result.error }
}

let now = 1000
const cache = new SessionListCache({ ttlMs: 1500, now: () => now })
let calls = 0
let release
const gate = new Promise((resolve) => { release = resolve })
const fetcher = async () => {
  calls++
  await gate
  return reply({ items: [{ sessionId: 'one' }] })
}
const first = cache.fetch(request('one'), fetcher)
const second = cache.fetch(request('two'), fetcher)
const third = cache.fetch(request('three'), fetcher)
release()
const all = await Promise.all([first, second, third])
assert.equal(calls, 1, '不同 rpcId 的相同并发请求必须只访问一次上游')
for (const [index, res] of all.entries()) {
  const result = await read(res)
  assert.equal(result.rpcId, ['one', 'two', 'three'][index], '每份响应必须恢复自己的 rpcId')
  assert.deepEqual(result.body, { items: [{ sessionId: 'one' }] })
}

await read(await cache.fetch(request('four'), fetcher))
assert.equal(calls, 1, '完成后的短窗口内应复用结果')
now += 1501
await read(await cache.fetch(request(), async () => { calls++; return reply({ items: [] }) }))
assert.equal(calls, 2, '超过短窗口必须重新访问上游')

await cache.fetch(request('workspace', { workspace: 'a' }), async () => { calls++; return reply({ items: ['a'] }, 200, 'workspace') })
assert.equal(calls, 3, '不同列表参数不能混用缓存')

now += 1501
await read(await cache.fetch(request(), async () => { calls++; return reply({ items: ['before-mutation'] }) }))
assert.equal(calls, 4)
cache.invalidate()
await read(await cache.fetch(request(), async () => { calls++; return reply({ items: ['after-mutation'] }) }))
assert.equal(calls, 5, '写操作失效后必须重新读取')

now += 1501
let releaseOld
const oldGate = new Promise((resolve) => { releaseOld = resolve })
const oldFetch = cache.fetch(request(), async () => {
  calls++
  await oldGate
  return reply({ items: ['old-in-flight'] })
})
await new Promise((resolve) => setImmediate(resolve))
cache.invalidate()
const newFetch = cache.fetch(request(), async () => { calls++; return reply({ items: ['new-in-flight'] }) })
releaseOld()
assert.deepEqual((await read(await oldFetch)).body, { items: ['old-in-flight'] })
assert.deepEqual((await read(await newFetch)).body, { items: ['new-in-flight'] })
assert.equal(calls, 7, '失效前已经开始的请求不能被新调用者加入')

let failures = 0
const failing = () => cache.fetch(request('failure', { case: 'failure' }), async () => { failures++; throw new Error('upstream down') })
await assert.rejects(failing(), /upstream down/)
await assert.rejects(failing(), /upstream down/)
assert.equal(failures, 2, '失败结果不能缓存')

let errors = 0
await read(await cache.fetch(request('error', { case: 'error' }), async () => { errors++; return reply({ error: 'denied' }, 403, 'error') }))
await read(await cache.fetch(request('error', { case: 'error' }), async () => { errors++; return reply({ error: 'denied' }, 403, 'error') }))
assert.equal(errors, 2, '非 200 响应不能在完成窗口内缓存')

let malformed = 0
const malformedRequest = { ...request(), body: Buffer.from('{}') }
await cache.fetch(malformedRequest, async () => { malformed++; return new Response('{}') })
await cache.fetch(malformedRequest, async () => { malformed++; return new Response('{}') })
assert.equal(malformed, 2, '无法识别 rpcId 的请求必须原样直通')

console.log('session-list-cache: 9 tests passed')
