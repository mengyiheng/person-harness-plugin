// 只读 NAT 环境诊断：同一 UDP socket 访问两个 STUN 服务、NAT-PMP 外网地址、UPnP SSDP 发现。
// 不申请端口映射，不修改路由器或系统配置；UDP 结果只用于判断候选路径，不能替代 TCP 结论。
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

const TIMEOUT_MS = 4000
const COOKIE = 0x2112a442
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const stunRequest = () => {
  const packet = Buffer.alloc(20)
  packet.writeUInt16BE(0x0001, 0)
  packet.writeUInt16BE(0, 2)
  packet.writeUInt32BE(COOKIE, 4)
  randomBytes(12).copy(packet, 8)
  return packet
}

const parseStunAddress = (packet) => {
  if (packet.length < 20 || packet.readUInt16BE(0) !== 0x0101 || packet.readUInt32BE(4) !== COOKIE) return null
  const declared = packet.readUInt16BE(2)
  let offset = 20
  const end = Math.min(packet.length, 20 + declared)
  while (offset + 4 <= end) {
    const type = packet.readUInt16BE(offset)
    const length = packet.readUInt16BE(offset + 2)
    const value = offset + 4
    if (value + length > end || length < 8) break
    const family = packet[value + 1]
    if ((type === 0x0020 || type === 0x0001) && family === 0x01) {
      const port = packet.readUInt16BE(value + 2) ^ (type === 0x0020 ? (COOKIE >>> 16) : 0)
      let ip
      if (type === 0x0020) {
        const raw = packet.readUInt32BE(value + 4) ^ COOKIE
        ip = [(raw >>> 24) & 255, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join('.')
      } else {
        ip = [...packet.subarray(value + 4, value + 8)].join('.')
      }
      return { ip, port, attribute: type === 0x0020 ? 'XOR-MAPPED-ADDRESS' : 'MAPPED-ADDRESS' }
    }
    offset = value + length + ((4 - (length % 4)) % 4)
  }
  return null
}

const probeStun = async () => {
  const servers = [
    ['stun-a', 'stun.l.google.com', 19302],
    ['stun-b', 'stun.cloudflare.com', 3474],
    ['stun-d', 'stun.miwifi.com', 3478],
    ['stun-e', 'stun.qq.com', 3478],
    ['stun-f', 'stun.freeswitch.org', 3478],
    ['stun-g', 'stun.sipgate.net', 3478],
    ['stun-h', 'stun.ekiga.net', 3478]
  ]
  const socket = dgram.createSocket('udp4')
  const results = []
  const pending = new Map()
  socket.on('message', (packet, remote) => {
    const address = parseStunAddress(packet)
    if (!address || packet.length < 20) return
    const transaction = packet.subarray(8, 20).toString('hex')
    const item = pending.get(transaction)
    if (item && !results.some((result) => result.transaction === transaction)) {
      results.push({ server: item.name, resolved: item.endpoint, transaction, ok: true, ...address })
    }
  })
  await new Promise((resolve) => socket.bind(0, '0.0.0.0', resolve))
  const localPort = socket.address().port
  try {
    for (const [name, host, port] of servers) {
      try {
        const { address } = await dns.lookup(host, { family: 4 })
        const request = stunRequest()
        const transaction = request.subarray(8, 20).toString('hex')
        const endpoint = `${address}:${port}`
        pending.set(transaction, { name, endpoint })
        socket.send(request, port, address)
      } catch (error) {
        results.push({ server: name, ok: false, error: error.message })
      }
    }
    const deadline = Date.now() + TIMEOUT_MS
    while (results.filter((result) => result.ok).length < pending.size && Date.now() < deadline) await sleep(50)
    for (const [transaction, item] of pending) {
      if (!results.some((result) => result.transaction === transaction)) {
        results.push({ server: item.name, resolved: item.endpoint, transaction, ok: false, error: 'timeout' })
      }
    }
  } finally {
    socket.close()
  }
  const successful = results.filter((result) => result.ok)
  const mapped = successful.map(({ ip, port }) => `${ip}:${port}`)
  const independentEndpoints = new Set(successful.map((result) => result.resolved)).size
  return {
    localPort,
    results,
    mappingReusedAcrossServers: independentEndpoints >= 2 && mapped.length >= 2 && new Set(mapped).size === 1
  }
}

const probeNatPmp = async (gateway = '192.168.1.1') => {
  const socket = dgram.createSocket('udp4')
  let response = null
  socket.on('message', (packet, remote) => {
    if (packet.length >= 12 && packet[0] === 0 && packet[1] === 128) {
      response = {
        ok: packet.readUInt16BE(2) === 0,
        resultCode: packet.readUInt16BE(2),
        externalIp: [...packet.subarray(8, 12)].join('.'),
        server: `${remote.address}:${remote.port}`
      }
    }
  })
  await new Promise((resolve) => socket.bind(0, '0.0.0.0', resolve))
  try {
    socket.send(Buffer.alloc(2), 5351, gateway)
    const deadline = Date.now() + TIMEOUT_MS
    while (!response && Date.now() < deadline) await sleep(50)
    return response || { ok: false, error: 'timeout-or-unsupported', gateway }
  } finally {
    socket.close()
  }
}

const probeUpnp = async () => {
  const socket = dgram.createSocket('udp4')
  const responses = []
  socket.on('message', (packet, remote) => {
    const text = packet.toString('utf8')
    const location = text.match(/^LOCATION:\s*(.+)$/im)?.[1]?.trim()
    const st = text.match(/^ST:\s*(.+)$/im)?.[1]?.trim()
    responses.push({ server: `${remote.address}:${remote.port}`, st, location })
  })
  await new Promise((resolve) => socket.bind(0, '0.0.0.0', resolve))
  try {
    for (const st of ['urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1']) {
      const message = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`
      socket.send(Buffer.from(message), 1900, '239.255.255.250')
    }
    await sleep(TIMEOUT_MS)
    return { ok: responses.length > 0, responses }
  } finally {
    socket.close()
  }
}

const report = {
  timestamp: new Date().toISOString(),
  scope: 'PC read-only probes; UDP results do not prove TCP behavior or phone-side NAT behavior',
  stun: await probeStun(),
  natPmp: await probeNatPmp(),
  upnp: await probeUpnp()
}
console.log(JSON.stringify(report, null, 2))
