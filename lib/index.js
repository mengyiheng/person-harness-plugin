// Happy Harness relay plugin — v0.2（companion 核心进程内移植版）
// 职责：设备身份 + 云端注册 + 出站隧道（手机 attach/E2E/协议适配全部进程内完成）
// 配置（profile cordis.patch.yml 里本插件行的 config）：
//   server: 云端协调服务器（默认 http://8.137.177.62:9400）
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, hostname, platform } from 'node:os'
import { exec } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import QRCode from 'qrcode'
// ⛔ 不依赖 @deepseek-ai/dsh-llm：npm 版消息 schema 与宿主运行时错位曾致会话投影崩溃
//    （2026-10-23 🔴 事故，repair-sessions.mjs 修复）。插件不需要它。
import { Identity } from './identity.mjs'
import { TunnelClient } from './tunnel.mjs'
import { RemoteLinkClient, startLocalProxy } from './remote-link.mjs'
import * as history from './history.mjs'
import { DataBus, LEVEL_LABEL } from './data-bus.mjs'
import { databusHtml } from './databus-ui.mjs'
import { analyzeC, formatReport, findDuplicates, validateDeletable, recycleDelete, knownTargets } from './cleanup.mjs'
import { parseFerryArgs, sendFerry } from './ferry.mjs'
import { createTargets } from './targets.mjs'

export const name = 'happy-harness-relay'

const HOUR = 3600 * 1000
// M4.5 窗口实况：每窗口最近一帧哈希（静止零流量）+ 实况开启时间（点击安全闸门依据）
const lastLiveHash = new Map() // hwnd → 上一帧 JPEG sha256(hex)
const lastLiveAt = new Map()   // hwnd → 上次取帧时间戳（15s 内才允许点击）
const LIVE_TTL = 15 * 1000

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
  const historyFile = history.historyFileFor(dir)
  const log = (...args) => console.log('[happy]', ...args) // 🔴 必须在数据总线初始化之前（TDZ 教训：2026-10-24 因 log 未初始化致插件启动崩、隧道全断）
  // 数据总线（V5 本地数据连接器）：全量索引 + 分级 + 每-agent 策略；索引只存本机
  const dataBus = new DataBus(dir)
  if (!dataBus.state.sources.length) {
    dataBus.defaultSources()
    log('数据总线：默认监控 桌面/文档/下载（/happy data 可管理）')
  }
  let watchStarted = false
  const dataScan = () => dataBus.scan().then((r) => {
    if (r && !r.skipped) log(`数据总线扫描完成：索引 ${r.total} 个文件（更新 ${r.changed}）`)
    if (!watchStarted) { watchStarted = true; dataBus.startWatch((m) => log(m)) } // 首扫后开启实时监听
  }).catch((e) => log('数据总线扫描失败: ' + e.message))
  setTimeout(dataScan, 10 * 1000) // 启动让路：等隧道先连上
  setInterval(dataScan, 10 * 60 * 1000) // 每 10 分钟增量
  // 资源管理器页面 API（浏览器 → 本机，仅 owner Cookie 可达）
  const databusApi = async (b) => {
    try {
      switch (String(b.action || '')) {
        case 'stats': return { stats: { ...dataBus.stats(), scanning: dataBus.scanning } }
        case 'scan': return { result: await dataBus.scan() }
        case 'sources': return { sources: dataBus.listSources() }
        case 'sources/add': dataBus.addSource(b.path); dataScan(); return { ok: true }
        case 'sources/remove': return { ok: dataBus.removeSource(b.path) }
        case 'search': return { results: b.content ? dataBus.searchContent(String(b.q || ''), { limit: b.limit || 5 }) : dataBus.search(String(b.q || ''), { days: b.days, limit: b.limit }) }
        case 'read': {
          const r = dataBus.read(b.path, {})
          return r.error ? r : { content: r.content, level: r.level, size: r.size }
        }
        case 'uncertain': return dataBus.uncertain(Number(b.limit) || 20)
        case 'setlevel': return { ok: dataBus.setLevel(b.path, b.level, !!b.persist) }
        case 'policy': return { agents: dataBus.policy.agents, dirs: dataBus.policy.dirs || [] }
        case 'policy/set': dataBus.setPolicy(b.agent, b.levels); return { ok: true, agents: dataBus.policy.agents }
        case 'policy/setdir': dataBus.setDirPolicy(b.path, b.agent, b.levels); return { ok: true, dirs: dataBus.policy.dirs }
        case 'policy/deldir': return { ok: dataBus.removeDirPolicy(b.path, b.agent), dirs: dataBus.policy.dirs }
        case 'weekly': return { report: dataBus.weeklyReport(Number(b.days) || 7) }
        case 'access': return b.path ? { items: dataBus.fileAccess(b.path) } : { items: dataBus.recentAccess(Number(b.limit) || 30) }
        case 'alerts': return { alerts: dataBus.alerts() }
        case 'timeline': return dataBus.timeline({ days: b.days, q: b.q, limit: b.limit })
        case 'ziplist': return dataBus.zipList(String(b.path || ''), { limit: b.limit })
        case 'cleanup': {
          // 磁盘清理分析（只读）：结果缓存 10 分钟（全量统计耗时约 1~2 分钟）
          if (!globalThis.__hhCleanup || Date.now() - globalThis.__hhCleanup.at > 10 * 60 * 1000) {
            globalThis.__hhCleanup = { at: Date.now(), report: await analyzeC() }
          }
          return { report: globalThis.__hhCleanup.report }
        }
        case 'duplicates': {
          if (!globalThis.__hhDupes || Date.now() - globalThis.__hhDupes.at > 10 * 60 * 1000) {
            globalThis.__hhDupes = { at: Date.now(), result: await findDuplicates(dataBus.state.sources.map((s) => s.path)) }
          }
          return { result: globalThis.__hhDupes.result }
        }
        case 'cleanup/execute': {
          // 🔴 破坏性操作的唯一通道：逐项校验（范围+保护路径+分级否决）→ 回收站删除 → 台账留痕
          const paths = Array.isArray(b.paths) ? b.paths.slice(0, 50) : []
          if (!paths.length) return { error: 'paths 必填' }
          const allowedRoots = [
            ...knownTargets(process.env).filter((t) => t.cleanable).map((t) => t.path),
            ...dataBus.state.sources.map((s) => s.path)
          ]
          const results = []
          for (const p of paths) {
            const v = validateDeletable(p, {
              allowedRoots,
              lookupLevel: (x) => dataBus.state.files[x]?.lv || null,
              allowSensitive: !!b.allowSensitive
            })
            if (!v.ok) { results.push({ path: p, ok: false, error: v.reason }); continue }
            try { dataBus.noteWrite(p) } catch (e) { /* 忽略 */ }
            results.push(...(b.dryRun ? [{ path: p, ok: true, dryRun: true }] : (await recycleDelete([p]))))
            if (!b.dryRun) dataBus.recordAccess('owner', 'cleanup', p, true)
          }
          globalThis.__hhCleanup = null; globalThis.__hhDupes = null // 缓存失效
          return { results, deleted: results.filter((r) => r.ok && !r.dryRun).length }
        }
        default: return { error: 'unknown action' }
      }
    } catch (e) {
      return { error: e?.message ?? String(e) }
    }
  }

  log(`插件启动：server=${server} dshHome=${dshHome}`)
  // V4.3 连接历史：启动自愈（补上次异常断开的 close 行）
  const repaired = history.repair(historyFile)
  if (repaired) log(`连接历史自愈：补写 ${repaired} 条异常断开记录`)

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

  // 通用壳 P1：targets registry（/t/<name>/ 路由；dsh 为首目标，非 /t/ 路径行为与旧版一致）
  // 🔴 必须在 getOrigin/mintCookie 定义之后（TDZ 教训 2026-10-24 二犯：放前面致插件启动崩、隧道全断）
  const targets = createTargets({ cfg: config, getOrigin, mintCookie, log })

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
    // 数据总线 · 浏览器资源管理器（本机弹出；同源 Cookie 鉴权）
    try {
      connSvc.fetch.register({
        path: '/api/happy-databus',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => Promise.resolve(new Response(databusHtml(), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
        }))
      })
      connSvc.fetch.register({
        path: '/api/happy-databus/api',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (req) => req.json().catch(() => ({})).then((b) => databusApi(b))
          .then((body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }))
      })
      log('数据总线资源管理器路由已注册 /api/happy-databus')
    } catch (e) {
      log('数据总线路由注册失败: ' + e.message)
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
    '- `/happy link` —— 远程登录：二维码给已配对手机扫，授权本机登录那台电脑的 dsh',
    '- `/happy devices` —— 列出已配对设备',
    '- `/happy revoke <pairId>` —— 解除配对',
    '- `/happy history` —— 连接记录（最近 20 次，仅保存在本机）',
    '- `/happy clip [文字]` —— 无参数=看电脑剪贴板；带文字=放进电脑剪贴板',
    '- `/happy shot [窗口标题]` —— 截取电脑屏幕（可指定窗口），保存并打开',
    '- `/happy data` —— 打开资源管理器（监控目录/文件分级/agent 策略）；`data scan|stats|search <词>|audit`',
    '- `/happy mcp` —— 生成 MCP 桥安装配置（Claude Code/OpenCode 等宿主接入本机检索）',
    '- `/happy clean` —— C 盘空间分析（只读报告：可清理项/大头目录/大旧文件；永不自动删除）',
    '- `/happy ferry <路径> [@备注]` —— 跨机互传：经电脑间通道把文件送到对端（需先 `/happy link`）',
    '- `/happy status` —— 隧道与身份状态',
    '- 手机 App「工具」页 —— 文件互传 / 剪贴板 / 截图（V4.4，需 App 配套版本）'
  ].join('\n')

  ctx.inject(['commands'], (c) => {
    const commands = c.commands
    if (!commands) { log('commands 服务不可用，/happy 未注册'); return }
    commands.register({
      definitionId: 'happy-harness-relay',
      name: 'happy',
      description: 'Happy Harness 手机配对与管理（pair / devices / revoke / status / history / clip / shot / data）',
      input: { hint: 'pair | devices | revoke <id> | status | history | clip [文字] | shot [窗口标题] | data [scan|stats|search <词>]' },
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
          if (action === 'history') {
            // V4.3 连接历史：只读本机文件，云端无副本
            const list = history.sessions(historyFile, 20)
            if (list.length === 0) return { kind: 'success', text: '暂无连接记录。记录只保存在本机（connection-history.jsonl），云端没有副本。' }
            const fmt = (s) => {
              const d = (iso) => new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
              const dur = s.durSec == null ? '进行中' : s.durSec < 60 ? `${s.durSec} 秒` : `${Math.round(s.durSec / 60)} 分钟`
              return `- ${d(s.start)} → ${s.end ? d(s.end) : '—'}（${dur}）· 设备 #${s.seq ?? '?'} · ${s.path === 'direct' ? '直连' : '中继'}${s.reason === 'abnormal' ? ' · 异常断开' : ''}`
            }
            return {
              kind: 'success',
              text: [`**连接记录**（最近 ${list.length} 次，仅保存在本机，云端无副本）`, '', ...list.map(fmt).reverse()].join('\n')
            }
          }
          if (action === 'clip') {
            // V4.4 剪贴板：无参数=读取；带参数=写入
            const arg = raw.slice(raw.indexOf(action) + action.length).trim()
            if (!arg) {
              const r = await onToolRequest('/__happy/clipboard/get', 'POST', Buffer.from('{}'))
              const b = r.body || {}
              if (r.status !== 200) return { kind: 'error', text: '读取剪贴板失败：' + (b.error ?? '未知') }
              return { kind: 'success', text: '**电脑剪贴板当前内容：**\n\n' + (b.text || '（空）') }
            }
            const r = await onToolRequest('/__happy/clipboard/set', 'POST', Buffer.from(JSON.stringify({ text: arg })))
            if (r.status !== 200) return { kind: 'error', text: '写入剪贴板失败：' + (r.body?.error ?? '未知') }
            return { kind: 'success', text: '✅ 已复制到电脑剪贴板（' + arg.length + ' 字）。' }
          }
          if (action === 'shot' || action === 'screenshot') {
            // V4.4 截图：默认全屏；带窗口标题=按窗口抓取。保存到桌面并打开
            const arg = raw.slice(raw.indexOf(action) + action.length).trim()
            const req = arg ? { target: 'match', match: arg } : { target: 'screen' }
            const r = await onToolRequest('/__happy/screenshot', 'POST', Buffer.from(JSON.stringify(req)))
            const b = r.body || {}
            if (r.status !== 200) return { kind: 'error', text: '截图失败：' + (b.error ?? '未知') }
            const dir = join(homedir(), 'Desktop', 'HappyHarness截图')
            try { mkdirSync(dir, { recursive: true }) } catch (e) { /* 忽略 */ }
            const dest = join(dir, 'shot_' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '.png')
            writeFileSync(dest, Buffer.from(b.b64, 'base64'))
            try {
              exec('explorer /select,"' + dest + '"', { timeout: 5000 }, () => {})
            } catch (e) { /* 打开失败不致命 */ }
            return { kind: 'success', text: '✅ 截图已保存并打开所在位置：\n`' + dest + '`' + (b.count > 1 ? '\n（多显示器，共 ' + b.count + ' 张，已保存第一张；全部截图在工具页查看）' : '') }
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
          if (action === 'link') {
            // V4 远程登录：申请授权码 → 弹二维码（手机扫码授权本机登录它的主 PC）
            const lc = await identity.requestLinkCode()
            const deepLink = `myapp://remote-link?server=${encodeURIComponent(serverHost)}&from=${encodeURIComponent(identity.deviceId)}&id=${encodeURIComponent(lc.id)}`
            qrPng = await QRCode.toBuffer(deepLink, { margin: 1, width: 320 })
            qrHtml = `<!doctype html><meta charset="utf-8"><title>Happy Harness 远程登录</title>` +
              `<style>body{font-family:system-ui;display:flex;flex-direction:column;align-items:center;` +
              `background:#f5f6f8;color:#222;padding:32px}img{border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.12);` +
              `background:#fff;padding:12px}.tip{color:#666;margin-top:8px;font-size:14px;text-align:center}</style>` +
              `<img src="data:image/png;base64,${qrPng.toString('base64')}" width="320" height="320">` +
              `<div class="tip">已配对的手机 App 扫此码 → 确认授权 → 本机浏览器将自动打开那台电脑的 dsh<br>` +
              `${lc.expiresInSec ?? 300}s 内有效｜授权后连接保持 12 小时</div>`
            let opened = false
            try { opened = openInBrowser(getOrigin() + '/api/happy-qr') } catch (e) { log('二维码页打开异常: ' + e.message) }
            startRemoteLinkPoller(lc.id)
            return {
              kind: 'success',
              text: [
                '**远程登录授权** —— 二维码已弹出，请用已配对的手机扫码确认' + (opened ? '' : '（未弹出则手动打开 ' + getOrigin() + '/api/happy-qr）'),
                `授权成功后本机 http://127.0.0.1:${REMOTE_PORT}/ 自动打开那台电脑的 dsh GUI`,
                `\`/happy link stop\` 可随时断开`
              ].join('\n')
            }
          }
          if (action === 'link-stop' || (action === 'link' && raw.split(/\s+/)[1] === 'stop')) {
            stopRemoteLink()
            return { kind: 'success', text: '远程登录链路已断开。' }
          }
          if (action === 'data' || action === 'bus') {
            // 数据总线：无参数=弹浏览器资源管理器；scan/sources/search <词>/stats
            const arg1 = raw.split(/\s+/)[1] || ''
            if (arg1 === 'scan') {
              const r = await dataBus.scan()
              return { kind: 'success', text: r.skipped ? '已在扫描中。' : `✅ 扫描完成：索引共 ${r.total} 个文件（本次更新 ${r.changed}）` }
            }
            if (arg1 === 'search') {
              const q = raw.slice(raw.indexOf('search') + 6).trim()
              const results = dataBus.search(q, {})
              if (!results.length) return { kind: 'success', text: `无命中（${q}）。级别「${dataBus.allowedFor('local').map((l) => LEVEL_LABEL[l]).join('/')}」内检索。` }
              return { kind: 'success', text: ['**检索命中**（只返回命中条目，级别策略已过滤）', '', ...results.map((f) => `- \`${f.name}\`（${LEVEL_LABEL[f.level]}·${Math.round(f.size / 1024)}KB）\n  \`${f.path}\``)].join('\n') }
            }
            if (arg1 === 'stats' || arg1 === 'sources') {
              const s = dataBus.stats()
              const src = dataBus.listSources().map((x) => `  - \`${x.path}\`（${x.files} 个，${x.lastScan}）`).join('\n')
              const alerts = dataBus.alerts()
              const alertLine = alerts.length ? `\n- ⚠️ 危险提醒 ${alerts.length} 条（最新：${alerts[0].msg}）——\`/happy data audit\` 或资源管理器查看` : ''
              return { kind: 'success', text: [`**数据总线状态**`, `- 索引：${s.total} 个文件（公开 ${s.byLevel.public} / 内部 ${s.byLevel.internal} / 敏感 ${s.byLevel.sensitive} / 禁碰 ${s.byLevel.restricted}）`, `- 待复核：${dataBus.uncertain(1).total} 个`, `- 监控目录：`, src, `- 索引只存本机；agent 检索按级别策略过滤并留痕${alertLine}`].join('\n') }
            }
            if (arg1 === 'audit' || arg1 === 'access') {
              const list = dataBus.recentAccess(20)
              const alerts = dataBus.alerts()
              const alertText = alerts.length ? ['**⚠️ 危险行为提醒**', ...alerts.slice(0, 5).map((a) => `- ${a.level === 'high' ? '🔴' : '🟡'} ${a.msg}`), ''].join('\n') : '**✅ 无危险行为提醒**\n\n'
              if (!list.length) return { kind: 'success', text: alertText + '暂无访问记录。台账只保存在本机（data-access.jsonl）。' }
              return { kind: 'success', text: [alertText, `**最近访问**（${list.length} 条，仅本机）：`, ...list.slice(0, 15).map((a) => `- ${a.time} · ${a.agent} · ${a.ev}${a.hits != null ? '（' + a.hits + ' 命中）' : ''}${a.ok ? '' : ' **被拒**'}\n  \`${a.path.slice(0, 100)}\``)].join('\n') }
            }
            if (arg1 === 'timeline') {
              // A 方向：文件时间线（"最近哪天改了什么"）
              const days = Number(raw.split(/\s+/)[2]) || 7
              const tl = dataBus.timeline({ days })
              if (!tl.total) return { kind: 'success', text: `最近 ${days} 天索引内无文件变动。` }
              return { kind: 'success', text: [`**文件时间线**（最近 ${days} 天，共 ${tl.total} 个变动）`, '', ...tl.timeline.map((d) => `**${d.day}**（${d.count} 个）\n${d.files.slice(0, 5).map((f) => `- \`${f.name}\`（${LEVEL_LABEL[f.level]}）`).join('\n')}`)].join('\n') }
            }
            if (arg1 === 'weekly') {
              // B 方向：台账周报（owner 专属，含明细）
              const r = dataBus.weeklyReport(Number(raw.split(/\s+/)[2]) || 7)
              if (!r.agents.length) return { kind: 'success', text: `最近 ${r.days} 天台账无访问记录。` }
              return { kind: 'success', text: [`**台账周报**（最近 ${r.days} 天）`, '', ...r.agents.map((a) => `- **${a.agent}**：检索 ${a.searches} 次 / 命中 ${a.hits} / 读取 ${a.reads}${a.denied ? ` / 🟡被拒 ${a.denied}` : ''}`), ...(r.topFiles.length ? ['', '**最常被读**：', ...r.topFiles.slice(0, 5).map((f) => `- ${f.reads} 次  \`${f.name}\``)] : []), '', `危险提醒：🔴${r.alerts.high} 高 / 🟡${r.alerts.warn} 中（详见 \`/happy data audit\`）`].join('\n') }
            }
            let opened = false
            try { opened = openInBrowser(getOrigin() + '/api/happy-databus') } catch (e) { log('资源管理器打开失败: ' + e.message) }
            return { kind: 'success', text: `**资源管理器已在浏览器打开**${opened ? '' : '（未弹出则手动打开 ' + getOrigin() + '/api/happy-databus）'}\n可管理监控目录、文件分级、agent 访问策略；子命令：\`/happy data scan|stats|search <词>\`` }
          }
          if (action === 'ferry') {
            // 跨机互传：/happy ferry <本地路径> [@备注]——经当前 happy link 通道送到对端电脑
            const { path: fPath } = parseFerryArgs(raw.slice(raw.indexOf(action) + action.length))
            if (!fPath) return { kind: 'error', text: '用法：/happy ferry <本地路径> [@备注]\n前提：先 /happy link 建立与目标电脑的通道（本地代理在跑）' }
            if (!remoteLink || !remoteLink.proxy) return { kind: 'error', text: '当前没有活跃的电脑间通道。先执行 `/happy link` 扫码建立，再 ferry。' }
            const port = Number((remoteLink.proxy.url.match(/:(\d+)/) || [])[1]) || 9630
            const r = await sendFerry(fPath, { port })
            try { dataBus.recordAccess('owner', 'ferry-send', fPath, !!r.ok) } catch (e) { /* 留痕失败不阻塞 */ }
            return r.ok
              ? { kind: 'success', text: `✅ 已送达对端电脑：\n\`${r.savedTo}\`\n（${Math.round((r.size || 0) / 1024)}KB；对端台账以「上传」入账，本端记 ferry-send）` }
              : { kind: 'error', text: 'ferry 失败：' + r.error }
          }
          if (action === 'clean' || action === 'cleanup') {
            // M5 磁盘清理分析：只读报告，🔴 永不自动删除
            const sub = raw.split(/\s+/)[1] || ''
            if (sub === 'dup' || sub === 'duplicates' || sub === '重复') {
              const roots = dataBus.state.sources.map((s) => s.path)
              if (!roots.length) return { kind: 'error', text: '暂无监控数据源，先在资源管理器添加。' }
              const d = await findDuplicates(roots, { minSizeMB: 1 })
              if (!d.groups.length) return { kind: 'success', text: `✅ 未发现重复文件（扫描 ${d.scannedNodes} 项）。` }
              return { kind: 'success', text: [`**重复文件**（同内容分组，浪费合计 ${d.wasteText}；仅列出，删除须在资源管理器逐项确认）`, '', ...d.groups.slice(0, 15).map((g) => `- ${g.sizeText} × ${g.files.length} 份（浪费 ${g.wasteText}）\n${g.files.map((f) => `  \`${f}\``).join('\n')}`)].join('\n') }
            }
            return { kind: 'success', text: formatReport(await analyzeC()) }
          }
          if (action === 'mcp') {
            // M3 MCP 桥：输出各宿主的安装配置（agent 名=用户意图声明，默认只给 公开/内部）
            const script = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs')
            const snippet = JSON.stringify({ command: process.execPath, args: [script], env: { HAPPY_AGENT: '<agent名>', HAPPY_DATA_DIR: dir } }, null, 2)
            return { kind: 'success', text: [`**MCP 桥安装**（任何 MCP 宿主通用）`, '', '在宿主的 MCP 配置里加：', '```json', snippet, '```', '', '- `HAPPY_AGENT` 填宿主名（如 claude-code）——这是策略与台账里的身份', '- 未声明的 agent 默认只能看 公开/内部 级', '- 检索/读取全部进访问台账（资源管理器或 /happy data audit 查看）'].join('\n') }
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

  // 设备显示名：本机信息在前，插件版本在后（手机设备页/网页登录页用它区分多台电脑）
  const PLUGIN_VERSION = (() => {
    try {
      return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || '0'
    } catch (e) { return '0' }
  })()
  const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[platform()] || platform()
  const deviceName = `${hostname()} · ${PLATFORM_LABEL} · dsh v${PLUGIN_VERSION}`

  // ---- V4 远程登录：内部请求处理（经 E2E 从手机到达）----
  // ---- V4.4 工具端点：文件 / 剪贴板 / 截图（仅经 E2E 隧道可达，已配对设备专用） ----
  const FILE_MAX_DOWNLOAD = 50 * 1024 * 1024  // 单文件下载上限（内存限制）
  const FILE_MAX_UPLOAD = 25 * 1024 * 1024    // 单文件上传上限
  const inboxDir = () => {
    const base = join(homedir(), 'Downloads', '来自手机')
    try { mkdirSync(base, { recursive: true }) } catch (e) { /* 忽略 */ }
    return base
  }
  const safeName = (n) => String(n || 'file').split(/[\\/]/).pop().replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 120) || 'file'
  const runPS = (script) => new Promise((resolve) => {
    // 🔴 统一注入 UTF-8 输出编码（2026-10-24）：PS 5.1 管道输出默认 GBK/OEM 码页，
    //    中文文本（如 windows/list 的窗口标题）Node 按 UTF-8 解即乱码。
    //    各端点脚本此前靠 base64 逃避此问题，这里源头统一。
    const full = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n' + script
    const enc = Buffer.from(full, 'utf16le').toString('base64')
    const ps = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    exec(`"${ps}" -NoProfile -NonInteractive -EncodedCommand ${enc}`, { encoding: 'buffer', timeout: 20000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? { ok: false, error: String(err.message) } : { ok: true, out: stdout })
    })
  })
  const parseBody = (body) => { try { return JSON.parse(body.toString('utf8') || '{}') } catch (e) { return null } }

  const onToolRequest = async (path, method, body) => {
    const b = parseBody(body)
    if (!b) return { status: 400, body: { error: 'bad json' } }
    if (path === '/__happy/files/list' && method === 'POST') {
      const p = (typeof b.path === 'string' && b.path.trim()) ? b.path.trim() : homedir()
      let items = []
      try {
        items = readdirSync(p).map((name) => {
          try {
            const st = statSync(join(p, name))
            return { name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
          } catch (e) { return null }
        }).filter(Boolean)
          .sort((a, b2) => (a.dir !== b2.dir) ? (a.dir ? -1 : 1) : a.name.localeCompare(b2.name))
          .slice(0, 500)
      } catch (e) { return { status: 400, body: { error: e.message } } }
      return { status: 200, body: { path: p, items } }
    }
    if (path === '/__happy/file/get' && method === 'POST') {
      const p = String(b.path || '')
      let st
      try { st = statSync(p) } catch (e) { return { status: 404, body: { error: 'not found' } } }
      if (st.isDirectory()) return { status: 400, body: { error: 'is directory' } }
      if (st.size > FILE_MAX_DOWNLOAD) return { status: 413, body: { error: '文件超过 50MB，暂不支持' } }
      return { status: 200, body: { name: safeName(p), size: st.size, b64: readFileSync(p).toString('base64') } }
    }
    if (path === '/__happy/file/put' && method === 'POST') {
      const buf = Buffer.from(String(b.b64 || ''), 'base64')
      if (!buf.length) return { status: 400, body: { error: 'empty' } }
      if (buf.length > FILE_MAX_UPLOAD) return { status: 413, body: { error: '文件超过 25MB，暂不支持' } }
      const base = inboxDir()
      let dest = join(base, safeName(b.name))
      const ext = dest.lastIndexOf('.')
      let i = 1
      while (existsSync(dest)) { dest = ext > 0 ? join(base, safeName(b.name).slice(0, ext) + `(${i})` + safeName(b.name).slice(ext)) : join(base, safeName(b.name) + `(${i})`); i++ }
      try { writeFileSync(dest, buf) } catch (e) { return { status: 500, body: { error: e.message } } }
      // 上传台账 + 收件箱即刻进索引（归因登记在先，避免被误判"插件外修改"）
      dataBus.noteWrite(dest)
      dataBus.recordAccess('phone', 'upload', dest, true, { size: buf.length })
      try {
        if (!dataBus.state.sources.some((s) => s.path.toLowerCase() === base.toLowerCase())) dataBus.addSource(base)
        dataScan()
      } catch (e) { /* 索引更新失败不阻塞上传 */ }
      log(`收到手机文件: ${dest} (${buf.length}B)`)
      return { status: 200, body: { ok: true, savedTo: dest, size: buf.length } }
    }
    if (path === '/__happy/clipboard/get' && method === 'POST') {
      const r = await runPS('\'<<<HAPPY>>>\' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Clipboard -Raw)))')
      if (!r.ok) return { status: 500, body: { error: r.error } }
      const b64 = String(r.out).split('<<<HAPPY>>>').pop().trim()
      return { status: 200, body: { text: Buffer.from(b64, 'base64').toString('utf8') } }
    }
    if (path === '/__happy/clipboard/set' && method === 'POST') {
      const b64 = Buffer.from(String(b.text || ''), 'utf8').toString('base64')
      const r = await runPS(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`)
      if (!r.ok) return { status: 500, body: { error: r.error } }
      return { status: 200, body: { ok: true } }
    }
    if (path === '/__happy/screenshot' && method === 'POST') {
      // target: screen(全屏，默认) / active(前台窗口) / match(按窗口标题模糊匹配)
      const target = String(b.target || 'screen')
      const match = String(b.match || '').replace(/'/g, '').slice(0, 80)
      let ps
      if (target === 'active') {
        ps = [
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
          'Add-Type @\'',
          'using System;using System.Runtime.InteropServices;',
          'public class HHW1 {',
          '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
          '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
          '  public struct RECT { public int Left, Top, Right, Bottom; }',
          '}',
          '\'@',
          '$h = [HHW1]::GetForegroundWindow()',
          '$r = New-Object HHW1+RECT',
          '[HHW1]::GetWindowRect($h, [ref]$r) | Out-Null',
          '$wd = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top',
          'if ($wd -le 0 -or $ht -le 0) { throw "window invisible" }',
          '$bmp = New-Object System.Drawing.Bitmap $wd, $ht',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)',
          '$ms = New-Object System.IO.MemoryStream',
          '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
          '\'<<<HAPPY>>>\' + [Convert]::ToBase64String($ms.ToArray())'
        ].join('\n')
      } else if (target === 'match') {
        if (!match) return { status: 400, body: { error: 'match required' } }
        ps = [
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
          'Add-Type @\'',
          'using System;using System.Runtime.InteropServices;',
          'public class HHW2 {',
          '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);',
          '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
          '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
          '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
          '  public struct RECT { public int Left, Top, Right, Bottom; }',
          '}',
          '\'@',
          `$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*${match}*' } | Select-Object -First 1`,
          'if (-not $p) { throw "no window matched" }',
          '$h = $p.MainWindowHandle',
          'if ([HHW2]::IsIconic($h)) { [HHW2]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 500 }',
          '$r = New-Object HHW2+RECT',
          '[HHW2]::GetWindowRect($h, [ref]$r) | Out-Null',
          '$wd = [Math]::Max(1, $r.Right - $r.Left); $ht = [Math]::Max(1, $r.Bottom - $r.Top)',
          '$bmp = New-Object System.Drawing.Bitmap $wd, $ht',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$hdc = $g.GetHdc()',
          '[HHW2]::PrintWindow($h, $hdc, 2) | Out-Null',
          '$g.ReleaseHdc($hdc)',
          '$ms = New-Object System.IO.MemoryStream',
          '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
          '\'<<<HAPPY>>>\' + [Convert]::ToBase64String($ms.ToArray())'
        ].join('\n')
      } else {
        // 多显示器：逐屏分别截图（各屏独立构图，不拼接），返回 shots 数组；b64 = 第一屏（兼容旧 App）
        ps = [
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
          '$out = @()',
          '$i = 0',
          'foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {',
          '  $bmp = New-Object System.Drawing.Bitmap $s.Bounds.Width, $s.Bounds.Height',
          '  $g = [System.Drawing.Graphics]::FromImage($bmp)',
          '  $g.CopyFromScreen($s.Bounds.X, $s.Bounds.Y, 0, 0, $bmp.Size)',
          '  $ms = New-Object System.IO.MemoryStream',
          '  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
          '  $out += (\'<<<HAPPY>>>\' + ($i + 1) + \'|\' + $s.Bounds.Width + \'|\' + $s.Bounds.Height + \'|\' + [Convert]::ToBase64String($ms.ToArray()))',
          '  $i++',
          '}',
          '$out -join \'\''
        ].join('\n')
      }
      const r = await runPS(ps)
      if (!r.ok) return { status: 500, body: { error: String(r.error).split('\n').slice(-3).join(' ').slice(0, 200) } }
      let b64 = String(r.out).split('<<<HAPPY>>>').pop().trim()
      let shots = null
      if (b64.includes('|')) {
        // 多屏形态：每段 = 序号|宽|高|b64
        shots = String(r.out).split('<<<HAPPY>>>').filter((s) => s.trim()).map((s) => {
          const seg = s.trim()
          const p1 = seg.indexOf('|')
          const p2 = seg.indexOf('|', p1 + 1)
          const p3 = seg.indexOf('|', p2 + 1)
          return { screen: Number(seg.slice(0, p1)), w: Number(seg.slice(p1 + 1, p2)), h: Number(seg.slice(p2 + 1, p3)), b64: seg.slice(p3 + 1) }
        })
        if (shots.length) b64 = shots[0].b64
      }
      if (!b64.length) return { status: 500, body: { error: '截图为空（可能不在交互会话）' } }
      return { status: 200, body: shots ? { b64, shots, count: shots.length } : { b64 } }
    }
    // ---- M4.5 窗口实况 + 点击回传 ----
    if (path === '/__happy/windows/list' && method === 'POST') {
      // 枚举所有可见且标题非空的顶层窗口（Z 顺序即枚举顺序）
      const ps = [
        'Add-Type @\'',
        'using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;',
        'public class HHW3 {',
        '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
        '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s, int n);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
        '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
        '  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);',
        '  public struct RECT { public int Left, Top, Right, Bottom; }',
        '  public static List<string> List() {',
        '    var res = new List<string>();',
        '    EnumWindows((h, l) => {',
        '      if (!IsWindowVisible(h)) return true;',
        '      int cl = 0; DwmGetWindowAttribute(h, 14, out cl, 4);',
        '      if (cl != 0) return true; // cloaked（UWP 挂起等假可见窗口）过滤',
        '      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);',
        '      string t = sb.ToString();',
        '      if (t.Length == 0) return true;',
        '      RECT r; GetWindowRect(h, out r);',
        '      res.Add(h.ToInt64() + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + (IsIconic(h) ? 1 : 0) + "|" + t.Replace("|", "/").Replace("\\n", " ").Replace("\\r", " "));',
        '      return true;',
        '    }, IntPtr.Zero);',
        '    return res;',
        '  }',
        '}',
        '\'@',
        '[HHW3]::List() | ForEach-Object { \'<<<HAPPY>>>\' + $_ }'
      ].join('\n')
      const r = await runPS(ps)
      if (!r.ok) return { status: 500, body: { error: String(r.error).split('\n').slice(-3).join(' ').slice(0, 200) } }
      const windows = String(r.out).split('<<<HAPPY>>>').map((s) => s.trim()).filter(Boolean).map((line) => {
        const p1 = line.indexOf('|'); const p2 = line.indexOf('|', p1 + 1); const p3 = line.indexOf('|', p2 + 1); const p4 = line.indexOf('|', p3 + 1)
        return { hwnd: line.slice(0, p1), w: Number(line.slice(p1 + 1, p2)), h: Number(line.slice(p2 + 1, p3)), minimized: line.slice(p3 + 1, p4) === '1', title: line.slice(p4 + 1).slice(0, 80) }
      })
      return { status: 200, body: { windows } }
    }
    if (path === '/__happy/live/frame' && method === 'POST') {
      // 手机端实况帧：hwnd 必填；内容未变化返回 changed:false（静止零流量）
      const hwnd = String(b.hwnd || '')
      if (!/^\d+$/.test(hwnd)) return { status: 400, body: { error: 'hwnd required' } }
      const maxW = Math.max(160, Number(b.maxW) || 720)
      const q = Math.min(95, Math.max(20, Number(b.q) || 60))
      const ps = [
        'Add-Type -AssemblyName System.Drawing',
        'Add-Type @\'',
        'using System;using System.Runtime.InteropServices;',
        'public class HHW4 {',
        '  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
        '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
        '  public struct RECT { public int Left, Top, Right, Bottom; }',
        '}',
        '\'@',
        '$h = [IntPtr]' + hwnd,
        'if (-not [HHW4]::IsWindow($h)) { throw "bad hwnd" }',
        'if ([HHW4]::IsIconic($h)) { [HHW4]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 300 }',
        '$r = New-Object HHW4+RECT',
        '[HHW4]::GetWindowRect($h, [ref]$r) | Out-Null',
        '$wd = [Math]::Max(1, $r.Right - $r.Left); $ht = [Math]::Max(1, $r.Bottom - $r.Top)',
        '$bmp = New-Object System.Drawing.Bitmap $wd, $ht',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$hdc = $g.GetHdc()',
        '[HHW4]::PrintWindow($h, $hdc, 2) | Out-Null', // 2 = PW_RENDERFULLCONTENT
        '$g.ReleaseHdc($hdc); $g.Dispose()',
        'if ($wd -gt ' + maxW + ') { $sc = ' + maxW + ' / $wd; $bmp2 = New-Object System.Drawing.Bitmap $bmp, ([int]($wd * $sc)), ([int]($ht * $sc)); $bmp.Dispose(); $bmp = $bmp2 }',
        '$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }',
        '$ep = New-Object System.Drawing.Imaging.EncoderParameters 1',
        '$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]' + q + ')',
        '$ms = New-Object System.IO.MemoryStream',
        '$bmp.Save($ms, $codec, $ep)',
        '$wd2 = $bmp.Width; $ht2 = $bmp.Height; $bmp.Dispose()',
        '\'<<<HAPPY>>>\' + $wd2 + \'|\' + $ht2 + \'|\' + [Convert]::ToBase64String($ms.ToArray())'
      ].join('\n')
      const r = await runPS(ps)
      if (!r.ok) return { status: 500, body: { error: String(r.error).split('\n').slice(-3).join(' ').slice(0, 200) } }
      const seg = String(r.out).split('<<<HAPPY>>>').pop().trim()
      const p1 = seg.indexOf('|'); const p2 = seg.indexOf('|', p1 + 1)
      const w = Number(seg.slice(0, p1)); const h = Number(seg.slice(p1 + 1, p2))
      const b64 = seg.slice(p2 + 1)
      if (!b64.length) return { status: 500, body: { error: '实况帧为空' } }
      const hash = createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
      if (lastLiveHash.get(hwnd) === hash) return { status: 200, body: { changed: false } }
      // "开启实况"：该窗口此前不在（或已过期）实况状态 → 台账留痕
      const wasLive = lastLiveAt.get(hwnd) && Date.now() - lastLiveAt.get(hwnd) < LIVE_TTL
      lastLiveHash.set(hwnd, hash)
      lastLiveAt.set(hwnd, Date.now())
      if (!wasLive) {
        try { history.record(historyFile, { ev: 'remote-view', hwnd, title: String(b.title || '').slice(0, 60) }) } catch (e) { /* 留痕失败不阻塞 */ }
      }
      return { status: 200, body: { changed: true, b64, w, h, hash } }
    }
    if (path === '/__happy/click' && method === 'POST') {
      // 🔴 安全闸门：只允许正处于实况状态（15s 内取过帧）的窗口接收点击
      const hwnd = String(b.hwnd || '')
      if (!/^\d+$/.test(hwnd)) return { status: 400, body: { error: 'hwnd required' } }
      const x = Number(b.x); const y = Number(b.y)
      if (!(x >= 0 && x <= 1) || !(y >= 0 && y <= 1)) return { status: 400, body: { error: 'x/y 须为 0~1 归一化坐标' } }
      const at = lastLiveAt.get(hwnd)
      if (!at || Date.now() - at >= LIVE_TTL) return { status: 403, body: { error: '窗口不在实况状态，拒绝点击' } }
      const ps = [
        'Add-Type @\'',
        'using System;using System.Runtime.InteropServices;',
        'public class HHW5 {',
        '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
        '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
        '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);',
        '  public struct RECT { public int Left, Top, Right, Bottom; }',
        '}',
        '\'@',
        '$h = [IntPtr]' + hwnd,
        '$r = New-Object HHW5+RECT',
        'if (-not [HHW5]::GetWindowRect($h, [ref]$r)) { throw "bad hwnd" }',
        '$sx = $r.Left + [int][Math]::Round(' + x.toFixed(6) + ' * ($r.Right - $r.Left))',
        '$sy = $r.Top + [int][Math]::Round(' + y.toFixed(6) + ' * ($r.Bottom - $r.Top))',
        '[HHW5]::SetCursorPos($sx, $sy) | Out-Null',
        '[HHW5]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) | Out-Null',  // LEFTDOWN
        'Start-Sleep -Milliseconds 60',
        '[HHW5]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero) | Out-Null',  // LEFTUP
        '\'<<<HAPPY>>>\' + $sx + \'|\' + $sy'
      ].join('\n')
      const r = await runPS(ps)
      if (!r.ok) return { status: 500, body: { error: String(r.error).split('\n').slice(-3).join(' ').slice(0, 200) } }
      const seg = String(r.out).split('<<<HAPPY>>>').pop().trim()
      const p = seg.indexOf('|')
      const sx = Number(seg.slice(0, p)); const sy = Number(seg.slice(p + 1))
      try { history.record(historyFile, { ev: 'remote-click', hwnd, title: String(b.title || '').slice(0, 60), x, y, sx, sy }) } catch (e) { /* 留痕失败不阻塞 */ }
      return { status: 200, body: { ok: true, sx, sy } }
    }
    // ---- 数据总线（经 E2E，已配对 agent 检索本机资料）----
    // 纪律：只返回查询命中（绝不倒库）；级别策略按 agent 过滤；每次 search/read 审计留痕
    if (path.startsWith('/__happy/data/')) {
      const agent = String(b.agent || 'phone')
      const audit = (ev, extra) => { try { history.record(historyFile, { ev, ...extra }) } catch (e) { /* 审计失败不阻塞 */ } }
      if (path === '/__happy/data/search' && method === 'POST') {
        const q = String(b.query || b.q || '')
        const opts = { ext: b.ext, days: b.days, limit: b.limit, agent }
        const results = b.content ? dataBus.searchContent(q, opts) : dataBus.search(q, opts)
        dataBus.recordAccess(agent, 'search', q, true, { hits: results.length })
        for (const f of results.slice(0, 20)) dataBus.recordAccess(agent, 'hit', f.path, true)
        audit('data-search', { agent, q: q.slice(0, 60), hits: results.length, content: !!b.content })
        return { status: 200, body: { agent, allowed: dataBus.allowedFor(agent).map((l) => LEVEL_LABEL[l]), content: !!b.content, results } }
      }
      if (path === '/__happy/data/read' && method === 'POST') {
        const r = dataBus.read(String(b.path || ''), { agent })
        dataBus.recordAccess(agent, 'read', String(b.path || ''), !r.error)
        audit('data-read', { agent, path: String(b.path || '').slice(0, 120), ok: !r.error })
        return r.error ? { status: 403, body: r } : { status: 200, body: r }
      }
      if (path === '/__happy/data/sources' && method === 'POST') {
        return { status: 200, body: { sources: dataBus.listSources(), stats: { ...dataBus.stats(), scanning: dataBus.scanning }, allowed: dataBus.allowedFor(agent).map((l) => LEVEL_LABEL[l]) } }
      }
      if (path === '/__happy/data/weekly' && method === 'POST') {
        // 台账周报：只回聚合统计，不含明细路径（防 agent 侦察其他 agent 行为）
        const r = dataBus.weeklyReport(Number(b.days) || 7)
        audit('data-weekly', { agent })
        return { status: 200, body: { days: r.days, agents: r.agents, alerts: r.alerts } }
      }
      if (path === '/__happy/data/timeline' && method === 'POST') {        const tl = dataBus.timeline({ days: b.days, q: b.q, agent, limit: b.limit })
        audit('data-timeline', { agent, days: b.days || 7, hits: tl.total })
        return { status: 200, body: tl }
      }
      if (path === '/__happy/data/ziplist' && method === 'POST') {
        const r = dataBus.zipList(String(b.path || ''), { agent, limit: b.limit })
        audit('data-ziplist', { agent, path: String(b.path || '').slice(0, 120), ok: !r.error })
        return r.error ? { status: 403, body: r } : { status: 200, body: r }
      }
      // 🔴 sources/add 不对手机端开放（方案 §5：防"批准一次授权=开放全盘"）——只在电脑端管理
      if (path === '/__happy/data/sources/add' || path === '/__happy/data/sources/remove') {
        return { status: 403, body: { error: '监控目录只能在电脑端（浏览器资源管理器或 /happy data）管理' } }
      }
      if (path === '/__happy/data/setlevel' && method === 'POST') {
        // agent 复核通道：只允许对索引内文件定级（仲裁员，非阅读员）
        const ok = dataBus.setLevel(String(b.path || ''), String(b.level || ''))
        audit('data-setlevel', { agent, path: String(b.path || '').slice(0, 120), level: b.level, ok })
        return ok ? { status: 200, body: { ok: true } } : { status: 400, body: { error: '文件不在索引中或级别无效' } }
      }
      if (path === '/__happy/data/uncertain' && method === 'POST') {
        return { status: 200, body: dataBus.uncertain(Number(b.limit) || 20, Number(b.offset) || 0) }
      }
      return { status: 404, body: { error: 'unknown data path' } }
    }
    return null
  }

  const onInternalRequest = async (path, method, body) => {
    // V4.4 工具端点（文件/剪贴板/截图）优先
    if (path.startsWith('/__happy/files/') || path.startsWith('/__happy/file/') ||
        path.startsWith('/__happy/clipboard/') || path === '/__happy/screenshot' ||
        path === '/__happy/windows/list' || path === '/__happy/live/frame' || path === '/__happy/click' ||
        path.startsWith('/__happy/data/')) {
      return onToolRequest(path, method, body)
    }
    if (path === '/__happy/remote-link/approve' && method === 'POST') {
      try {
        const b = JSON.parse(body.toString('utf8') || '{}')
        if (!b.id || !b.from) return { status: 400, body: { error: 'id/from required' } }
        const ack = await tunnel.sendLinkApprove(b.id, b.from, b.mode)
        log(`远程登录授权（id=${b.id} from=${b.from} mode=${b.mode || 'legacy'}）→ ${ack.ok ? '已批准' : '拒绝: ' + (ack.error ?? '')}`)
        return { status: ack.ok ? 200 : 400, body: { ok: !!ack.ok, error: ack.error } }
      } catch (e) {
        return { status: 502, body: { ok: false, error: e.message } }
      }
    }
    if (path === '/__happy/remote-login/approve' && method === 'POST') {
      // V4.1 浏览器模式：批准后云端开桥接，浏览器直接用（新电脑无需装任何东西）
      try {
        const b = JSON.parse(body.toString('utf8') || '{}')
        if (!b.id) return { status: 400, body: { error: 'id required' } }
        const ack = await tunnel.sendWebLoginApprove(b.id, b.mode)
        log(`网页登录授权（id=${b.id} mode=${b.mode || 'legacy'}）→ ${ack.ok ? '已批准（桥接已开）' : '拒绝: ' + (ack.error ?? '')}`)
        return { status: ack.ok ? 200 : 400, body: { ok: !!ack.ok, error: ack.error } }
      } catch (e) {
        return { status: 502, body: { ok: false, error: e.message } }
      }
    }
    return { status: 404, body: { error: 'unknown internal path' } }
  }

  const boot = async () => {
    await identity.loadOrCreate()
    await identity.ensureRegistered()
    // 上报显示名（每次启动都报：改名/升级版本后云端即时更新，手机端刷新可见）
    identity.api('POST', '/api/v1/rename', { name: deviceName }).catch((e) => log('设备名上报失败: ' + e.message))
    log(`设备身份就绪: ${identity.deviceId}（${deviceName}）`)
    tunnel = new TunnelClient({
      relayUrl,
      identity,
      deps: { getOrigin, mintCookie, targets, log, onInternalRequest, onConnEvent: (e) => history.record(historyFile, e) }
    })
    tunnel.start()
  }
  boot().catch((e) => log('启动失败（将随下次重载重试）:', e.message))

  // ---- V4 远程登录：授权轮询 → 起链路（手机角色）+ 本地代理 ----
  const REMOTE_PORT = 9630
  let remoteLink = null       // { client, proxy, timer }
  const stopRemoteLink = () => {
    if (!remoteLink) return
    clearInterval(remoteLink.pollTimer)
    try { remoteLink.client.ws?.close() } catch (e) { /* 忽略 */ }
    try { remoteLink.proxy?.server.close() } catch (e) { /* 忽略 */ }
    remoteLink = null
    log('远程登录链路已断开')
  }
  const startRemoteLinkPoller = (linkId) => {
    stopRemoteLink()
    const state = { pollTimer: null }
    remoteLink = state
    state.pollTimer = setInterval(async () => {
      try {
        const st = await identity.linkStatus(linkId)
        if (st.status !== 'granted' || !st.credential) return
        clearInterval(state.pollTimer)
        const client = new RemoteLinkClient({
          relayUrl,
          identity,
          pcPub: st.pc.publicKey,
          log
        })
        client.setCredential(st.credential)
        state.client = client
        client.onReady = async () => {
          state.proxy = await startLocalProxy(client, REMOTE_PORT, log)
          log('远程登录就绪: ' + state.proxy.url)
          try { openInBrowser(state.proxy.url) } catch (e) { log('打开浏览器失败: ' + e.message) }
        }
        client.onDown = () => stopRemoteLink()
        client.start()
        log(`远程登录已授权（对端 ${st.pc.deviceId}），正在连接…`)
      } catch (e) {
        // 轮询失败（过期/网络）静默，下轮再看；连续失败到过期自然终止
      }
    }, 3000)
    setTimeout(() => { if (remoteLink === state && !state.client) { clearInterval(state.pollTimer); remoteLink = null } }, 6 * 60 * 1000)
  }

  ctx.effect(() => () => {
    try { tunnel?.stop() } catch (e) { /* 忽略 */ }
    try { stopRemoteLink() } catch (e) { /* 忽略 */ }
  }, 'happy-harness relay cleanup')
}
