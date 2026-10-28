// 数据总线（本地数据连接器）V1 —— 全量索引 + 分级 + 每-agent 访问策略
// 设计原则：
//   1. 所有资源都进索引（分级是标签，不是过滤器）；"谁能碰哪级"由策略层决定
//   2. 分类 99% 零 token：规则层（扩展名/路径/关键词）扫描时自动定级；
//      无规则命中者进"待复核队列"，agent 只做批量仲裁（紧凑卡片，不刷屏）
//   3. 索引永不出境；接口只返回查询命中 + 策略允许的级别
import { join, basename, extname, sep, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, watch, openSync, readSync, closeSync, fstatSync } from 'node:fs'

// ---- 分级体系（序即敏感度升序）----
export const LEVELS = ['public', 'internal', 'sensitive', 'restricted']
export const LEVEL_LABEL = { public: '公开', internal: '内部', sensitive: '敏感', restricted: '禁碰' }
const LV = Object.fromEntries(LEVELS.map((l, i) => [l, i]))

// ---- 内置规则（用户规则可覆盖；首个命中生效）----
// pat 匹配：路径片段（不区分大小写，/ 或 \ 通用）；ext 命中扩展名；kw 命中文件名关键词
const BUILTIN_RULES = [
  { pat: ['appdata', '$recycle.bin', 'system volume information', 'windows\\system32', 'node_modules', '.git'], level: 'restricted' },
  { kw: ['密码', '账号', 'password', 'secret', 'credential', 'wallet', 'keystore', '私钥', '备份'], level: 'sensitive' },
  { ext: ['.env', '.pem', '.key', '.pfx', '.p12', '.kdbx', '.crt', '.der'], level: 'sensitive' },
  { pat: ['证书', '发票', '合同', '身份证', '银行', '账单', '工资', 'invoice', 'tax'], level: 'sensitive' },
  { ext: ['.md', '.txt', '.log'], kw: ['readme', 'todo', 'notes'], level: 'internal' },
  { ext: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mp3'], level: 'internal' }
]

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '$recycle.bin', 'system volume information', 'appdata', '.tmp',
  // 全盘扫描护栏（2026-10-25）：系统/依赖/构建目录不索引——只贡献体积，没有检索价值
  'windows', 'program files', 'program files (x86)', 'programdata', 'perflogs',
  'msocache', 'recovery', 'intel', 'drivers', 'driverstore', 'winsxs',
  '$windows.~bt', '$windows.~ws', 'config.msi',
  '__pycache__', '.venv', 'venv', '.npm', '.cache', '.gradle', '.m2', '.conda',
  'site-packages', 'target', '.rustup', '.cargo', '.android', '.hvigor'
])
const HIDDEN = /^\./
const IGNORE_EXT = new Set(['.tmp', '.lock', '.lnk'])
const BIG_FILE = 100 * 1024 * 1024 // >100MB 只记元数据，不进内容检索

const norm = (p) => String(p || '').toLowerCase().replaceAll('/', '\\')

export class DataBus {
  constructor (dir) {
    this.dir = dir
    try { mkdirSync(dir, { recursive: true }) } catch (e) { /* 已存在/无权限 */ }
    this.indexFile = join(dir, 'data-bus.json')
    this.rulesFile = join(dir, 'data-class.json')
    this.policyFile = join(dir, 'data-policy.json')
    this.accessFile = join(dir, 'data-access.jsonl')
    this.accessLog = []
    this.recentWrites = new Map() // path → t：插件自己的写入（上传等），供扫描归因，避免误报"外部修改"
    // files: 相对紧凑键 —— s(ize) m(time) e(xt) lv(级) f(lag: b=big)
    this.state = { sources: [], files: {} }
    this.rules = []        // 用户规则 [{pat/kw/ext, level}]，优先于内置
    this.policy = {}       // { agents: { '*': ['public','internal'], 名字: [...] } }
    this.scanning = false
    this.load()
  }

  load () {
    try { if (existsSync(this.indexFile)) this.state = JSON.parse(readFileSync(this.indexFile, 'utf8')) } catch (e) { /* 重建 */ }
    try { if (existsSync(this.rulesFile)) this.rules = JSON.parse(readFileSync(this.rulesFile, 'utf8')) } catch (e) { this.rules = [] }
    try { if (existsSync(this.policyFile)) this.policy = JSON.parse(readFileSync(this.policyFile, 'utf8')) } catch (e) { this.policy = {} }
    if (!this.state.sources) this.state.sources = []
    if (!this.state.files) this.state.files = {}
    if (!this.policy.agents) this.policy.agents = { '*': ['public', 'internal'] }
    if (!Array.isArray(this.policy.dirs)) this.policy.dirs = []
    this._loadedMt = this._mtOf(this.indexFile)
  }

  _mtOf (p) { try { return statSync(p).mtimeMs } catch (e) { return 0 } }

  // 多进程共享：插件与 MCP 子进程各自持有 DataBus，调用前同步磁盘上的最新索引/策略
  syncFromDisk () {
    try {
      if (this._mtOf(this.indexFile) !== this._loadedMt) {
        this.state = JSON.parse(readFileSync(this.indexFile, 'utf8'))
        if (!this.state.sources) this.state.sources = []
        if (!this.state.files) this.state.files = {}
        this._sc = null // 其他进程写入的新索引不能继续命中本进程旧缓存
        this._loadedMt = this._mtOf(this.indexFile)
      }
      try { this.policy = JSON.parse(readFileSync(this.policyFile, 'utf8')) } catch (e) { /* 用内存版 */ }
      if (!this.policy.agents) this.policy.agents = { '*': ['public', 'internal'] }
      if (!Array.isArray(this.policy.dirs)) this.policy.dirs = []
    } catch (e) { /* 索引尚未生成，用现状 */ }
  }

  save () {
    try { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.indexFile, JSON.stringify(this.state)); writeFileSync(this.rulesFile, JSON.stringify(this.rules, null, 2)); writeFileSync(this.policyFile, JSON.stringify(this.policy, null, 2)) } catch (e) { /* 忽略 */ }
  }

  // ---- 分级：用户规则 > 内置规则 > 默认 internal；返回 {level, from} ----
  classify (path) {
    const p = norm(path)
    const name = norm(basename(path))
    // 🔴 extname('.env') 在 Node 返回空（前导点不算扩展名）——点文件（.env/.gitconfig）恰恰是敏感高发区
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 ? name.slice(dot) : (dot === 0 ? name : '') // '.env' 整名即扩展名
    for (const r of [...this.rules, ...BUILTIN_RULES]) {
      if (r.pat && r.pat.some((x) => p.includes(norm(x)))) return { level: r.level, from: 'rule' }
      if (r.ext && r.ext.includes(ext)) return { level: r.level, from: 'rule' }
      if (r.kw && r.kw.some((x) => name.includes(norm(x)))) return { level: r.level, from: 'rule' }
    }
    return { level: 'internal', from: 'default' } // default=待复核候选
  }

  // 手工定级（agent 仲裁 / 用户指定），记为 manual —— 不再被规则覆盖
  // persist=true 时写 sidecar（<文件>.hhmeta），分级跟文件走（重装/换机后扫描仍能恢复）
  setLevel (path, level, persist = false) {
    if (!LV.hasOwnProperty(level)) return false
    const f = this.state.files[path]
    if (!f) return false
    f.lv = level
    f.a = 1 // manual 标记：扫描时不被规则覆盖
    this._sc = null // 分级变更立即可检索，不能沿用旧缓存
    if (persist) {
      try { writeFileSync(path + '.hhmeta', JSON.stringify({ level, at: Date.now() })) } catch (e) { /* 只读盘等：索引内仍生效 */ }
    }
    return true
  }

  // sidecar 读取：扫描时恢复随文件走的分级
  sidecarLevel (path) {
    try {
      if (!existsSync(path + '.hhmeta')) return null
      const j = JSON.parse(readFileSync(path + '.hhmeta', 'utf8'))
      return LV.hasOwnProperty(j.level) ? j.level : null
    } catch (e) { return null }
  }

  // ---- 数据源管理 ----
  listSources () {
    // 全盘量级（78万文件实测）不能每次遍历 files 计数——用扫描时缓存的 src.n
    return this.state.sources.map((s) => ({
      path: s.path,
      files: s.n ?? Object.keys(this.state.files).filter((p) => norm(p).startsWith(norm(s.path) + sep)).length,
      lastScan: s.lastScan ? new Date(s.lastScan).toLocaleString('zh-CN') : '未扫描'
    }))
  }

  addSource (path) {
    const p = String(path || '').trim()
    let st
    try { st = statSync(p) } catch (e) { throw new Error('路径不存在: ' + p) }
    if (!st.isDirectory()) throw new Error('必须是文件夹: ' + p)
    if (this.state.sources.some((s) => norm(s.path) === norm(p))) return false
    this.state.sources.push({ path: p, lastScan: 0 })
    this.save()
    return true
  }

  removeSource (path) {
    const before = this.state.sources.length
    this.state.sources = this.state.sources.filter((s) => norm(s.path) !== norm(path))
    const pre = norm(path) + sep
    for (const p of Object.keys(this.state.files)) if (norm(p).startsWith(pre)) delete this.state.files[p]
    this._sc = null
    if (this.state.sources.length !== before) this.save()
    return this.state.sources.length !== before
  }

  defaultSources () {
    const home = homedir()
    for (const n of ['Desktop', 'Documents', 'Downloads']) {
      const p = join(home, n)
      try { if (existsSync(p)) this.addSource(p) } catch (e) { /* 忽略 */ }
    }
    // 手机上传收件箱：agent 上传的文件从落地起就在索引与台账里
    try { this.addSource(join(home, 'Downloads', '来自手机')) } catch (e) { /* 首次上传时 addSource 会补 */ }
  }

  /** 全盘升级（2026-10-25）：把所有固定盘符加为数据源。
   *  系统目录由 IGNORE_DIRS 护栏排除（windows/program files/依赖缓存/构建产物），
   *  覆盖目标 = 用户数据区（各盘根下的非系统目录）。返回新增源列表。 */
  upgradeAllDrives () {
    const added = []
    if (process.platform !== 'win32') {
      try { this.addSource('/'); added.push('/') } catch (e) { /* 已存在 */ }
      return added
    }
    for (let i = 67; i <= 90; i++) { // C: ~ Z:
      const root = String.fromCharCode(i) + ':\\'
      try {
        if (!statSync(root).isDirectory()) continue
        const before = this.state.sources.length
        this.addSource(root)
        if (this.state.sources.length > before) added.push(root)
      } catch (e) { /* 盘符不存在/不可访问 */ }
    }
    return added
  }

  // ---- 增量扫描（让路式：每 N 个文件让出事件循环；目录忽略规则内置）----
  async scan (opts = {}) {
    if (this.scanning) return { skipped: true }
    this.scanning = true
    const perYield = opts.perYield || 200
    let scanned = 0, changed = 0
    let processed = 0 // 全部条目计数（2026-10-26）：yield 挂在变更计数上时，warm 扫描
    // （81 万文件、变更≈0）全程零让出 → 事件循环被堵死 40~90s，dsh 所有请求/聊天全冻结。
    // 改为每处理 200 个条目（含"未变跳过"）就让出一次。
    try {
      // opts.paths（watch 增量专用）：只扫这些子树，跳过修剪——删除/移出靠 10min 全量兜底
      const normRoot = (p) => norm(p).replace(/[\\/]+$/, '').toLowerCase()
      const under = (p, root) => p === root || p.startsWith(root + sep) || p.startsWith(root + '/')
      for (const src of this.state.sources) {
        const srcRoot = norm(src.path)
        let subTrees = null
        if (Array.isArray(opts.paths)) {
          subTrees = []
          for (const p of opts.paths) {
            const np = norm(p)
            if (under(np.toLowerCase(), normRoot(src.path))) subTrees.push(np)
          }
          if (!subTrees.length) continue // 变更不在本源内
        }
        const isMini = !!subTrees
        const stack = subTrees ? subTrees.slice() : [src.path]
        const seen = new Set() // 本源本轮见到的文件（修剪用；替代全量 statSync 的 prune——20 万文件级不能全量探活）
        while (stack.length) {
          const dir = stack.pop()
          let entries
          try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
          for (const ent of entries) {
            if (++processed % perYield === 0) await new Promise((r) => setImmediate(r))
            if (ent.name.startsWith('~$')) continue
            if (ent.isDirectory()) {
              if (IGNORE_DIRS.has(ent.name.toLowerCase()) || HIDDEN.test(ent.name)) continue
              stack.push(join(dir, ent.name))
              continue
            }
            if (!ent.isFile()) continue // 隐藏文件也进索引（.env 等恰是敏感高发区，由规则定级）
            const ext = extname(ent.name).toLowerCase()
            if (IGNORE_EXT.has(ext)) continue
            const full = join(dir, ent.name)
            seen.add(norm(full))
            let st
            try { st = statSync(full) } catch (e) { continue }
            const prev = this.state.files[full]
            if (prev && prev.mt === st.mtimeMs && prev.s === st.size) continue // 未变，跳过
            // 归因：已索引文件发生变化，但插件 5 分钟内没有写入登记 → 有程序绕过插件修改了它
            const wroteByUs = (this.recentWrites.get(norm(full)) || 0) > Date.now() - 300000
            if (prev && !wroteByUs) this.recordAccess('system', 'external-modify', full, true)
            const c = prev && prev.a
              ? { level: prev.lv, from: 'manual' }
              : (() => {
                  const sc = this.sidecarLevel(full) // B 方向：sidecar 分级跟文件走（优先于规则）
                  return sc ? { level: sc, from: 'sidecar' } : this.classify(full)
                })()
            this.state.files[full] = {
              s: st.size, mt: st.mtimeMs, e: ext.slice(1), lv: c.level,
              ...(st.size > BIG_FILE ? { b: 1 } : {}),
              ...(c.from === 'manual' ? { a: 1 } : {})
            }
            changed++
            scanned++
          }
        }
        if (!isMini) {
          src.lastScan = Date.now()
          src.n = seen.size // 缓存本源文件数（listSources 免遍历）
          // 本源内修剪：本轮没见到的 = 已删除/移出（只动本源前缀下的键，其他源不碰；
          // 替代全量 statSync 的 prune——全盘量级（十万+）不能每轮全量探活）
          const pre = norm(src.path) + sep
          let pk = 0
          for (const p of Object.keys(this.state.files)) {
            if (++pk % 20000 === 0) await new Promise((r) => setImmediate(r))
            if (p.toLowerCase().startsWith(pre) && !seen.has(norm(p))) delete this.state.files[p]
          }
        }
      }
      // 🔴 全盘量级（120MB 索引）落盘节流：watch 触发的高频小扫描不再每次全量重写——
      //    变更 <50 条且 60s 内已写过 → 跳过（下轮定时扫描会补写）；大变更立即写
      const now = Date.now()
      if (changed >= 50 || !this._lastSaveAt || now - this._lastSaveAt > 60_000) {
        this.save()
        this._lastSaveAt = now
      }
      this._sc = null // 扫描后的新增、删除、分级变化立即可见
      return { scanned, changed, total: Object.keys(this.state.files).length }
    } finally {
      this.scanning = false
    }
  }

  prune () {
    for (const p of Object.keys(this.state.files)) {
      try { statSync(p) } catch (e) { delete this.state.files[p] }
    }
    this._sc = null
  }

  // ---- 策略：agent 允许的级别集合（支持目录继承：最长匹配路径的目录规则优先）----
  allowedFor (agent, path = null) {
    const a = this.policy.agents
    const fallback = () => {
      if (agent && a[agent]) return a[agent]
      if (agent) {
        // 前缀/别名匹配：如 "claude-code" 命中 "claude"
        for (const k of Object.keys(a)) if (k !== '*' && agent.toLowerCase().includes(k.toLowerCase())) return a[k]
      }
      return a['*'] || ['public', 'internal']
    }
    if (!path || !this.policy.dirs?.length) return fallback()
    const np = norm(path)
    const ag = agent || '*'
    let best = null
    for (const r of this.policy.dirs) {
      // 未声明 agent 按 '*' 语义；声明的按精确/别名匹配
      if (r.agent !== '*' && r.agent !== ag && !(agent && ag.toLowerCase().includes(r.agent.toLowerCase()))) continue
      const rp = norm(r.path).replace(/[\\/]+$/, '')
      if (np.startsWith(rp + '\\') || np.startsWith(rp + '/')) {
        if (!best || rp.length > norm(best.path).length) best = r
      }
    }
    return best ? best.levels : fallback()
  }

  // 目录级策略：某目录下某 agent 的级别覆盖（继承给全部子孙文件）
  setDirPolicy (path, agent, levels) {
    const ok = Array.isArray(levels) && levels.every((l) => LV.hasOwnProperty(l))
    if (!ok) throw new Error('levels 必须是 ' + LEVELS.join('/'))
    const p = String(path || '').trim()
    if (!p) throw new Error('path 必填')
    this.policy.dirs = (this.policy.dirs || []).filter((r) => !(norm(r.path) === norm(p) && r.agent === (agent || '*')))
    this.policy.dirs.push({ path: p, agent: agent || '*', levels: [...new Set(levels)] })
    this.save()
  }

  removeDirPolicy (path, agent) {
    const before = this.policy.dirs.length
    this.policy.dirs = this.policy.dirs.filter((r) => !(norm(r.path) === norm(path) && r.agent === (agent || '*')))
    if (this.policy.dirs.length !== before) this.save()
    return this.policy.dirs.length !== before
  }

  setPolicy (agent, levels) {
    const ok = Array.isArray(levels) && levels.every((l) => LV.hasOwnProperty(l))
    if (!ok) throw new Error('levels 必须是 ' + LEVELS.join('/'))
    this.policy.agents[agent || '*'] = [...new Set(levels)]
    this.save()
  }

  // ---- 检索语法（Everything 式，与 opts 可混用，opts 优先）----
  // 支持：ext:png,pdf  days:7  size:>10mb / size:<100kb  path:文档  其余 token=文件名关键词
  static parseQuery (q, opts = {}) {
    const out = { terms: [], ext: [...(opts.ext || [])], days: opts.days || 0, minSize: 0, maxSize: Infinity, paths: [], limit: opts.limit || 10 }
    for (const tok of String(q || '').trim().split(/\s+/).filter(Boolean)) {
      const m = tok.match(/^(ext|days|size|path):(.+)$/i)
      if (!m) { out.terms.push(norm(tok)); continue }
      const key = m[1].toLowerCase(); const val = m[2]
      if (key === 'ext') out.ext.push(...val.split(',').map((x) => x.toLowerCase().replace(/^\./, '')).filter(Boolean))
      else if (key === 'days') out.days = Number(val) || 0
      else if (key === 'path') out.paths.push(norm(val))
      else if (key === 'size') {
        const sm = val.match(/^(>|<)?\s*([\d.]+)\s*(kb|mb|gb)?$/i)
        if (sm) {
          const bytes = Math.round(parseFloat(sm[2]) * ({ kb: 1024, mb: 1048576, gb: 1073741824 }[(sm[3] || '').toLowerCase()] || 1))
          if ((sm[1] || '>') === '>') out.minSize = bytes; else out.maxSize = bytes
        }
      }
    }
    return out
  }

  // ---- 检索缓存：预排序（mtime desc）+ 预规范化路径 ----
  // 🔴 2026-10-25：原实现每次 search 对 78 万条目 Object.entries + 逐条 norm()，同步堵死插件事件循环
  //   （WebOS 联邦检索"卡死"的病根）。缓存 60s TTL，检索变早停扫描——常用查询通常 <50ms。
  searchCache () {
    if (this._sc && Date.now() - this._scAt < 60_000) return this._sc
    const arr = []
    for (const [path, f] of Object.entries(this.state.files || {})) {
      arr.push({ path, name: basename(path), np: norm(path), e: f.e, s: f.s, mt: f.mt, lv: f.lv })
    }
    arr.sort((a, b) => b.mt - a.mt)
    this._sc = arr
    this._scAt = Date.now()
    return arr
  }

  // ---- 检索（只返回命中 + 策略内级别）----
  search (q, opts = {}) {
    const allow = new Set(this.allowedFor(opts.agent))
    const hasDirs = (this.policy.dirs?.length || 0) > 0
    const p = DataBus.parseQuery(q, opts)
    const since = p.days ? Date.now() - p.days * 86400e3 : 0
    const limit = Math.min(Number(p.limit) || 10, 50)
    const t0 = Date.now()
    const hits = []
    const rows = this.searchCache()
    for (const f of rows) {
      if (Date.now() - t0 > 3000) break // 病理性查询兜底（磁盘级 path: 扫描），部分结果好过全堵
      const okLevel = hasDirs ? this.allowedFor(opts.agent, f.path).includes(f.lv) : allow.has(f.lv)
      if (!okLevel) continue
      if (p.ext.length && !p.ext.includes(f.e)) continue
      if (since && f.mt < since) continue
      if (f.s < p.minSize || f.s > p.maxSize) continue
      if (p.paths.length && !p.paths.some((x) => f.np.includes(x))) continue
      if (p.terms.length && !p.terms.every((t) => f.np.includes(t))) continue
      hits.push({ path: f.path, name: f.name, ext: f.e, size: f.s, mtime: f.mt, level: f.lv, big: !!f.b })
      if (hits.length >= limit * 4) break // 多收一些再按时间排
    }
    hits.sort((a, b) => b.mtime - a.mtime)
    // A 方向：recent=true 时按"最近使用信号"加权（Windows Recent 频次 ×2 + 7天内新近 +1）
    if (opts.recent) {
      const sig = this.recentSignals(opts.recentDir)
      const score = (f) => {
        const s = sig.get(f.name.replace(/\.[^.]+$/, '').toLowerCase())
        if (!s) return 0
        // 频次 ×2 + 信号新鲜度（90 天窗内快捷方式，7 天内打开过 +1）
        return Math.min(s.count, 10) * 2 + (Date.now() - s.last < 7 * 86400e3 ? 1 : 0)
      }
      hits.sort((a, b) => (score(b) - score(a)) || (b.mtime - a.mtime))
    }
    return hits.slice(0, limit)
  }

  // ---- 内容全文检索（M2：按需扫描式，不膨胀索引）----
  // 只查允许级别内的纯文本类小文件（≤1MB），子串匹配，返回命中行上下文（前后各1行，单文件最多3处）
  static TEXT_EXT = new Set(['txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'ini', 'conf', 'html', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'kt', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'sh', 'ps1', 'bat', 'sql', 'toml', 'env'])

  searchContent (q, opts = {}) {
    const allow = new Set(this.allowedFor(opts.agent))
    const p = DataBus.parseQuery(q, opts) // 复用语法解析：ext:/days:/path: 生效，其余 token 为正文关键词
    const limit = Math.min(Number(p.limit) || 5, 20)
    const needle = norm(p.terms.join(' '))
    if (!needle) return []
    const t0 = Date.now()
    const hits = []
    for (const [path, f] of Object.entries(this.state.files)) {
      if (Date.now() - t0 > 800) break // 内容检索要读文件，必须限时（避免堵事件循环）
      if (!allow.has(f.lv) || f.b) continue
      if (!DataBus.TEXT_EXT.has(f.e) && f.e) continue
      if (p.ext.length && !p.ext.includes(f.e)) continue
      if (p.days && f.mt < Date.now() - p.days * 86400e3) continue
      if (p.paths.length && !p.paths.some((x) => norm(path).includes(x))) continue
      if (f.s > 1024 * 1024) continue
      let text
      try { text = readFileSync(path, 'utf8') } catch (e) { continue }
      const lines = text.split(/\r?\n/)
      const normLines = lines.map((l) => norm(l))
      const found = []
      for (let i = 0; i < normLines.length && found.length < 3; i++) {
        if (normLines[i].includes(needle)) {
          found.push({ line: i + 1, context: lines.slice(Math.max(0, i - 1), i + 2).join('\n').slice(0, 300) })
          i += 0 // 同一行多次命中只记一次（循环自增）
        }
      }
      if (found.length) {
        hits.push({ path, name: basename(path), ext: f.e, size: f.s, mtime: f.mt, level: f.lv, hits: found })
        if (hits.length >= limit) break
      }
    }
    hits.sort((a, b) => b.mtime - a.mtime)
    return hits
  }

  // ---- 文件系统实时监听（增量扫描的实时性补丁；Linux 无 recursive，自动退化为纯定时）----
  // 2026-10-26 策略调整：watch 事件不再触发全盘走查（81 万文件 × 高频事件 = 磁盘常转），
  // 改为收集变更路径 → 3s 防抖后只扫变更子树（秒级、增量）；删除/移出靠 10min 全量兜底。
  startWatch (log = () => {}) {
    if (this.watchers || process.platform === 'linux') return
    this.watchers = []
    let timer = null
    let overflowTimer = null // watch 缓冲溢出全量兜底的防抖计时器
    const pending = new Set() // 待处理路径（原始大小写）
    const flush = () => {
      timer = null
      if (!pending.size) return
      const dirs = new Set() // 目录变更 → 子树扫描
      let touched = false    // 单文件变更 → 直接入索引，不走路
      for (const p of pending) {
        pending.delete(p)
        let st = null
        try { st = statSync(p) } catch { /* 已删除/移出：本轮不处理，全量扫描会修剪 */ }
        if (st && st.isDirectory()) dirs.add(p)
        else if (st && this._indexOne(p) === 'changed') touched = true
        else if (!st) {
          const d = dirname(p)
          try { if (existsSync(d)) dirs.add(d) } catch { /* 父目录也不在了，等全量修剪 */ }
        }
      }
      if (dirs.size) this.scan({ paths: [...dirs] }).catch(() => {})
      else if (touched) this._scheduleSave()
    }
    for (const src of this.state.sources) {
      const root = src.path
      const cb = (etype, filename) => {
        // 注意：pending 存原始大小写路径（norm 会小写化，混进索引键会与全量扫描的键不一致）
        pending.add(filename ? join(root, String(filename)) : root)
        if (!timer) timer = setTimeout(flush, 3000) // 3s 防抖合并事件风暴
      }
      try {
        const w = watch(root, { recursive: true }, cb)
        // Windows 事件风暴时 ReadDirectoryChangesW 缓冲溢出 → 'error' 事件且期间事件丢失
        // → 调度一次全量扫描兜底（10s 防抖，溢出持续时不反复扫）
        w.on('error', () => {
          if (overflowTimer) return
          log(`watch 缓冲溢出（${root}，事件丢失），10s 后全量扫描兜底`)
          overflowTimer = setTimeout(() => { overflowTimer = null; this.scan().catch(() => {}) }, 10000)
        })
        this.watchers.push(w)
      } catch (e) { /* 目录消失等，定时扫描兜底 */ }
    }
    if (this.watchers.length) log(`数据总线实时监听已开启（${this.watchers.length} 个数据源）`)
  }

  // ---- 快速修剪（2026-10-26）：只 stat 已索引路径，删失效、更新变更；不做目录遍历 ----
  // 新文件发现靠 watch 单文件快路径；本 pass 管删除清理 + watch 漏事件的元数据纠偏。
  // 全量递归走查降为每小时一次（index.js 调度）。实测 130 万路径 stat ≈ 32s（每 200 让出，不阻塞）。
  async pruneFast () {
    if (this.scanning) return { skipped: true }
    this.scanning = true
    let pruned = 0, changed = 0, processed = 0
    try {
      for (const p of Object.keys(this.state.files)) {
        if (++processed % 200 === 0) await new Promise((r) => setImmediate(r))
        const f = this.state.files[p]
        let st
        try { st = statSync(p) } catch { delete this.state.files[p]; pruned++; continue }
        if (!st.isFile()) { delete this.state.files[p]; pruned++; continue }
        if (f.mt !== st.mtimeMs || f.s !== st.size) {
          if (this._indexOne(p) === 'changed') changed++
        }
      }
      if (pruned || changed) {
        this._sc = null
        this._scheduleSave()
      }
      return { pruned, changed, total: Object.keys(this.state.files).length }
    } finally {
      this.scanning = false
    }
  }

  // ---- 单文件入索引（watch 事件快路径，2026-10-26）----
  // 事件里自带变更文件路径，没必要为单个文件改动走子树/全盘。返回 changed/same/gone。
  _indexOne (full) {
    let st
    try { st = statSync(full) } catch { return 'gone' }
    if (!st.isFile()) return 'gone'
    if (basename(full).startsWith('~$')) return 'same'
    const ext = extname(full).toLowerCase()
    if (IGNORE_EXT.has(ext)) return 'same'
    const prev = this.state.files[full]
    if (prev && prev.mt === st.mtimeMs && prev.s === st.size) return 'same'
    const wroteByUs = (this.recentWrites.get(norm(full)) || 0) > Date.now() - 300000
    if (prev && !wroteByUs) this.recordAccess('system', 'external-modify', full, true)
    const c = prev && prev.a
      ? { level: prev.lv, from: 'manual' }
      : (() => {
          const sc = this.sidecarLevel(full)
          return sc ? { level: sc, from: 'sidecar' } : this.classify(full)
        })()
    this.state.files[full] = {
      s: st.size, mt: st.mtimeMs, e: ext.slice(1), lv: c.level,
      ...(st.size > BIG_FILE ? { b: 1 } : {}),
      ...(c.from === 'manual' ? { a: 1 } : {})
    }
    this._sc = null
    return 'changed'
  }

  _scheduleSave () { // 单文件/小变更的延迟落盘（60s 合并），避免每事件重写 120MB 索引
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try { this.save(); this._lastSaveAt = Date.now() } catch { /* 下轮再补 */ }
    }, 60000)
  }

  stopWatch () {
    for (const w of this.watchers || []) { try { w.close() } catch (e) { /* 忽略 */ } }
    this.watchers = null
  }

  // ---- 访问台账（谁在何时对哪个文件做了什么；落盘 data-access.jsonl + 内存索引）----
  // ev: search/hit/read/download/preview/tree/mkdir/setlevel/upload/ferry-send/cleanup/external-modify；ok=false=被策略拒绝（试探信号）
  recordAccess (agent, ev, path, ok = true, extra = {}) {
    const t = Date.now()
    this._accessSeq = (this._accessSeq || 0) + 1
    // 同毫秒可能有多条真实访问；唯一 id 用于磁盘/内存合并去重，不能按时间+路径折叠。
    const entry = { t, id: `${t}-${process.pid}-${this._accessSeq}`, agent, ev, path, ok, ...extra }
    this.accessLog.push(entry)
    if (this.accessLog.length > 5000) this.accessLog.splice(0, 1000) // 内存封顶，历史在 JSONL
    try { writeFileSync(this.accessFile, JSON.stringify(entry) + '\n', { flag: 'a' }) } catch (e) { /* 留痕失败不阻塞主流程 */ }
  }

  // 🔴 2026-10-25 审计补全：报表从 JSONL 读全量历史（此前只读内存——dsh 重启即清零，落盘形同虚设）
  // 返回盘上历史 + 内存增量去重合并；新事件按唯一 id，旧事件沿用兼容键。
  allAccessEntries (sinceMs = 0) {
    const seen = new Set()
    const out = []
    const push = (a) => {
      if (!a || a.t < sinceMs) return
      const k = a.id || `${a.t}|${a.agent}|${a.ev}|${a.path}`
      if (seen.has(k)) return
      seen.add(k)
      out.push(a)
    }
    try {
      const text = readFileSync(this.accessFile, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { push(JSON.parse(line)) } catch (e) { /* 坏行跳过 */ }
      }
    } catch (e) { /* 文件不存在=还没有历史 */ }
    for (const a of this.accessLog) push(a)
    return out
  }

  // 插件侧写入登记（上传等）：5 分钟内的 mtime 变化归因于此，不算"外部修改"
  noteWrite (path) {
    this.recentWrites.set(norm(path), Date.now())
    if (this.recentWrites.size > 500) { const cut = Date.now() - 300000; for (const [k, t] of this.recentWrites) if (t < cut) this.recentWrites.delete(k) }
  }

  // 某文件被哪些 agent 访问过（2026-10-25 起读全量历史，含重启前）
  fileAccess (path) {
    const seen = new Map()
    for (const a of this.allAccessEntries()) {
      if (norm(a.path) !== norm(path)) continue
      const k = a.agent
      if (!seen.has(k)) seen.set(k, { agent: a.agent, count: 0, denied: 0, last: a.t, evs: new Set() })
      const s = seen.get(k); s.count++; if (!a.ok) s.denied++; s.last = a.t; s.evs.add(a.ev)
    }
    return [...seen.values()].map((s) => ({ ...s, evs: [...s.evs], last: new Date(s.last).toLocaleString('zh-CN') }))
  }

  // 最近访问流水
  recentAccess (limit = 30) {
    return this.accessLog.slice(-limit).reverse().map((a) => ({ ...a, time: new Date(a.t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }))
  }

  // ---- 危险行为提醒（规则层实时判定，零 token）----
  alerts () {
    const now = Date.now()
    const out = []
    // 🔴 2026-10-25：告警也读全量历史（近 24h 窗口），重启不清零
    const recent = this.allAccessEntries(now - 24 * 3600e3)
    const tail = recent.slice(-200)
    for (const a of tail) {
      if (!a.ok) { out.push({ level: 'warn', type: 'denied', time: a.t, msg: `agent「${a.agent}」尝试访问未授权内容被拒（${a.ev}）`, path: a.path }); continue }
      const f = this.state.files[a.path]
      if (f && f.lv === 'sensitive') out.push({ level: 'high', type: 'sensitive', time: a.t, msg: `敏感文件被${a.ev === 'read' || a.ev === 'download' || a.ev === 'preview' ? '读取' : '检索命中'}：${basename(a.path)}（agent「${a.agent}」）`, path: a.path })
    }
    // 高频读取（1 分钟 ≥10 次成功 read/download = 搬库嫌疑）
    const reads = recent.filter((a) => (a.ev === 'read' || a.ev === 'download') && a.ok && now - a.t < 60000)
    const byAgent = new Map()
    for (const r of reads) byAgent.set(r.agent, (byAgent.get(r.agent) || 0) + 1)
    for (const [ag, n] of byAgent) if (n >= 10) out.push({ level: 'high', type: 'bulk', time: now, msg: `agent「${ag}」1 分钟内连续取读 ${n} 个文件——疑似批量搬运，建议核查` })
    // 大范围检索（单次命中 ≥20 条）
    for (const a of tail) if (a.ev === 'search' && a.hits >= 20) out.push({ level: 'warn', type: 'broad', time: a.t, msg: `agent「${a.agent}」单次检索命中 ${a.hits} 条（大范围扫描）` })
    // 插件外修改（归因失败的文件变化——有程序绕过插件动了被监控的文件）
    for (const a of tail) if (a.ev === 'external-modify') out.push({ level: 'warn', type: 'external', time: a.t, msg: `文件在插件外被修改：${basename(a.path)}（可能是本机其他程序或未走插件的 agent）`, path: a.path })
    return out.sort((x, y) => y.time - x.time).slice(0, 50)
  }

  // ---- 读取（策略 + 64KB 上限）----
  read (path, opts = {}) {
    const f = this.state.files[path]
    if (!f) return { error: '不在索引中（须先加入数据源并扫描）' }
    if (!new Set(this.allowedFor(opts.agent, path)).has(f.lv)) return { error: `权限不足：该文件级别为「${LEVEL_LABEL[f.lv]}」，当前 agent 允许：${this.allowedFor(opts.agent).map((l) => LEVEL_LABEL[l]).join('/')}` }
    let st
    try { st = statSync(path) } catch (e) { return { error: '文件不存在' } }
    if (st.size > 64 * 1024) return { error: '超过 64KB 读取上限', size: st.size }
    return { content: readFileSync(path, 'utf8'), level: f.lv, size: st.size }
  }

  // ---- 待复核队列（规则未命中且未手工定级的文件；紧凑卡片，供 agent 批量仲裁）----
  uncertain (limit = 20, offset = 0) {
    // 🔴 2026-10-25：原实现把全部待复核文件 map 成对象只为取 total（几十万条 → GC 风暴，堵死事件循环）。
    // 改两趟：先只数数，再只映射当前页的 limit 条。
    let total = 0
    const items = []
    for (const [p, f] of Object.entries(this.state.files)) {
      if (f.lv !== 'internal' || f.a) continue
      total++
      if (total > offset && items.length < limit) {
        items.push({ id: p, name: basename(p), ext: f.e, kb: Math.max(1, Math.round(f.s / 1024)), dir: basename(p.split(sep).slice(0, -1).join(sep) || sep) })
      }
    }
    return { total, items }
  }

  // ---- 台账周报（B 方向：谁在本期碰了多少文件、危险行为趋势；2026-10-25 起读全量历史）----
  weeklyReport (days = 7) {
    const since = Date.now() - days * 86400e3
    const entries = this.allAccessEntries(since)
    const byAgent = new Map()
    const fileCount = new Map()
    for (const a of entries) {
      if (!byAgent.has(a.agent)) byAgent.set(a.agent, { agent: a.agent, hits: 0, reads: 0, searches: 0, downloads: 0, previews: 0, uploads: 0, denied: 0 })
      const s = byAgent.get(a.agent)
      if (a.ev === 'hit') s.hits++
      else if (a.ev === 'read') { s.reads++; if (a.ok) { fileCount.set(a.path, (fileCount.get(a.path) || 0) + 1) } }
      else if (a.ev === 'search') s.searches++
      else if (a.ev === 'download') s.downloads++
      else if (a.ev === 'preview') s.previews++
      else if (a.ev === 'upload') s.uploads++
      if (!a.ok) s.denied++
    }
    const alerts = this.alerts().filter((a) => (a.time || a.t || 0) >= since)
    return {
      days,
      agents: [...byAgent.values()].sort((x, y) => (y.hits + y.reads) - (x.hits + x.reads)),
      topFiles: [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, n]) => ({ path, name: basename(path), reads: n })),
      alerts: { total: alerts.length, high: alerts.filter((a) => a.level === 'high').length, warn: alerts.filter((a) => a.level === 'warn').length }
    }
  }

  stats () {
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0]))
    for (const f of Object.values(this.state.files)) byLevel[f.lv] = (byLevel[f.lv] || 0) + 1
    return { sources: this.state.sources.length, total: Object.keys(this.state.files).length, byLevel, lastScan: this.state.sources.map((s) => s.lastScan).filter(Boolean).sort().pop() || null }
  }

  // 监测台专用快照：一次遍历汇总索引与待复核，避免大索引上重复全量扫描。
  monitor () {
    const byLevel = Object.fromEntries(LEVELS.map((l) => [l, 0]))
    let total = 0
    let uncertain = 0
    for (const f of Object.values(this.state.files)) {
      total++
      byLevel[f.lv] = (byLevel[f.lv] || 0) + 1
      if (f.lv === 'internal' && !f.a) uncertain++
    }
    const sizeOf = (p) => { try { return statSync(p).size } catch { return 0 } }
    return {
      sources: this.state.sources.length,
      total,
      byLevel,
      uncertain,
      scanning: this.scanning,
      watching: Array.isArray(this.watchers) ? this.watchers.length : 0,
      lastScan: this.state.sources.map((s) => s.lastScan).filter(Boolean).sort().pop() || null,
      storage: { indexBytes: sizeOf(this.indexFile), accessBytes: sizeOf(this.accessFile) }
    }
  }

  // ---- A 方向检索增强：时间线 / 最近使用信号 / 压缩包内览 ----

  // 文件时间线：索引内文件按修改日聚合（"上周三改过的那份文件"）
  timeline (opts = {}) {
    const allow = new Set(this.allowedFor(opts.agent))
    const days = Number(opts.days) || 7
    const since = Date.now() - days * 86400e3
    const q = norm(opts.q || '')
    const limitPerDay = Math.min(Number(opts.limit) || 10, 50)
    const byDay = new Map()
    for (const [p, f] of Object.entries(this.state.files)) {
      if (!allow.has(f.lv) || f.mt < since) continue
      if (q && !norm(p).includes(q)) continue
      const day = new Date(f.mt).toLocaleDateString('sv-SE') // YYYY-MM-DD（本地时区）
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push({ path: p, name: basename(p), level: f.lv, size: f.s, mtime: f.mt })
    }
    const out = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, files]) => ({
      day,
      count: files.length,
      files: files.sort((a, b) => b.mtime - a.mtime).slice(0, limitPerDay)
    }))
    return { days, total: out.reduce((s, d) => s + d.count, 0), timeline: out.slice(0, 31) }
  }

  // 最近使用信号：Windows Recent\*.lnk（资源管理器/打开对话框自动生成，零成本的使用频率数据）
  recentSignals (recentDir = null) {
    const dir = recentDir || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Recent')
    const now = Date.now()
    if (this._recent && now - this._recent.at < 10 * 60 * 1000 && this._recent.dir === dir) return this._recent.map
    const map = new Map() // 文件名（不含扩展名，小写）→ {count, last}
    try {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.lnk')) continue
        const st = statSync(join(dir, ent.name))
        if (now - st.mtimeMs > 90 * 86400e3) continue // 90 天前的快捷方式不计
        const key = ent.name.slice(0, -4).toLowerCase()
        const prev = map.get(key) || { count: 0, last: 0 }
        prev.count++
        prev.last = Math.max(prev.last, st.mtimeMs)
        map.set(key, prev)
      }
    } catch (e) { /* Recent 目录不存在等：空信号 */ }
    this._recent = { at: now, dir, map }
    return map
  }

  // ---- 压缩包内览（zip 中央目录解析，不解压不落索引；按需调用）----
  zipList (path, opts = {}) {
    const f = this.state.files[path]
    if (!f) return { error: '不在索引中' }
    if (!new Set(this.allowedFor(opts.agent, path)).has(f.lv)) return { error: `权限不足：文件级别「${LEVEL_LABEL[f.lv]}」不在当前 agent 允许范围内` }
    if (f.e !== 'zip') return { error: '仅支持 .zip（暂不支持 rar/7z）' }
    let fd
    try {
      fd = openSync(path, 'r')
      const size = fstatSync(fd).size
      const tailLen = Math.min(size, 66000)
      const tail = Buffer.alloc(tailLen)
      readSync(fd, tail, 0, tailLen, size - tailLen)
      // 从后找 EOCD 签名 0x06054b50
      let eocd = -1
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
      }
      if (eocd < 0) return { error: '不是有效的 zip（未找到中央目录）' }
      const cdSize = tail.readUInt32LE(eocd + 12)
      const cdOffset = tail.readUInt32LE(eocd + 16)
      if (cdOffset === 0xFFFFFFFF) return { error: 'ZIP64 格式暂不支持' }
      const cd = Buffer.alloc(Math.min(cdSize, 2 * 1048576))
      readSync(fd, cd, 0, cd.length, cdOffset)
      const entries = []
      let off = 0
      const limit = Math.min(Number(opts.limit) || 200, 1000)
      while (off + 46 <= cd.length && cd.readUInt32LE(off) === 0x02014b50 && entries.length < limit) {
        const uncompSize = cd.readUInt32LE(off + 24)
        const nameLen = cd.readUInt16LE(off + 28)
        const extraLen = cd.readUInt16LE(off + 30)
        const commentLen = cd.readUInt16LE(off + 32)
        const name = cd.slice(off + 46, off + 46 + nameLen).toString('utf8')
        if (!name.endsWith('/')) entries.push({ name, size: uncompSize })
        off += 46 + nameLen + extraLen + commentLen
      }
      return { entries, total: entries.length, truncated: entries.length >= limit }
    } catch (e) {
      return { error: '读取失败: ' + e.message }
    } finally {
      try { closeSync(fd) } catch (e) { /* 忽略 */ }
    }
  }
}
