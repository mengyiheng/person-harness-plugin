// 通用壳 P1+P2-lite：targets registry + /t/<name>/ 路径路由 + spawn 托管（通用壳方案-V1.md §2）
// 四要素抽象 = origin / spawn / auth / 路径名：
//   - origin: 'origin:dsh'（动态取 webServer.getOrigin()）或任意 http:// 地址
//   - spawn:  P2-lite——按需拉起本地服务（首次进入 /t/<name>/ 时启动），探活通过才放行；
//             origin 可省略，省略时从 spawn 命令的 --port N 推导 http://127.0.0.1:N
//   - auth:   'cookie-self'（dsh 浏览器凭据 mintCookie）/ 'none'（只绑回环的服务，隧道是唯一入口）
// 纪律（方案 §5）：registry 加载容错——坏条目跳过并打日志，绝不影响 dsh 主目标；
// 非 /t/ 路径一律走 dsh（与旧版行为逐字节一致，P1 验收口径）。
import { spawn as cpSpawn, execSync } from 'node:child_process'

const TARGET_PATH_RE = /^\/t\/([^/]+)(\/.*)?$/

/** 探活：origin 可达即健康（2xx/3xx/4xx 都算活着，只拒连不上） */
async function probeOrigin (origin, timeoutMs = 3000) {
  try {
    await fetch(origin + '/', { signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch { return false }
}

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
      const spawnCmd = String(t.spawn || '').trim()
      if (!origin && !spawnCmd) throw new Error('origin/spawn 至少一项')
      if (origin && origin !== 'origin:dsh' && !/^https?:\/\//.test(origin)) throw new Error('origin 须为 http(s):// 或 origin:dsh')
      // spawn 目标：origin 省略时从 --port / -p 推导（只绑回环，隧道是唯一入口）
      let derivedOrigin = null
      if (spawnCmd && !origin) {
        const m = /(?:^|\s)(?:--port|-p)[ =](\d{2,5})(?!\d)/.exec(spawnCmd)
        if (!m) throw new Error('spawn 目标省略 origin 时命令须含 --port 或 -p')
        derivedOrigin = `http://127.0.0.1:${m[1]}`
      }
      const auth = String(t.auth || 'none')
      if (!['cookie-self', 'none'].includes(auth)) throw new Error('auth 仅支持 cookie-self / none')
      seen.add(name)
      items.push({
        name,
        label: String(t.label || name).slice(0, 60),
        originSpec: origin || null,
        derivedOrigin,
        spawn: spawnCmd || null,
        auth
      })
    } catch (e) {
      log(`targets registry：跳过坏条目 ${JSON.stringify(t).slice(0, 80)} — ${e.message}`)
    }
  }
  // dsh 主目标兜底：配置写坏也不许"手机连不上 dsh"
  if (!items.some((t) => t.name === 'dsh' && t.originSpec === 'origin:dsh')) {
    items.unshift({ name: 'dsh', label: 'DeepSeek Harness', originSpec: 'origin:dsh', derivedOrigin: null, spawn: null, auth: 'cookie-self' })
  }

  // ---- spawn 托管运行时状态（P2-lite）----
  const rt = new Map() // name → { proc, starting, ready, err, at }
  const exitHandler = () => stopAll()
  process.once('exit', exitHandler)

  async function ensure (t, { timeoutMs = 30000 } = {}) {
    if (!t.spawn) return { ok: true }
    const origin = originOf(t)
    const st = rt.get(t.name) || { proc: null, starting: null, ready: false, err: '', at: 0 }
    rt.set(t.name, st)
    // 已在启动中：并队等待
    if (st.starting) return st.starting
    st.starting = (async () => {
      // ① 探活：外部已跑着同端口服务 → 直接收编（免重复拉起）
      if (await probeOrigin(origin)) { st.ready = true; st.err = ''; st.at = Date.now(); return { ok: true } }
      // ② 拉起子进程（shell 解析命令行；Windows 下 .cmd/.exe 全路径由配置保证）
      log(`targets spawn：拉起 ${t.name} → ${t.spawn}`)
      let proc = null
      try {
        proc = cpSpawn(t.spawn, { shell: true, stdio: 'ignore', windowsHide: true })
      } catch (e) {
        st.ready = false; st.err = 'spawn 失败: ' + e.message
        return { ok: false, err: st.err }
      }
      st.proc = proc
      proc.once('exit', (code) => {
        st.ready = false
        st.proc = null
        if (code != null && code !== 0) st.err = `进程退出 code=${code}`
        log(`targets spawn：${t.name} 进程退出（code=${code}）`)
      })
      // ③ 轮询探活至超时
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 600))
        if (await probeOrigin(origin)) {
          st.ready = true; st.err = ''; st.at = Date.now()
          log(`targets spawn：${t.name} 已就绪（${origin}）`)
          return { ok: true }
        }
        if (st.proc == null) break // 启动即崩
      }
      st.ready = false
      st.err = st.proc == null ? ('启动失败：' + (st.err || '进程立即退出')) : `探活超时（${timeoutMs}ms）`
      log(`targets spawn：${t.name} ${st.err}`)
      return { ok: false, err: st.err }
    })()
    try { return await st.starting } finally { st.starting = null }
  }

  async function ensureAll () {
    await Promise.all(items.filter((t) => t.spawn).map((t) => ensure(t).catch(() => null)))
  }

  // 🔴 按端口杀监听进程（Windows）：zcode 等目标会把真正的 server 进程脱离进程树拉起，
  //    taskkill /T 够不着 → 通过 netstat 找 LISTENING 的 PID 直接杀（比树杀更终极）。
  function killPortPids (port) {
    try {
      const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8', windowsHide: true })
      const pids = new Set()
      for (const line of String(out).split('\n')) {
        const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
        if (m && Number(m[1]) === port) pids.add(m[2])
      }
      for (const pid of pids) {
        try { cpSpawn(`taskkill /pid ${pid} /T /F`, { shell: true, stdio: 'ignore', windowsHide: true }) } catch { /* best effort */ }
      }
      return pids.size
    } catch { return 0 }
  }

  async function stopAll () {
    for (const t of items) {
      const st = rt.get(t.name)
      if (st?.proc) {
        // 🔴 Windows：shell:true 包了一层 cmd.exe，proc.kill() 只杀壳会留孤儿服务进程 → 必须树杀
        try {
          if (process.platform === 'win32') cpSpawn(`taskkill /pid ${st.proc.pid} /T /F`, { shell: true, stdio: 'ignore', windowsHide: true })
          else st.proc.kill()
        } catch { /* best effort */ }
        st.proc = null; st.ready = false
      }
      // 兜底：按端口清残留监听（树杀对脱离进程树的 server 无效）
      const origin = t.originSpec === 'origin:dsh' ? null : (t.originSpec || t.derivedOrigin)
      const pm = origin && /:(\d+)$/.exec(origin)
      if (process.platform === 'win32' && pm) killPortPids(Number(pm[1]))
    }
    // netstat/taskkill 异步生效，稍等确认
    await new Promise((r) => setTimeout(r, 500))
  }

  const originOf = (t) => t.originSpec === 'origin:dsh' ? getOrigin() : (t.originSpec || t.derivedOrigin)

  return {
    list () {
      return items.map((t) => {
        const st = t.spawn ? rt.get(t.name) : null
        const ready = t.spawn ? !!(st && st.ready) : !!t.originSpec
        return {
          name: t.name,
          label: t.label,
          ready,
          note: t.spawn ? (ready ? 'spawn 托管' : (st?.starting ? '启动中…' : '点击进入时自动启动')) : ''
        }
      })
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
    },
    /** P2-lite：spawn 托管——目标未就绪时按需拉起并探活 */
    ensure,
    ensureAll,
    stopAll,
    /** 单目标停止（/happy use <name> --tui 一键切回）：杀进程树 + 按端口兜底清残留 */
    async stopOne (name) {
      const t = items.find((x) => x.name === name)
      if (!t) return { ok: false, err: '未知目标: ' + name }
      const st = rt.get(name)
      if (st?.proc) {
        try {
          if (process.platform === 'win32') cpSpawn(`taskkill /pid ${st.proc.pid} /T /F`, { shell: true, stdio: 'ignore', windowsHide: true })
          else st.proc.kill()
        } catch { /* best effort */ }
        st.proc = null; st.ready = false
      }
      const origin = t.originSpec === 'origin:dsh' ? null : (t.originSpec || t.derivedOrigin)
      const pm = origin && /:(\d+)$/.exec(origin)
      if (process.platform === 'win32' && pm) killPortPids(Number(pm[1]))
      await new Promise((r) => setTimeout(r, 500))
      return { ok: true }
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
