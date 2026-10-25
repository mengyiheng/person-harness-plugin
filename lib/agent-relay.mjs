#!/usr/bin/env node
// agent-relay：agent 无关的独立配对/隧道运行器（B+C 模型的通用链路，2026-10-26）
//   目标：机器上没有 dsh、只有 opencode/portal/任意 Web agent 时，本运行器提供与
//   dsh 插件完全同构的链路（配对、隧道、E2E、P2P 打洞、浏览器远程登录授权），
//   手机配对后直达该 agent 的远程 webview。
//
// 用法：
//   node agent-relay.mjs --origin http://127.0.0.1:4096 --name opencode [--label OpenCode]
//        [--server http://8.137.177.62:9400] [--home ~/.ph/agent-relay] [--port 9430]
//
// 子命令（交互式输入，或 --pair 直接进入配对）：
//   pair    签发配对二维码（PNG 存盘 + 深链打印），手机「扫码添加新设备」即配对到本 agent
//   status  隧道/身份/已配对设备
//
// 复用件（与 dsh 插件同源、共享升级）：identity / tunnel / adapter / e2e / punch / ws-lite
import { Identity } from './identity.mjs'
import { TunnelClient } from './tunnel.mjs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['origin', 'name', 'label', 'server', 'home', 'port'])
const arg = (k, dflt) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const hasFlag = (k) => argv.includes('--' + k)
const cmd = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1].replace(/^--/, '')))) ?? ''

const origin = arg('origin', 'http://127.0.0.1:4096')
const name = arg('name', 'opencode')
const label = arg('label', name)
const server = arg('server', 'http://8.137.177.62:9400')
const home = resolve(arg('home', join(homedir(), '.ph', 'agent-relay', name)))
const log = (...a) => console.log(`[${label}]`, ...a)

// ---- 依赖注入（与 dsh 插件唯一差异：无 GUI Cookie，origin 鉴权交给 agent 自己）----
const deps = {
  getOrigin: () => origin,
  mintCookie: async () => '', // auth: none 语义——agent 的 webview 自身无登录态
  onInternalRequest: null, // 下面赋值（授权端点）
  log
}

const identity = new Identity(join(home, 'identity'), server)
await identity.loadOrCreate()
if (!identity.registered) {
  await identity.register(name)
  log('已注册设备身份:', identity.deviceId)
}
await identity.ensureRegistered()

// ---- 内部端点：远程登录授权（手机批准 → 云端开桥；agent 无 dsh 鉴权，桥直接代理 origin）----
let lastWebLogin = null
deps.onInternalRequest = async (path, method, body) => {
  if (path === '/__ph/remote-login/approve' && method === 'POST') {
    let b = {}
    try { b = JSON.parse(body.toString('utf8') || '{}') } catch { /* 容错 */ }
    if (!b.id) return { status: 400, body: { error: 'id required' } }
    lastWebLogin = { id: b.id, mode: b.mode, at: Date.now() }
    const ack = await tunnel.sendWebLoginApprove(b.id, b.mode)
    log(`浏览器远程登录授权（id=${b.id} mode=${b.mode || 'legacy'}）→ ${ack.ok ? '已批准' : '拒绝: ' + (ack.error ?? '')}`)
    return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
  }
  if (path === '/__ph/remote-link/approve' && method === 'POST') {
    let b = {}
    try { b = JSON.parse(body.toString('utf8') || '{}') } catch { /* 容错 */ }
    if (!b.id || !b.from) return { status: 400, body: { error: 'id/from required' } }
    const ack = await tunnel.sendLinkApprove(b.id, b.from, b.mode)
    log(`远程登录授权（id=${b.id} from=${b.from}）→ ${ack.ok ? '已批准' : '拒绝: ' + (ack.error ?? '')}`)
    return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
  }
  if (path === '/__ph/status' && method === 'POST') {
    return { status: 200, body: { agent: name, origin, connected: tunnel.connected, deviceId: identity.deviceId } }
  }
  return { status: 404, body: { error: 'unknown internal path' } }
}

const tunnel = new TunnelClient({
  relayUrl: server.replace(/^http/, 'ws') + '/api/v1/tunnel',
  identity,
  deps
})

// ---- 子命令 ----
async function pair () {
  const pc = await identity.requestPairCode()
  const serverHost = server.replace(/^https?:\/\//, '')
  const deepLink = `myapp://pair?ver=2&server=${encodeURIComponent(serverHost)}&device=${encodeURIComponent(identity.deviceId)}&code=${encodeURIComponent(pc.code)}`
  const QRCode = (await import('qrcode')).default
  const png = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
  mkdirSync(home, { recursive: true })
  const pngPath = join(home, `pair-${Date.now()}.png`)
  writeFileSync(pngPath, png)
  console.log(`
────────────────────────────────────────────
📱 手机 App「扫码添加新设备」扫描上面的码
   二维码 PNG：${pngPath}
   手动兜底配对码：${pc.code}（${pc.expiresInSec ?? 300}s 内有效，一次性）
   深链：${deepLink}
────────────────────────────────────────────`)
}

function status () {
  console.log(JSON.stringify({
    agent: name, label, origin, server,
    deviceId: identity.deviceId,
    tunnel: tunnel.connected ? 'connected' : 'down',
    home
  }, null, 2))
}

if (cmd === 'pair') { await pair() } else if (cmd === 'status') { status() } else {
  if (hasFlag('pair')) await pair()
  tunnel.start()
  log(`agent-relay 已启动：origin=${origin} server=${server}`)
  log('配对：node agent-relay.mjs pair --origin … --name …；状态：status')
  setInterval(() => {}, 1 << 30) // keep alive
}
