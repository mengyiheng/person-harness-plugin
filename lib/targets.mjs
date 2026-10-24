// 通用壳 P1：targets registry + /t/<name>/ 路径路由（通用壳方案-V1.md §2）
// 四要素抽象 = origin / spawn / auth / 路径名：
//   - origin: 'origin:dsh'（动态取 webServer.getOrigin()）或任意 http:// 地址
//   - spawn:  P2 预留（ttyd 拉起），本阶段仅展示为"未启用"
//   - auth:   'cookie-self'（dsh 浏览器凭据 mintCookie）/ 'none'（只绑回环的服务，隧道是唯一入口）
// 纪律（方案 §5）：registry 加载容错——坏条目跳过并打日志，绝不影响 dsh 主目标；
// 非 /t/ 路径一律走 dsh（与旧版行为逐字节一致，P1 验收口径）。
const TARGET_PATH_RE = /^\/t\/([^/]+)(\/.*)?$/

export function createTargets ({ cfg = {}, getOrigin, mintCookie, log = () => {} }) {
  const raw = Array.isArray(cfg.targets) ? cfg.targets : null
  const items = []
  const seen = new Set()
  for (const t of (raw || [{ name: 'dsh', label: 'DeepSeek Harness', origin: 'origin:dsh', auth: 'cookie-self' }])) {
    try {
      const name = String(t.name || '').trim()
      if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error('name 非法（限 a-z0-9-，≤32）')
      if (seen.has(name)) throw new Error('name 重复')
      const origin = String(t.origin || '').trim()
      const hasSpawn = !!String(t.spawn || '').trim()
      if (!origin && !hasSpawn) throw new Error('origin/spawn 至少一项')
      if (origin && origin !== 'origin:dsh' && !/^https?:\/\//.test(origin)) throw new Error('origin 须为 http(s):// 或 origin:dsh')
      const auth = String(t.auth || 'none')
      if (!['cookie-self', 'none'].includes(auth)) throw new Error('auth 仅支持 cookie-self / none')
      seen.add(name)
      items.push({
        name,
        label: String(t.label || name).slice(0, 60),
        originSpec: origin || null,
        spawn: String(t.spawn || '').trim() || null,
        auth
      })
    } catch (e) {
      log(`targets registry：跳过坏条目 ${JSON.stringify(t).slice(0, 80)} — ${e.message}`)
    }
  }
  // dsh 主目标兜底：配置写坏也不许"手机连不上 dsh"
  if (!items.some((t) => t.name === 'dsh' && t.originSpec === 'origin:dsh')) {
    items.unshift({ name: 'dsh', label: 'DeepSeek Harness', originSpec: 'origin:dsh', spawn: null, auth: 'cookie-self' })
  }

  const originOf = (t) => t.originSpec === 'origin:dsh' ? getOrigin() : t.originSpec

  return {
    list () {
      return items.map((t) => ({
        name: t.name,
        label: t.label,
        ready: !!t.originSpec, // spawn-only（P2 ttyd 未实现）→ 未启用置灰
        note: t.originSpec ? '' : '终端目标将在 P2（ttyd）启用'
      }))
    },
    /** path → null（非 /t/，走 dsh 旧路径）/ {kind:'index'} / {kind:'target', target, rest} */
    resolve (path) {
      const p = String(path || '')
      if (p === '/t' || p === '/t/' || p === '/t/?' ) return { kind: 'index' }
      const m = TARGET_PATH_RE.exec(p)
      if (!m) return null
      const target = items.find((t) => t.name === m[1])
      if (!target) return { kind: 'miss' }
      return { kind: 'target', target, rest: m[2] || '/' }
    },
    /** 取目标请求 origin（http 或按 need 换 ws） */
    originOf,
    /** 目标请求鉴权头；cookie-self → 现铸 dsh v1 Cookie；none → 不带 */
    async authHeadersOf (t) {
      if (t.auth !== 'cookie-self') return {}
      return { Cookie: await mintCookie() }
    }
  }
}

/** 目标选择页（极简列表，复用 HOMEPAGE 风格的深色手机友好版） */
export function indexHtml (list) {
  const cards = list.map((t) => `
    <a class="card${t.ready ? '' : ' off'}" href="/t/${t.name}/">
      <div class="row"><span class="name">${escapeHtml(t.label)}</span><span class="chev">›</span></div>
      <div class="sub">/t/${t.name}/${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
    </a>`).join('')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>选择目标</title><style>
  body{margin:0;background:#0F1115;color:#EDEFF3;font:15px/1.5 -apple-system,'HarmonyOS Sans',system-ui,sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 16px}
  h1{font-size:18px;margin:8px 4px 14px}
  .card{display:block;background:#171A21;border:1px solid #232833;border-radius:14px;padding:14px 16px;margin:10px 0;text-decoration:none;color:inherit}
  .card.off{opacity:.45}
  .row{display:flex;justify-content:space-between;align-items:center}
  .name{font-weight:600}
  .chev{color:#5B6472;font-size:18px}
  .sub{color:#8A93A3;font-size:12px;margin-top:2px}
</style></head><body>
<h1>🖥️ 打开哪个目标</h1>
${cards}
</body></html>`
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
