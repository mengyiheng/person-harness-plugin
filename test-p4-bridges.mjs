import assert from 'node:assert/strict'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const scratch = path.resolve('diagnostics/.test-p4-bridges')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(scratch, { recursive: true })
async function freePort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}
async function startBridge (file, extra) {
  const port = await freePort()
  const child = spawn(process.execPath, [file, '--port', String(port), ...extra], { stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const deadline = Date.now() + 15_000
  while (!log.includes('就绪') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`${file} 提前退出:\n${log}`)
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  if (!log.includes('就绪')) { child.kill(); throw new Error(`${file} 启动超时:\n${log}`) }
  return { child, port, log: () => log }
}
async function stopBridge (bridge) {
  if (!bridge || bridge.child.exitCode != null) return
  const exited = new Promise((resolve) => bridge.child.once('exit', resolve))
  bridge.child.kill()
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
}
async function rpc (port, method, request = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: method, payload: { args: { request } } }),
    signal: AbortSignal.timeout(20_000)
  })
  const msg = await res.json()
  assert.equal(msg.rpcId, method)
  assert.equal(msg.result.ok, true, JSON.stringify(msg.result.error))
  return msg.result.value
}
async function follow (port, sessionId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const snapshot = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('follow 超时')), 5000)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.value?.type === 'snapshot') { clearTimeout(timer); resolve(msg.value) }
    }
  })
  ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }))
  const value = await snapshot
  ws.close()
  return value
}

let gemini
let pi
let codex
try {
  gemini = await startBridge('lib/p4/gemini-bridge.mjs', ['--reg', path.join(scratch, 'gemini')])
  assert.deepEqual((await rpc(gemini.port, 'session/list')).items, [])
  const created = await rpc(gemini.port, 'session/create')
  const items = (await rpc(gemini.port, 'session/list')).items
  assert.equal(items[0].sessionId, created.sessionId)
  assert.equal(items[0].title, '新对话')
  const gs = await follow(gemini.port, created.sessionId)
  assert.equal(gs.header.id, created.sessionId)
  assert.equal(gs.records[0].event.data.title, '新对话')
  await stopBridge(gemini); gemini = null

  pi = await startBridge('lib/p4/pi-bridge.mjs', ['--sessions', path.join(scratch, 'pi')])
  assert.deepEqual((await rpc(pi.port, 'session/list')).items, [])
  const pc = await rpc(pi.port, 'session/create')
  const ps = await follow(pi.port, pc.sessionId)
  assert.equal(ps.header.id, pc.sessionId)
  assert.deepEqual(ps.records, [])
  await stopBridge(pi); pi = null

  console.log('p4-bridges: gemini + pi passed; checking codex')
  codex = await startBridge('lib/p4/codex-bridge.mjs', ['--codex-home', path.join(scratch, 'codex-home')])
  let cs
  const deadline = Date.now() + 20_000
  while (!cs && Date.now() < deadline) {
    try { cs = await rpc(codex.port, 'session/list') } catch (e) {
      if (Date.now() >= deadline) throw new Error(`${e.message}\n${codex.log()}`)
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  }
  assert.ok(Array.isArray(cs?.items), codex.log())
  const models = await rpc(codex.port, 'model/list')
  assert.ok(Array.isArray(models.items), codex.log())
  assert.ok(models.items.length > 0, '真实 Codex 应返回可用模型')
  assert.equal(typeof models.selected, 'string')
  assert.ok(models.selected.length > 0, '真实 Codex 应给出默认模型')
  await stopBridge(codex); codex = null
  console.log('p4-bridges: gemini + pi + codex startup/list/follow/models passed（未发送模型消息）')
} finally {
  await Promise.all([stopBridge(gemini), stopBridge(pi), stopBridge(codex)])
}
