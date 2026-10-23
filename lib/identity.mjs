// 设备身份：Ed25519 密钥对（存 <DSH_HOME>/happy-harness/device-key.pem）+ 云端注册
// 与 companion 的 DPAPI 方案同信任域（.credentials.yaml 本就明文存于 DSH_HOME）
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { sign as edSign } from 'node:crypto'

export class Identity {
  constructor (dir, serverUrl) {
    this.dir = dir
    this.serverUrl = serverUrl.replace(/\/$/, '')
    this.privateKey = null
    this.publicKeyB64 = null
    this.deviceId = null
    this.deviceToken = null
  }

  async loadOrCreate () {
    mkdirSync(this.dir, { recursive: true })
    const keyPath = join(this.dir, 'device-key.pem')
    const idPath = join(this.dir, 'identity.json')
    if (existsSync(keyPath)) {
      this.privateKey = readFileSync(keyPath, 'utf8')
    } else {
      const { privateKey } = generateKeyPairSync('ed25519')
      this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' })
      writeFileSync(keyPath, this.privateKey, { mode: 0o600 })
    }
    this.publicKeyB64 = createPublicKey(this.privateKey).export({ type: 'spki', format: 'der' }).toString('base64url')
    if (existsSync(idPath)) {
      try {
        const id = JSON.parse(readFileSync(idPath, 'utf8'))
        this.deviceId = id.deviceId
        this.deviceToken = id.deviceToken
      } catch { /* 损坏则重新注册 */ }
    }
    return this.registered
  }

  get registered () { return !!(this.deviceId && this.deviceToken) }

  async api (method, path, body, auth = true, allowReRegister = true) {
    const res = await fetch(this.serverUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(auth ? { Authorization: `Bearer ${this.deviceToken}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 401 && auth && allowReRegister) {
      this.deviceId = null
      this.deviceToken = null
      await this.register()
      return this.api(method, path, body, auth, false)
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || res.statusText}`)
    return data
  }

  async register (name = 'dsh-plugin') {
    const data = await this.api('POST', '/api/v1/register', { name, publicKey: this.publicKeyB64 }, false)
    this.deviceId = data.deviceId
    this.deviceToken = data.deviceToken
    writeFileSync(join(this.dir, 'identity.json'), JSON.stringify({ deviceId: this.deviceId, deviceToken: this.deviceToken }, null, 2), { mode: 0o600 })
    return data
  }

  async ensureRegistered () {
    if (!this.registered) await this.register()
    return this.deviceId
  }

  async requestPairCode () {
    return this.api('POST', '/api/v1/pair-code', {})
  }

  async listPairs () {
    const d = await this.api('GET', '/api/v1/pairs')
    return d.items || []
  }

  async removePair (pairId) {
    await this.api('DELETE', `/api/v1/pairs/${pairId}`)
  }

  sign (dataBuf) {
    return edSign(null, dataBuf, this.privateKey)
  }
}
