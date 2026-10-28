import assert from 'node:assert/strict'
import vm from 'node:vm'
import { chatShellHtml } from './lib/chat-shell.mjs'

const html = chatShellHtml('Kimi Code')
assert.match(html, /height:100vh;height:100dvh/, '旧 WebView 必须有 vh 高度回退')
assert.match(html, /\.chat\{flex:1;min-height:0;overflow:auto/, '聊天区必须可收缩，不能把审批和输入区挤成零高度')
assert.match(html, /\.approvals\{[^}]*max-height:45vh;max-height:45dvh;overflow:auto;flex:none/, '长审批卡必须限高可滚动并兼容旧 WebView')
assert.match(html, /\.composer-wrap\{flex:none;/, '输入区不可被长对话或审批卡压缩')
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || ''
const start = script.indexOf('function connect()')
const end = script.indexOf('function openSession', start)
assert.ok(start >= 0 && end > start, '必须能提取轻壳 connect 实现')

const timers = new Map()
let nextTimer = 1
const sockets = []
const dot = { className: '' }
class FakeWebSocket {
  constructor (url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    sockets.push(this)
  }

  send (text) { this.sent.push(text) }
  close () { this.readyState = 3 }
}
const context = {
  active: 'session-a',
  ws: null,
  reconnectTimer: 0,
  location: { protocol: 'http:', host: '127.0.0.1:9411' },
  WebSocket: FakeWebSocket,
  $: () => dot,
  uuid: () => 'test-stream',
  setTimeout: (fn, delay) => {
    const id = nextTimer++
    timers.set(id, { fn, delay })
    return id
  },
  clearTimeout: (id) => timers.delete(id)
}
vm.createContext(context)
vm.runInContext(`${script.slice(start, end)}\nthis.connect = connect; this.currentWs = () => ws`, context)

context.connect()
const first = context.currentWs()
first.onopen()
assert.equal(dot.className, 'dot on')
assert.match(first.sent[0], /session\/follow/)

context.connect()
const second = context.currentWs()
assert.notEqual(first, second)
first.onclose()
assert.equal(timers.size, 0, '旧 socket 的 onclose 不得给新 socket 安排重连')
first.onmessage({ data: 'not json' })
first.onerror()
assert.notEqual(second.readyState, 3, '旧 socket 的 onerror 不得关闭新 socket')

second.onclose()
assert.equal(timers.size, 1)
assert.equal([...timers.values()][0].delay, 1800)
context.connect()
const third = context.currentWs()
assert.equal(timers.size, 0, '主动 connect 必须清除当前重连定时器')
second.onclose()
assert.equal(timers.size, 0, '已替换连接重复 onclose 仍不得调度')

third.onclose()
const pending = [...timers.entries()][0]
assert.ok(pending, '当前连接断开应安排一次重连')
timers.delete(pending[0])
pending[1].fn()
assert.equal(context.currentWs(), sockets.at(-1))
assert.notEqual(context.currentWs(), third)
assert.equal(timers.size, 0)

console.log('chat-shell: stale socket open/message/error/close isolation and single reconnect passed')
