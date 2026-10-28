import assert from 'node:assert/strict'
import { ReliableUdpChannel } from './lib/reliable-udp.mjs'

const DATA = 1
const ACK = 2
const waitFor = async (predicate, message, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timeout: ${message}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// 场景一：大帧、多消息、DATA 乱序/重复，且每片首轮 ACK 必丢，强制走重传。
{
  const received = []
  const firstAckDropped = new Set()
  let a
  let b
  const forward = (packet, target, direction) => {
    const type = packet[4]
    const messageId = packet.readUInt32BE(6)
    const fragmentIndex = packet.readUInt16BE(10)
    const key = `${direction}:${messageId}:${fragmentIndex}`
    if (type === ACK && !firstAckDropped.has(key)) {
      firstAckDropped.add(key)
      return
    }
    const copy = Buffer.from(packet)
    // 不固定的短延迟会让不同消息、不同分片乱序到达。
    setTimeout(() => target.handlePacket(copy), Math.floor(Math.random() * 20))
    if (type === DATA) setTimeout(() => target.handlePacket(Buffer.from(copy)), 25 + Math.floor(Math.random() * 20))
  }
  a = new ReliableUdpChannel({
    channelId: 'A',
    sendPacket: (packet) => forward(packet, b, 'a-b'),
    onFrame: () => {},
    log: () => {}
  })
  b = new ReliableUdpChannel({
    channelId: 'B',
    sendPacket: (packet) => forward(packet, a, 'b-a'),
    onFrame: (frame) => received.push(frame),
    onFail: (frames) => { throw new Error(`unexpected fallback: ${frames.length}`) },
    log: () => {}
  })
  try {
    const input = [
      { type: 'data', seq: 1, text: '汉'.repeat(30 * 1024) },
      { type: 'data', seq: 2, text: 'second' },
      { type: 'data', seq: 3, text: 'third' },
      { type: 'data', seq: 4, text: 'fourth' },
      { type: 'data', seq: 5, text: 'fifth' },
      { type: 'close', seq: 6 }
    ]
    input.forEach((frame) => assert.equal(a.send(frame), true))
    await waitFor(() => received.length === input.length && a.pending.size === 0, 'ordered large-frame delivery and final ACKs')
    assert.deepEqual(received, input.map((frame, index) => ({ ...frame, udpId: `A:${index + 1}` })))
    assert.ok(firstAckDropped.size > 30, 'large frame must be fragmented and ACK loss must be exercised')
    assert.equal(a.pending.size, 0)
    assert.equal(a.queue.length, 0)
    assert.equal(b.incoming.size, 0)
    assert.equal(b.completed.size, 0)
    console.log('reliable-udp: fragmentation + reorder + duplicate DATA + ACK-loss retransmission + ordering passed')
  } finally {
    a.stop()
    b.stop()
  }
}

// 场景二：链路完全无入包，空闲判死后返回全部在途帧和排队帧，顺序不变；正常 stop 不再次回放。
{
  let failed
  let failCount = 0
  const sender = new ReliableUdpChannel({
    channelId: 'FAIL',
    sendPacket: () => {}, // 模拟全部 outgoing 黑洞
    onFrame: () => {},
    onFail: (frames) => { failCount++; failed = frames },
    log: () => {}
  })
  const idlePeer = new ReliableUdpChannel({
    channelId: 'PEER',
    sendPacket: () => {},
    onFrame: () => {},
    onFail: () => {},
    log: () => {}
  })
  try {
    for (let seq = 1; seq <= 7; seq++) sender.send({ type: 'data', seq })
    sender.lastReceived = Date.now() - 13000
    await waitFor(() => failed !== undefined, 'idle failure and relay replay', 5000)
    assert.equal(failCount, 1)
    assert.equal(sender.active, false)
    assert.deepEqual(failed.map((frame) => frame.seq), [1, 2, 3, 4, 5, 6, 7])
    assert.deepEqual(failed.map((frame) => frame.udpId), ['FAIL:1', 'FAIL:2', 'FAIL:3', 'FAIL:4', undefined, undefined, undefined])
    sender.stop()
    assert.equal(failCount, 1, 'normal stop must not replay again')
    console.log('reliable-udp: idle failure + ordered in-flight/queued replay + normal-stop semantics passed')
  } finally {
    sender.stop()
    idlePeer.stop()
  }
}
