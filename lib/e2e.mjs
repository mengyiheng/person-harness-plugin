// E2E 加密 —— 《中继链路协议 v2.0》§5
//   身份：ed25519 长期密钥（注册时的密钥对，公钥双方配对时已交换）
//   会话：每次 attach 临时 X25519，offer/accept/confirm 三步握手（双方互验签名）
//   加密：AES-256-GCM，nonce = 4B 方向计数器 + 8B 随机盐，AAD = attachId|streamId|type
// 中继只见 attachId/帧类型/密文长度——合规自证清单第 4 条。
import { generateKeyPairSync, createPublicKey, createPrivateKey, sign, verify, diffieHellman, hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const unb64u = (s) => Buffer.from(s, 'base64url')

export function genEphemeral () {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return { privateKey, publicKeyB64: b64u(publicKey.export({ type: 'spki', format: 'der' })) }
}

// 签名消息：len-prefix(attachId ‖ 己方eph ‖ 对方eph)，防拼接歧义
function transcript (attachId, selfEphB64, peerEphB64) {
  return Buffer.concat([attachId, selfEphB64, peerEphB64].map((s) => {
    const b = unb64u(s); const l = Buffer.alloc(4); l.writeUInt32BE(b.length)
    return Buffer.concat([l, b])
  }))
}

export function signE2E (edPrivatePem, attachId, selfEphB64, peerEphB64) {
  return b64u(sign(null, transcript(attachId, selfEphB64, peerEphB64), createPrivateKey(edPrivatePem)))
}

export function verifyE2E (edPublicKeyB64, signatureB64, attachId, selfEphB64, peerEphB64) {
  const pub = createPublicKey({ key: unb64u(edPublicKeyB64), type: 'spki', format: 'der' })
  // 注意 Node 的 verify 参数序是 (algorithm, data, key, signature)，别写反
  return verify(null, transcript(attachId, selfEphB64, peerEphB64), pub, unb64u(signatureB64))
}

function sharedSecret (ephPrivate, peerEphPublicB64) {
  const peerPub = createPublicKey({ key: unb64u(peerEphPublicB64), type: 'spki', format: 'der' })
  return diffieHellman({ privateKey: ephPrivate, publicKey: peerPub })
}

// role: 'pc' | 'phone'。本侧发送用 sendKey，接收用 recvKey。
export function deriveKeys (ephPrivate, peerEphPublicB64, attachId, role) {
  const ikm = sharedSecret(ephPrivate, peerEphPublicB64)
  const mk = (info) => Buffer.from(hkdfSync('sha256', ikm, unb64u(attachId) /* salt=attachId */, info, 32))
  const pcToPhone = mk('hh-v2 pc->phone')
  const phoneToPc = mk('hh-v2 phone->pc')
  return role === 'pc'
    ? { sendKey: pcToPhone, recvKey: phoneToPc }
    : { sendKey: phoneToPc, recvKey: pcToPhone }
}

// 会话加密盒：nonce 计数器每方向递增，盐随机（同一计数器+盐永不复用）
export class E2EBox {
  constructor (keys, attachId) {
    this.sendKey = keys.sendKey
    this.recvKey = keys.recvKey
    this.attachId = attachId
    this.sendCount = 0
    this.recvCount = 0
  }

  _nonce (count, salt) {
    const n = Buffer.alloc(12)
    n.writeUInt32LE(count, 0)
    salt.copy(n, 4)
    return n
  }

  _aad (streamId, type) {
    return Buffer.from(`${this.attachId}|${streamId}|${type}`)
  }

  // 加密一帧，返回 {nonce, ct}（nonce 即 12B 计数器+盐，ct 含 GCM auth tag）
  seal (streamId, type, plaintext) {
    this.sendCount += 1
    const salt = randomBytes(8)
    const nonce = this._nonce(this.sendCount, salt)
    const c = createCipheriv('aes-256-gcm', this.sendKey, nonce)
    c.setAAD(this._aad(streamId, type))
    const ct = Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final(), c.getAuthTag()])
    return { nonce: b64u(nonce), ct: b64u(ct) }
  }

  open (streamId, type, { nonce, ct }) {
    this.recvCount += 1
    const rawCt = unb64u(ct)
    const d = createDecipheriv('aes-256-gcm', this.recvKey, unb64u(nonce))
    d.setAAD(this._aad(streamId, type))
    d.setAuthTag(rawCt.subarray(rawCt.length - 16))
    return Buffer.concat([d.update(rawCt.subarray(0, rawCt.length - 16)), d.final()]).toString('utf8')
  }
}
