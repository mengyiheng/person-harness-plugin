#!/usr/bin/env node
// ph — person-harness 统一 CLI（B 模型产品化，2026-10-26）
//   ph            清单为空 → 启动首次配置向导（自动探测）；否则启动全部 agent 链（supervisor）
//   ph run        supervisor 模式（watchdog 调用）：按清单拉起全部链 + 写 pid 锁
//   ph add        向导（同默认）
//   ph pair       为清单内未配对的 agent 签发配对码
//   ph status     全链状态
//   ph remove <名> 从清单移除
// 清单：~/.ph/agents.json  [{ name, origin, port, start? }]
import http from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { Identity } from './identity.mjs'
import { TunnelClient } from './tunnel.mjs'
import { createDeviceRoutes } from './device-routes.mjs'

const PH_DIR = join(homedir(), '.ph')
const MANIFEST = join(PH_DIR, 'agents.json')
const SERVER = 'http://8.137.177.62:9400'
const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('--')) ?? ''
const log = (...a) => console.log('[ph]', ...a)

function loadManifest () {
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return [] }
}
function saveManifest (list) {
  mkdirSync(PH_DIR, { recursive: true })
  writeFileSync(MANIFEST, JSON.stringify(list, null, 2))
}

// ---- 单链 ----
const chains = [] // { name, identity, tunnel, pairPng }
function startChain (a) {
  const home = join(PH_DIR, 'agent-relay', a.name)
  const identity = new Identity(join(home, 'identity'), SERVER)
  const deviceRoutes = createDeviceRoutes({ identity, getTunnel: () => tunnel, server: SERVER, agent: a.name, deviceName: a.name })
  const deps = {
    getOrigin: () => a.origin,
    mintCookie: async () => '',
    log: (...x) => console.log(`[${a.name}]`, ...x)
  }
  deps.onInternalRequest = async (path, method, body) => {
    if (path === '/__ph/remote-login/approve' && method === 'POST') {
      let b = {}; try { b = JSON.parse(body.toString('utf8') || '{}') } catch {}
      if (!b.id) return { status: 400, body: { error: 'id required' } }
      const ack = await tunnel.sendWebLoginApprove(b.id, b.mode)
      return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
    }
    if (path === '/__ph/remote-link/approve' && method === 'POST') {
      let b = {}; try { b = JSON.parse(body.toString('utf8') || '{}') } catch {}
      if (!b.id || !b.from) return { status: 400, body: { error: 'id/from required' } }
      const ack = await tunnel.sendLinkApprove(b.id, b.from, b.mode)
      return { status: ack.ok ? 200 : 502, body: { ok: !!ack.ok, error: ack.error } }
    }
    if (path === '/__ph/targets') return { status: 200, body: { targets: [{ name: a.name, label: a.name }] } }
    const deviceResponse = await deviceRoutes(path, method, body)
    if (deviceResponse) return deviceResponse
    return { status: 404, body: { error: 'unknown internal path' } }
  }
  const tunnel = new TunnelClient({ relayUrl: SERVER.replace(/^http/, 'ws') + '/api/v1/tunnel', identity, deps })
  const chain = { name: a.name, a, identity, tunnel, home }
  chains.push(chain)
  return chain
}
async function ensureIdentity (chain) {
  await chain.identity.loadOrCreate()
  if (!chain.identity.registered) { await chain.identity.register(chain.a.name); log(`已注册 ${chain.a.name}: ${chain.identity.deviceId}`) }
  await chain.identity.ensureRegistered()
}
async function issuePair (chain) {
  await ensureIdentity(chain)
  const pc = await chain.identity.requestPairCode()
  const serverHost = SERVER.replace(/^https?:\/\//, '')
  const deepLink = `myapp://pair?ver=2&server=${encodeURIComponent(serverHost)}&device=${encodeURIComponent(chain.identity.deviceId)}&code=${encodeURIComponent(pc.code)}`
  const QRCode = (await import('qrcode')).default
  const png = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
  mkdirSync(chain.home, { recursive: true })
  const pngPath = join(chain.home, `pair-${Date.now()}.png`)
  writeFileSync(pngPath, png)
  // 清理旧二维码（只留 3 张）
  return { code: pc.code, pngPath, deepLink, expires: pc.expiresInSec ?? 300 }
}

// ---- 探测 ----
const DETECTORS = [
  { port: 3000, name: 'OpenCode', hint: '工作区 Portal' },
  { port: 3400, name: 'Codex', hint: 'yepanywhere' },
  { port: 4096, name: 'OpenCode', hint: '官方 UI' },
  { port: 7703, name: 'ZCode', hint: '' },
  { port: 7705, name: 'Pi', hint: '' },
  { port: 7701, name: 'Codex', hint: '终端' },
  { port: 7702, name: 'Gemini', hint: '终端' },
]
async function probe (port) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 600)
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: c.signal })
    clearTimeout(t); void r; return true
  } catch (e) { return e?.name !== 'AbortError' ? false : true }
}
async function detect () {
  const found = []
  for (const d of DETECTORS) if (await probe(d.port)) found.push({ port: d.port, name: d.name, hint: d.hint, origin: `http://127.0.0.1:${d.port}` })
  return found
}

// ---- 向导 ----
function wizardPage (found) {
  const rows = found.map((f, i) => `
    <label class="row"><input type="checkbox" checked data-i="${i}"><b>${f.name}</b> <span class="hint">${f.hint} · :${f.port}</span></label>`).join('') || '<p>未探测到本机有 agent Web 服务，请手动填写：</p>'
  return `<!doctype html><meta charset="utf-8"><title>智枢 · 配置你的 Agent</title>
<style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;background:#f7f8fa;color:#1a1a1a}
.row{display:flex;gap:10px;align-items:center;padding:12px;background:#fff;border:1px solid #e3e7ec;border-radius:10px;margin:6px 0;cursor:pointer}
.hint{color:#697586;font-size:12px}button{background:#20433a;color:#3ddc97;border:0;border-radius:10px;padding:12px 24px;font-size:15px;cursor:pointer;width:100%;margin-top:14px}
input[name=origin],input[name=name]{width:100%;padding:9px;border:1px solid #ccc;border-radius:8px;margin:4px 0}
fieldset{border:1px solid #e3e7ec;border-radius:10px;margin-top:10px}</style>
<h2>智枢 · 配置你的 Agent</h2><p>探测到本机这些 Agent，勾选要启用并配对的：</p><form id="f">${rows}
<fieldset><legend>手动添加（可选）</legend><input name="name" placeholder="Agent 名，如 Codex"><input name="origin" placeholder="http://127.0.0.1:端口"></fieldset>
<button type="submit">保存并生成配对二维码 →</button></form>
<script>document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault()
  const agents = [...document.querySelectorAll('input[type=checkbox]:checked')].map(c => { const f = found[+c.dataset.i]; return { name: f.name + (f.hint ? ' ' + f.hint : ''), origin: f.origin, port: f.port } })
  const mn = document.querySelector('input[name=name]').value, mo = document.querySelector('input[name=origin]').value
  if (mn && mo) agents.push({ name: mn, origin: mo, port: +mo.match(/:(\\d+)/)?.[1] || 0 })
  const r = await fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(agents) })
  const j = await r.json()
  document.body.innerHTML = '<h2>✅ 已保存 ' + j.saved + ' 个 Agent</h2><p>链路已启动。配对二维码：</p>' +
    j.pairs.map(p => '<div style="margin:14px 0"><b>' + p.name + '</b><br>配对码 <code style="font-size:20px">' + p.code + '</code>（' + p.expires + 's 内有效）<br><img src="' + p.png.replace(/\\\\/g, '/') + '"></div>').join('') +
    '<p>手机 App「扫码添加 Agent」扫描即可。此后开机自动回线，无需再配置。</p>'
}
const found = ${JSON.stringify(found)}</script>`
}

async function runWizard () {
  const found = await detect()
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/save' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const agents = JSON.parse(body || '[]')
      saveManifest(agents)
      const pairs = []
      for (const a of agents) {
        const chain = startChain(a)
        await ensureIdentity(chain)
        const p = await issuePair(chain)
        chain.tunnel.start()
        pairs.push({ name: a.name, code: p.code, png: p.pngPath, expires: p.expires })
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ saved: agents.length, pairs }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(wizardPage(found))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  log('首次配置向导已打开：', url)
  try { const { openInBrowser } = process.platform === 'win32' ? { openInBrowser: (u) => import('node:child_process').then(({ exec }) => exec(`start "" "${u}"`)) } : {}; openInBrowser(url) } catch {}
  return srv
}

// ---- supervisor ----
function acquireRunnerLock () {
  // 单实例锁：已有活着的 runner 则让位（harness/作业系统重启旧作业时避免多 supervisor 互踢）
  const lockPath = join(PH_DIR, 'runner.lock')
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (lock.pid && process.kill(lock.pid, 0)) return false
  } catch { /* 无锁或持有者已死 */ }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
  return true
}
async function runSupervisor () {
  if (!acquireRunnerLock()) { log('已有 runner 在跑（pid 见 runner.lock），本实例退出'); return }
  const manifest = loadManifest()
  if (!manifest.length) {
    log('清单为空，进入首次配置向导…（保存后本进程自动开始全部链路）')
    await runWizard()
    return
  }
  for (const a of manifest) {
    const chain = startChain(a)
    await ensureIdentity(chain)
    chain.tunnel.start()
    log(`链路已启动: ${a.name} → ${a.origin}`)
  }
  log(`supervisor 运行中：${chains.length} 条链（pid ${process.pid}）`)
  setInterval(() => {}, 1 << 30)
}

if (cmd === 'run') { await runSupervisor() }
else if (cmd === 'status') {
  for (const a of loadManifest()) {
    const home = join(PH_DIR, 'agent-relay', a.name)
    let id = '未配对'
    try { const idj = JSON.parse(readFileSync(join(home, 'identity', 'identity.json'), 'utf8')); id = idj.deviceId } catch {}
    console.log(`${a.name.padEnd(16)} ${a.origin}  deviceId=${id}`)
  }
} else if (cmd === 'remove') {
  const n = argv[argv.indexOf('remove') + 1]
  saveManifest(loadManifest().filter((a) => a.name !== n))
  log(`已从清单移除 ${n}（配对关系可在云端/手机侧解除）`)
} else {
  // 默认：清单空 → 向导；有清单 → supervisor
  await runSupervisor()
}
