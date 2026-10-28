// tunnel.mjs 无声顶号自愈：本地假 relay 验证
import { WebSocketServer } from 'ws'
import { TunnelClient } from './lib/tunnel.mjs'

let connections = 0
const wss = new WebSocketServer({ port: 19400 }, () => console.log('fake relay up'))
wss.on('connection', (ws) => {
  connections++
  console.log('relay: connection #' + connections)
  ws.on('message', (d) => {
    const f = JSON.parse(String(d))
    if (f.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', role: 'pc', deviceId: 'dev_test' }))
    if (f.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
  })
})

const logs = []
const t = new TunnelClient({
  relayUrl: 'ws://127.0.0.1:19400/api/v1/tunnel',
  identity: { deviceToken: 'tok_test' },
  deps: { log: (...a) => { logs.push(a.join(' ')); console.log('client:', ...a) } }
})
t.start()

await new Promise((r) => setTimeout(r, 1500))
console.log('--- 用例1：新鲜时间戳，_maybeRefresh 应为无操作 ---')
t._maybeRefresh()
await new Promise((r) => setTimeout(r, 800))
console.log('connections still =', connections, connections === 1 ? 'PASS' : 'FAIL')

console.log('--- 用例2：伪造旧时间戳，应触发重连 ---')
t._connectedAt = Date.now() - 11 * 60 * 1000
t._maybeRefresh()
await new Promise((r) => setTimeout(r, 1500))
console.log('connections =', connections, connections === 2 ? 'PASS' : 'FAIL')

console.log('--- 用例3：有 attach 会话时应跳过 ---')
t._connectedAt = Date.now() - 11 * 60 * 1000
t.sessions.set('fake', {})
t._maybeRefresh()
await new Promise((r) => setTimeout(r, 800))
console.log('connections =', connections, connections === 2 ? 'PASS' : 'FAIL')
t.sessions.clear()

console.log('--- 用例4：_lastBusy 新近（刚 detach 完）应跳过 ---')
t._connectedAt = Date.now() - 20 * 60 * 1000
t._lastBusy = Date.now() - 1000
t._maybeRefresh()
await new Promise((r) => setTimeout(r, 800))
console.log('connections =', connections, connections === 2 ? 'PASS' : 'FAIL')

console.log('--- 用例5：stopping 后不再刷新 ---')
t.stopping = true
t._connectedAt = Date.now() - 20 * 60 * 1000
t._lastBusy = 0
t._maybeRefresh()
await new Promise((r) => setTimeout(r, 800))
console.log('connections =', connections, connections === 2 ? 'PASS' : 'FAIL')

t.stop()
wss.close()
const pass = logs.some((l) => l.includes('计划性重连'))
console.log('日志含计划性重连提示:', pass ? 'PASS' : 'FAIL')
process.exit(0)
