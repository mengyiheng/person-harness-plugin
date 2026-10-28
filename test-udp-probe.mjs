import assert from 'node:assert/strict'
import { UdpProbe, mappingPredictionTargets } from './lib/udp-probe.mjs'

const predicted = mappingPredictionTargets([
  { ip: '111.55.145.38', port: 33365 },
  { ip: '111.55.145.38', port: 3282 },
  { ip: '111.55.145.38', port: 34739 }
])
assert.ok(predicted.some(item => item.ip === '111.55.145.38' && item.port === 36113))
assert.ok(predicted.some(item => item.ip === '111.55.145.38' && item.port === 31991))
assert.ok(predicted.every(item => item.port > 0 && item.port <= 65535))
assert.equal(mappingPredictionTargets([{ ip: '127.0.0.1', port: 5000 }]).length, 0)
const learned = mappingPredictionTargets([
  { ip: '111.55.145.38', port: 53501 },
  { ip: '111.55.145.38', port: 3630 },
  { ip: '111.55.145.38', port: 19880 }
], 4, [
  { ip: '111.55.145.38', port: 53490 },
  { ip: '111.55.145.38', port: 3629 },
  { ip: '111.55.145.38', port: 19507 }
])
for (const port of [53512, 3628, 20253]) {
  assert.ok(learned.some(item => item.ip === '111.55.145.38' && item.port === port), `missing learned port ${port}`)
}
console.log('udp-probe: observed NAT mapping + cross-attach +1/+11/+373 history learning passed')

const attachId = 'att_udp_probe_test'
const received = { pc: [], phone: [] }
let pc
let phone
const options = (name) => ({
  attachId,
  stunServers: [],
  localCandidate: { ip: '127.0.0.1' },
  discoveryMs: 20,
  probeIntervalMs: 20,
  lifetimeMs: 300,
  sendRelay: (frame) => (name === 'pc' ? phone : pc).onPeer(frame),
  onFrame: (frame) => received[name].push(frame),
  log: () => {}
})
pc = new UdpProbe(options('pc'))
phone = new UdpProbe(options('phone'))
try {
  await Promise.all([pc.start(), phone.start()])
  const deadline = Date.now() + 1000
  while ((!pc.isDirect() || !phone.isDirect()) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(pc.synSeen, true)
  assert.equal(phone.synSeen, true)
  assert.equal(pc.ackSeen, true)
  assert.equal(phone.ackSeen, true)
  assert.equal(pc.isDirect(), true)
  assert.equal(phone.isDirect(), true)
  assert.equal(pc.send({ type: 'data', text: '电'.repeat(3000) }), true)
  assert.equal(phone.send({ type: 'data', text: 'phone-to-pc' }), true)
  while ((received.pc.length < 1 || received.phone.length < 1 || pc.reliable.pending.size || phone.reliable.pending.size) && Date.now() < deadline + 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(received.pc[0].text, 'phone-to-pc')
  assert.equal(received.phone[0].text, '电'.repeat(3000))
  assert.ok(received.pc[0].udpId)
  assert.ok(received.phone[0].udpId)
  // 原探针寿命只有 300ms；超过该时间后仍活跃，证明业务直连不会被旧定时器掐断。
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(pc.isDirect(), true)
  assert.equal(phone.isDirect(), true)
  console.log('udp-probe: candidate exchange + SYN/ACK + reliable bidirectional business frames + lifetime handoff passed')
} finally {
  pc.stop()
  phone.stop()
}
