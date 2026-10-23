// ws-lite：零依赖 WebSocket 服务端（RFC6455 子集，mock 中继专用）
// 支持：text 帧（含分片聚合）、ping/pong、close、首帧 auth 窗口；不支持 binary、扩展。
// 生产环境请用正经 ws 库 / 网关；本文件只为 mock 免 npm install。
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const accept = (key) => createHash('sha1').update(key + GUID).digest('base64')

function encodeFrame (opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2); header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

// 解析客户端帧（必须带掩码）；返回 {opcode, payload} | null(需更多数据) | 'closed'
function parseFrame (buf) {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let off = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4 }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10 }
  const maskOff = off
  if (masked) off += 4
  if (buf.length < off + len) return null
  let payload = buf.subarray(off, off + len)
  if (masked) {
    const mask = buf.subarray(maskOff, maskOff + 4)
    const un = Buffer.alloc(len)
    for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i & 3]
    payload = un
  }
  return { fin, opcode, payload, total: off + len }
}

export class WsLite {
  // handler: (ws, req) => void；只接管 path 匹配的 upgrade
  constructor (server, path, handler) {
    this.path = path
    server.on('upgrade', (req, socket) => {
      console.log(`[ws-lite] upgrade ${req.url} from ${req.socket.remoteAddress} key=${req.headers['sec-websocket-key'] ? '有' : '无'} upgrade=${req.headers.upgrade}`)
      if (new URL(req.url, 'http://x').pathname !== path) { console.log('[ws-lite] path 不匹配，断开'); socket.destroy(); return }
      const key = req.headers['sec-websocket-key']
      if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return }
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`)
      socket.setNoDelay(true)
      const ws = this._wrap(socket, req)
      handler(ws, req)
    })
  }

  _wrap (socket, req) {
    const ws = {
      req,
      readyState: 1,
      ontext: null, onclose: null, onpong: null,
      _frag: null,
      send (str) { if (socket.writable) socket.write(encodeFrame(1, Buffer.from(str, 'utf8'))) },
      ping () { if (socket.writable) socket.write(encodeFrame(9, Buffer.alloc(0))) },
      close (code = 1000, reason = '') {
        if (ws.readyState === 1) {
          const r = Buffer.from(reason, 'utf8'); const p = Buffer.alloc(2 + r.length)
          p.writeUInt16BE(code, 0); r.copy(p, 2)
          socket.write(encodeFrame(8, p))
        }
        ws.readyState = 3
        socket.end()
      }
    }
    let buf = Buffer.alloc(0)
    socket.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d
      for (;;) {
        const f = parseFrame(buf)
        if (f === 'closed' || f === null) { if (f === 'closed') { ws.readyState = 3; socket.end(); ws.onclose?.() } break }
        buf = buf.subarray(f.total)
        if (f.opcode === 8) { ws.readyState = 3; socket.end(); ws.onclose?.(); break }
        if (f.opcode === 9) { socket.write(encodeFrame(10, f.payload)); continue } // ping → pong
        if (f.opcode === 10) { ws.onpong?.(); continue }
        if (f.opcode === 0 && ws._frag) { // continuation
          ws._frag.chunks.push(f.payload)
          if (f.fin) { const whole = Buffer.concat(ws._frag.chunks); ws._frag = null; ws.ontext?.(whole.toString('utf8')) }
          continue
        }
        if (f.opcode !== 1) continue // 不支持 binary，静默丢弃
        if (!f.fin) { ws._frag = { chunks: [f.payload] }; continue }
        ws.ontext?.(f.payload.toString('utf8'))
      }
    })
    socket.on('error', () => { ws.readyState = 3; ws.onclose?.() })
    socket.on('close', () => { if (ws.readyState !== 3) { ws.readyState = 3; ws.onclose?.() } })
    return ws
  }
}
