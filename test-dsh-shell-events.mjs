import assert from 'node:assert/strict'
import { normalizeBridgeMux } from './lib/dsh-shell.mjs'

const state = { nextSeq: 1, assistantSeqs: new Map() }
const snapshot = JSON.parse(normalizeBridgeMux(JSON.stringify({
  type: 'item', streamId: 's', value: {
    type: 'snapshot', header: { id: 'c1', cwd: 'D:\\work' }, cursor: 7,
    records: [
      { type: 'event', event: { type: 'user/message', seq: 3, data: { content: 'hello' } } },
      { type: 'event', event: { type: 'assistant/message', seq: 7, data: { message: { content: 'world' } } } }
    ]
  }
}), state)).value
const [user, assistant] = snapshot.records.map((r) => r.event)
assert.equal(Number.isSafeInteger(user.time), true)
assert.equal(user.surfaceOp, 'append')
assert.deepEqual(user.data.content, [{ type: 'text', text: 'hello' }])
assert.deepEqual(user.data.source, { kind: 'user' })
assert.equal(assistant.data.message.role, 'assistant')
assert.deepEqual(assistant.data.message.content, [{ type: 'text', text: 'world' }])
assert.deepEqual(assistant.data.message.source, { kind: 'model', provider: 'external', model: 'default' })
assert.deepEqual(assistant.data.stream, [])
assert.equal(state.nextSeq, 8)

function live (event) {
  return JSON.parse(normalizeBridgeMux(JSON.stringify({ type: 'item', streamId: 'live', value: { type: 'event', event } }), state)).value.event
}
const turnStart = live({ type: 'turn/start', seq: 0, data: {} })
const turnEnd = live({ type: 'turn/end', seq: 0, data: {} })
assert.equal(turnStart.seq, 8)
assert.equal(turnEnd.seq, 9)
assert.deepEqual(turnStart.data, { turn: 1 })
assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'completed' } })
const streamA = live({ type: 'assistant/message', seq: 11, data: { message: { content: 'A' } } })
const streamB = live({ type: 'assistant/message', seq: 11, data: { message: { content: 'AB' } } })
assert.equal(streamA.seq, streamB.seq, '同一旧流式消息应保持同一新 seq')
const approval = live({ type: 'approval/request', seq: 0, data: { reqId: 'r1', permission: 'Write', command: 'write file', options: [] } })
assert.equal(approval.type, 'approval/asked')
assert.equal(approval.data.id, 'r1')
assert.equal(approval.data.toolName, 'Write')
assert.equal(approval.data.reason, 'write file')
assert.equal('options' in approval.data, false)
console.log('dsh-shell-events: envelope、消息块、实时 seq 与审批转换 passed')
