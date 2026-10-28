import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { Punch } from './lib/punch.mjs'

const freePort = async () => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const makePeer = (role, attachId, relayFrames) => new Punch({
  host: '127.0.0.1',
  regPort: 1,
  attachId,
  role,
  token: 'local-test',
  sendRelay: (frame) => relayFrames.push({ role, frame }),
  log: () => {}
})

const attachId = 'att_local_punch_test'
const relayFrames = []
const pc = makePeer('pc', attachId, relayFrames)
const phone = makePeer('phone', attachId, relayFrames)
const pcFrames = []
const phoneFrames = []
let pcDown = 0
let phoneDown = 0
pc.onFrame((frame) => pcFrames.push(frame))
phone.onFrame((frame) => phoneFrames.push(frame))
pc.onDown = () => { pcDown += 1 }
phone.onDown = () => { phoneDown += 1 }

try {
  pc.localPort = await freePort()
  phone.localPort = await freePort()
  pc.onMatch({ ip: '127.0.0.1', port: phone.localPort })
  phone.onMatch({ ip: '127.0.0.1', port: pc.localPort })
  await waitFor(() => pc.established && phone.established, 'simultaneous-open handshake')

  // 双路同时打开可能产生胜负 socket；等待旧 socket close，确认不会误断胜出的连接。
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(pc.established, true)
  assert.equal(phone.established, true)

  pc.send({ type: 'data', attachId, streamId: 'pc-to-phone', data: 'AQID' })
  phone.send({ type: 'data', attachId, streamId: 'phone-to-pc', data: 'BAUG' })
  await waitFor(() => pcFrames.length === 1 && phoneFrames.length === 1, 'bidirectional encrypted-frame transport')
  assert.equal(pcFrames[0].streamId, 'phone-to-pc')
  assert.equal(phoneFrames[0].streamId, 'pc-to-phone')

  pc.sock.destroy()
  await waitFor(() => !pc.established && !phone.established && pcDown === 1 && phoneDown === 1, 'direct-down fallback')
  const reverts = relayFrames.filter(({ frame }) => frame.type === 'punch-revert')
  assert.ok(reverts.length >= 2, 'both peers must notify the relay to resume forwarding')
  assert.ok(relayFrames.some(({ frame }) => frame.type === 'punch-local'), 'PC must advertise LAN candidates')
  console.log('punch: simultaneous open + bidirectional frames + stale-socket guard + relay fallback passed')
} finally {
  pc.stop()
  phone.stop()
}
