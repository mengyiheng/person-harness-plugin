// 通用独立 Agent：每个实例独立持有身份、隧道、轻壳、工作区、会话和审批台账，不加载 dsh。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import QRCode from 'qrcode'
import { Identity } from '../identity.mjs'
import { TunnelClient } from '../tunnel.mjs'
import { createDeviceRoutes } from '../device-routes.mjs'
import { createDriverFromConfig } from './driver-factory.mjs'
import { startLightBridge } from './light-bridge.mjs'

const DEFAULT_SERVER = 'http://8.137.177.62:9400'

export async function startIndependentAgent (options = {}) {
  const label = options.label || 'Independent Agent'
  const name = options.name || 'independent-agent'
  const cwd = path.resolve(options.cwd || process.cwd())
  const home = path.resolve(options.home || path.join(os.homedir(), '.ph', name))
  const serverUrl = options.server || DEFAULT_SERVER
  const log = options.log || ((...value) => console.log(`[${name}]`, ...value))
  const localOnly = options.localOnly === true
  const origin = `http://127.0.0.1:${Number(options.port || 7711)}`
  let tunnel = null

  const identityFactory = options.identityFactory || ((dir, url) => new Identity(dir, url))
  const identity = localOnly ? null : identityFactory(path.join(home, 'identity'), serverUrl)
  if (identity) {
    await identity.loadOrCreate()
    if (!identity.registered) await identity.register(name)
    await identity.ensureRegistered()
    log(`设备身份就绪: ${identity.deviceId}`)
  }

  const driver = options.driver || createDriverFromConfig(options.driverConfig || { type: 'acp' }, { cwd, log })
  if (!driver || typeof driver.prompt !== 'function' || typeof driver.attach !== 'function') throw new Error('独立 Agent 驱动必须实现 attach/prompt')
  const bridge = startLightBridge({
    label,
    port: Number(options.port || 7711),
    cwd,
    regDir: options.regDir || path.join(home, 'sessions'),
    driver,
    workspaces: options.workspaces,
    log
  })

  const deviceRoutes = identity ? createDeviceRoutes({
    identity,
    getTunnel: () => tunnel,
    server: serverUrl,
    agent: name,
    deviceName: options.deviceName || `${label} · ${os.hostname()}`
  }) : null
  const deps = {
    getOrigin: () => origin,
    mintCookie: async () => '',
    log,
    onInternalRequest: async (requestPath, method, body) => {
      if (requestPath === '/__ph/transport-ping' && method === 'GET') return { status: 200, body: { ok: true, now: Date.now() } }
      if (requestPath === '/__ph/targets' && method === 'GET') return { status: 200, body: { targets: [{ name, label }] } }
      if (requestPath === '/__ph/remote-login/approve' && method === 'POST') {
        const value = JSON.parse(body.toString('utf8') || '{}')
        if (!value.id) return { status: 400, body: { error: 'id required' } }
        const ack = await tunnel.sendWebLoginApprove(value.id, value.mode, name)
        return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
      }
      if (requestPath === '/__ph/remote-link/approve' && method === 'POST') {
        const value = JSON.parse(body.toString('utf8') || '{}')
        if (!value.id || !value.from) return { status: 400, body: { error: 'id/from required' } }
        const ack = await tunnel.sendLinkApprove(value.id, value.from, value.mode, name)
        return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
      }
      const response = await deviceRoutes?.(requestPath, method, body)
      return response || { status: 404, body: { error: 'unknown internal path' } }
    }
  }
  if (identity) {
    const tunnelFactory = options.tunnelFactory || ((opts) => new TunnelClient(opts))
    tunnel = tunnelFactory({
      relayUrl: serverUrl.replace(/^http/, 'ws') + '/api/v1/tunnel',
      identity,
      deps
    })
    tunnel.start()
    log(`手机隧道已启动: ${serverUrl}`)
  }

  async function pair () {
    if (!identity) throw new Error('本地模式不支持手机配对')
    const pc = await identity.requestPairCode()
    const serverHost = serverUrl.replace(/^https?:\/\//, '')
    const deepLink = `myapp://pair?ver=2&server=${encodeURIComponent(serverHost)}&device=${encodeURIComponent(identity.deviceId)}&code=${encodeURIComponent(pc.code)}`
    const png = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
    fs.mkdirSync(home, { recursive: true })
    const pngPath = path.join(home, `pair-${Date.now()}.png`)
    fs.writeFileSync(pngPath, png)
    log(`配对二维码: ${pngPath}`)
    log(`配对码: ${pc.code}（${pc.expiresInSec ?? 300} 秒内有效，一次性）`)
    log(`深链: ${deepLink}`)
    return { code: pc.code, pngPath, deepLink, expiresInSec: pc.expiresInSec ?? 300 }
  }

  return {
    name, label, origin, home, bridge, identity, tunnel, pair,
    close () {
      tunnel?.stop()
      bridge.close()
    }
  }
}
