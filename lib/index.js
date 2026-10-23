// Happy Harness relay plugin — v0.2（companion 核心进程内移植版）
// 职责：设备身份 + 云端注册 + 出站隧道（手机 attach/E2E/协议适配全部进程内完成）
// 配置（profile cordis.patch.yml 里本插件行的 config）：
//   server: 云端协调服务器（默认 http://8.137.177.62:9400）
import { join } from 'node:path'
import { homedir } from 'node:os'
import { exec } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import QRCode from 'qrcode'
// ⛔ 不依赖 @deepseek-ai/dsh-llm：npm 版消息 schema 与宿主运行时错位曾致会话投影崩溃
//    （2026-10-23 🔴 事故，repair-sessions.mjs 修复）。插件不需要它。
import { Identity } from './identity.mjs'
import { TunnelClient } from './tunnel.mjs'

export const name = 'happy-harness-relay'

const HOUR = 3600 * 1000

export function apply (ctx, cfg = {}) {
  const config = cfg || {}
  const server = config.server || 'http://8.137.177.62:9400'
  const relayUrl = config.relayUrl || server.replace(/^http/, 'ws') + '/api/v1/tunnel'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 按 profile 分身份（2026-10-23）：桌面版(desktop)与命令行版(web)同时运行时互不顶替——
  // 云端是"一个设备号=一条隧道"，共享身份会 last-wins 互相踢。配对码因此天然绑定到签发它的实例：
  // 桌面端生成的码配桌面端，命令行端生成的码配命令行端（用户直觉语义）。
  // 会话数据两边本就同库（同一 DSH_HOME），续聊无缝。
  let profileName = 'default'
  try {
    const pc = ctx.get('profileContext')
    if (pc && pc.dir) profileName = String(pc.dir).split(/[\\/]/).filter(Boolean).pop() || 'default'
  } catch (e) { /* 非 profile 环境兜底 */ }
  const dir = join(dshHome, 'happy-harness', profileName)

  const log = (...args) => console.log('[happy]', ...args)
  log(`插件启动：server=${server} dshHome=${dshHome}`)

  let connSvc = null       // dsh connection 服务（publishPeer / browserAuth）
  let originCache = null   // webServer.getOrigin() 缓存

  const getOrigin = () => {
    if (originCache) return originCache
    const origin = ctx.get('webServer')?.getOrigin?.()
    if (!origin) throw new Error('webServer 尚未就绪（无 origin）')
    originCache = origin
    return origin
  }

  // 进程内铸 owner Cookie：browserAuth.secret 自签 v1（HMAC 方案与 dsh 同源）。
  // 🔴 2026-10-23 401 根因：dsh 的 authorizeIndex/isAuthenticated 只认 v1 owner Cookie；
  //    之前用 publishPeer 铸的 v2 peer Cookie 仅授权 /api/remote.mux（authenticateApi），
  //    手机 WebView GET / 必然 401（"dsh web authentication required"）。companion 凭证网关
  //    同样是自签 v1，因此全天正常。v1 无状态：WS 断开不吊销，无 peer 生命周期问题。
  const mintCookie = async () => {
    if (!connSvc) throw new Error('connection 服务未就绪')
    const b = connSvc.browserAuth
    const origin = getOrigin()
    const authority = origin.replace(/^https?:\/\//, '')
    const issuedAt = Date.now()
    const expiresAt = issuedAt + (b.maxAgeMilliseconds || 24 * HOUR)
    const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt })).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
    const sig = createHmac('sha256', b.secret).update(body).digest()
    const name = 'dsh-auth-' + createHash('sha256').update(authority).digest().toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
    return `${name}=v1.${body}.${sig.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')}`
  }

  // 服务注入：webServer（拿 origin）/ connection（铸 Cookie + 二维码路由）
  ctx.inject(['webServer'], () => { originCache = null })
  ctx.inject(['connection'], (c) => {
    connSvc = c.connection ?? c.get?.('connection') ?? null
    log('connection 服务已注入，凭证铸造就绪')
    // 二维码页面路由：/api/happy-qr（同源带 Cookie）。
    // 🔴 聊天渲染器不支持 data:/markdown 图片、append 写消息又踩 dsh-llm schema 红线，
    //    所以走"本机浏览器弹页"：用户浏览器已持 GUI 登录 Cookie，能过此路由的鉴权。
    try {
      connSvc.fetch.register({
        path: '/api/happy-qr',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(new Response(qrHtml ?? '<h3>暂无二维码：先执行 /happy pair</h3>', {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        }))
      })
      log('二维码路由已注册 /api/happy-qr')
    } catch (e) {
      log('二维码路由注册失败: ' + e.message)
    }
  })

  // ---- /happy 命令：对话内配对（码来自当前实例 → 桌面版/命令行版天然区分）----
  let qrPng = null
  let qrHtml = null
  let qrExpiresAt = 0
  const serverHost = server.replace(/^https?:\/\//, '')

  /** 用系统默认浏览器打开（dsh web 启动时已把默认浏览器登录过，Cookie 在）。
   *  🔴 Windows 必须用 exec 单字符串：spawn('cmd', ['/c', 'start "" "url"']) 会被
   *    cmd 引号重拼规则截断 URL → 弹"Windows 找不到 //xxx 文件"告警。 */
  const openInBrowser = (url) => {
    const safeUrl = url.replaceAll('"', '').replaceAll('&', '')
    const command = process.platform === 'win32' ? `start "" "${safeUrl}"`
      : process.platform === 'darwin' ? `open "${safeUrl}"` : `xdg-open "${safeUrl}"`
    try {
      const child = exec(command, { timeout: 5000 }, () => {})
      child.on('error', () => log('打开浏览器失败（' + command + '）'))
      return true
    } catch (e) {
      log('打开浏览器失败: ' + e.message)
      return false
    }
  }
  const HAPPY_USAGE = [
    '**Happy Harness 手机配对**',
    '',
    '- `/happy pair` —— 生成一次性配对二维码（5 分钟有效，绑定当前实例）',
    '- `/happy devices` —— 列出已配对设备',
    '- `/happy revoke <pairId>` —— 解除配对',
    '- `/happy status` —— 隧道与身份状态'
  ].join('\n')

  ctx.inject(['commands'], (c) => {
    const commands = c.commands
    if (!commands) { log('commands 服务不可用，/happy 未注册'); return }
    commands.register({
      definitionId: 'happy-harness-relay',
      name: 'happy',
      description: 'Happy Harness 手机配对与管理（pair / devices / revoke / status）',
      input: { hint: 'pair | devices | revoke <id> | status' },
      handler: async (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim()
        const action = raw.split(/\s+/)[0] || 'pair'
        try {
          if (action === 'devices' || action === 'list') {
            const items = await identity.listPairs()
            if (items.length === 0) return { kind: 'success', text: '暂无已配对设备。`/happy pair` 生成配对码。' }
            const lines = items.map((p) => `- \`${p.pairId}\`  手机 ${p.phone?.name ?? p.phone?.deviceId ?? '?'}（配对于 ${new Date(p.createdAt).toLocaleString()}）`)
            return { kind: 'success', text: ['**已配对设备**（`/happy revoke <pairId>` 解除）', '', ...lines].join('\n') }
          }
          if (action === 'revoke' || action === 'remove') {
            const id = raw.split(/\s+/)[1] ?? ''
            if (!id) return { kind: 'error', text: '用法：/happy revoke <pairId>（先用 /happy devices 查列表）' }
            await identity.removePair(id)
            return { kind: 'success', text: `已解除配对 \`${id}\`，该手机立即失去访问权。` }
          }
          if (action === 'status') {
            return {
              kind: 'success',
              text: [
                '**Happy Harness 状态**',
                `- 实例（profile）：\`${profileName}\``,
                `- 设备号：\`${identity.deviceId ?? '未注册'}\``,
                `- 服务器：${server}`,
                `- 隧道：${tunnel && tunnel.connected ? '已连接' : '未连接/重连中'}`,
                `- 已配对设备：/happy devices 查看`
              ].join('\n')
            }
          }
          if (action !== 'pair' && action !== '') {
            return { kind: 'error', text: '未知子命令。\n\n' + HAPPY_USAGE }
          }
          // pair：签发一次性码 → 深链 → 二维码页 → 本机浏览器弹出
          const pc = await identity.requestPairCode()
          const deepLink = `myapp://pair?ver=2&server=${encodeURIComponent(serverHost)}&device=${encodeURIComponent(identity.deviceId)}&code=${encodeURIComponent(pc.code)}`
          qrPng = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
          qrExpiresAt = Date.now() + (pc.expiresInSec ?? 300) * 1000
          qrHtml = `<!doctype html><meta charset="utf-8"><title>Happy Harness 配对</title>` +
            `<style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;` +
            `background:#f5f6f8;color:#222;padding:32px}img{border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.12);` +
            `background:#fff;padding:12px}.code{font-size:28px;letter-spacing:4px;font-weight:700;margin-top:16px;` +
            `font-family:monospace}.tip{color:#666;margin-top:8px;font-size:14px}</style>` +
            `<img src="data:image/png;base64,${qrPng.toString('base64')}" width="320" height="320">` +
            `<div class="code">${pc.code}</div>` +
            `<div class="tip">手机 App「扫码添加新设备」扫描此码｜或手动输入上方配对码｜${pc.expiresInSec ?? 300}s 内有效、一次性</div>`
          // 默认浏览器弹二维码页（浏览器已持 GUI Cookie，能过 /api/happy-qr 鉴权）
          let opened = false
          try {
            const url = getOrigin() + '/api/happy-qr'
            opened = openInBrowser(url)
            if (!opened) log('浏览器拉起失败，请手动打开: ' + url)
          } catch (e) {
            log('二维码页打开异常: ' + e.message)
          }
          return {
            kind: 'success',
            text: [
              `**手机扫码配对** —— 二维码已在电脑浏览器弹出，手机扫码即可${opened ? '' : '（浏览器未弹出时手动打开 ' + getOrigin() + '/api/happy-qr ）'}`,
              `手动兜底：配对码 \`${pc.code}\`（${pc.expiresInSec ?? 300}s 内有效，一次性）`,
              `绑定当前实例（${profileName}）｜服务器：${server}`
            ].join('\n')
          }
        } catch (e) {
          return { kind: 'error', text: 'happy 命令失败: ' + (e?.message ?? String(e)) }
        }
      }
    })
    log('/happy 命令已注册')
  })

  // 身份 + 隧道
  const identity = new Identity(dir, server)
  let tunnel = null
  const boot = async () => {
    await identity.loadOrCreate()
    await identity.ensureRegistered()
    log(`设备身份就绪: ${identity.deviceId}`)
    tunnel = new TunnelClient({
      relayUrl,
      identity,
      deps: { getOrigin, mintCookie, log }
    })
    tunnel.start()
  }
  boot().catch((e) => log('启动失败（将随下次重载重试）:', e.message))

  ctx.effect(() => () => {
    try { tunnel?.stop() } catch (e) { /* 忽略 */ }
  }, 'happy-harness relay cleanup')
}
