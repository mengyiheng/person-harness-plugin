// 磁盘清理分析器（M5）——只读，永不删除；与主索引互补：
// 主索引为检索服务（忽略 AppData/系统目录），本分析器为清理服务（正要看那些地方）
// 纪律：🔴 本模块只产生报告与候选，删除永远由用户在界面/对话确认后另行执行
import { join } from 'node:path'
import { homedir, tmpdir, platform } from 'node:os'
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const MB = 1048576
const GB = 1024 * MB

// 目录树体积统计：带预算（节点数/时长），跳过符号链接与重解析点（C 盘 NTFS junction 陷阱）
function du (root, budget = { nodes: 300000, ms: 20000 }) {
  const deadline = Date.now() + budget.ms
  let nodes = 0
  let size = 0
  let truncated = false
  const stack = [root]
  while (stack.length) {
    if (nodes > budget.nodes || Date.now() > deadline) { truncated = true; break }
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { continue } // 无权限/已消失：跳过
    for (const ent of entries) {
      if (nodes > budget.nodes || Date.now() > deadline) { truncated = true; break }
      nodes++
      const full = join(dir, ent.name)
      try {
        if (ent.isSymbolicLink()) continue // 🔴 junction/链接不深入（防环、防串到别盘）
        if (ent.isDirectory()) {
          let st
          try { st = statSync(full) } catch (e) { continue }
          if (st.nlink > 1 && st.size === 0) { /* 硬链接目录罕见，照常深入 */ }
          stack.push(full)
        } else {
          const st = statSync(full)
          size += st.size
        }
      } catch (e) { continue }
    }
  }
  return { size, truncated, nodes }
}

const fmt = (n) => n >= GB ? (n / GB).toFixed(2) + ' GB' : n >= MB ? Math.round(n / MB) + ' MB' : Math.round(n / 1024) + ' KB'

// ---- 清理规则注册表（借鉴 BleachBit 的声明式 cleaners 架构）----
// 规则外置 cleaners.json：每条 {id,name,paths[],cleanable,risk,admin?,file?,note?,warning?,running?[]}
// 路径支持占位符 %USERPROFILE% %LOCALAPPDATA% %APPDATA% %WINDIR% %TEMP%，段内支持 * 通配
// （readdirSync 顶部已导入）
const registryFile = join(import.meta.dirname || '.', 'cleaners.json')
function loadCleaners () {
  try {
    return JSON.parse(readFileSync(registryFile, 'utf8'))
  } catch (e) {
    console.error('[cleanup] cleaners.json 加载失败，退化为内置最小集: ' + e.message)
    return [{ id: 'user-temp', name: '用户临时文件', paths: ['%TEMP%'], cleanable: true, risk: 'low' }]
  }
}

function resolveCleanerPath (tpl, env) {
  const home = env.USERPROFILE || homedir()
  const expanded = tpl
    .replace(/^%USERPROFILE%/i, home)
    .replace(/^%LOCALAPPDATA%/i, env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
    .replace(/^%APPDATA%/i, env.APPDATA || join(home, 'AppData', 'Roaming'))
    .replace(/^%WINDIR%/i, env.WINDIR || 'C:\\Windows')
    .replace(/^%TEMP%/i, env.TEMP || tmpdir())
  const segs = expanded.split(/[\\/]/)
  let cur = [segs[0]] // 盘符
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.includes('*')) {
      const base = cur.join('\\')
      let subs = []
      try { subs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && seg2match(seg).test(e.name)).map((e) => join(base, e.name)) } catch (err) { /* 目录不存在 */ }
      cur = subs
    } else {
      cur = cur.map((p) => join(p, seg))
    }
  }
  return cur
}
const seg2match = (seg) => new RegExp('^' + seg.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')

// 运行中进程检测（BleachBit 的 <running> 保护）：应用开着时不动它的缓存，防损坏
export function getRunningProcesses () {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 10000 })
    return new Set([...out.matchAll(/"([^"]+\.exe)"/gi)].map((m) => m[1].toLowerCase()))
  } catch (e) {
    return new Set()
  }
}

// 已知清理目标（从注册表展开；全部只读测量）
export function knownTargets (env = process.env, runningSet = null) {
  const running = runningSet || new Set()
  const out = []
  for (const c of loadCleaners()) {
    let resolved
    try { resolved = c.paths.flatMap((p) => resolveCleanerPath(p, env)) } catch (e) { continue }
    const isRunning = (c.running || []).some((exe) => running.has(exe.toLowerCase()))
    const blocked = isRunning ? 'running' : null
    for (const path of resolved) {
      out.push({
        id: c.id, name: c.name, path, cleanable: c.cleanable && !isRunning, risk: c.risk,
        admin: c.admin, file: c.file, note: c.note,
        warning: isRunning ? `应用运行中（${c.running.join('/')}），先关闭再清理` : c.warning
      })
    }
  }
  return out
}

// C 盘分析总报告（只读）
export async function analyzeC (opts = {}) {
  const home = opts.home || homedir()
  const runningSet = opts.runningSet !== undefined ? opts.runningSet : getRunningProcesses()
  const targets = []
  for (const t of knownTargets(opts.env || process.env, runningSet)) {
    try {
      if (!existsSync(t.path)) continue
      let r
      if (t.file) {
        const st = statSync(t.path)
        r = { size: st.size, truncated: false }
      } else {
        r = du(t.path, { nodes: 200000, ms: 15000 })
      }
      targets.push({ ...t, size: r.size, truncated: r.truncated, sizeText: fmt(r.size) })
    } catch (e) { /* 无权限等：跳过 */ }
  }
  targets.sort((a, b) => b.size - a.size)

  // 用户目录的大头（AppData 各家 + 常见膨胀区）
  const profileAreas = ['AppData\\Local', 'AppData\\Roaming', 'AppData\\LocalLow', 'Downloads', 'Documents', 'Videos', 'Pictures']
    .map((p) => join(home, p))
  const profileTop = []
  let truncatedAny = false
  for (const p of profileAreas) {
    if (!existsSync(p)) continue
    const r = du(p, { nodes: 400000, ms: 30000 })
    truncatedAny = truncatedAny || r.truncated
    profileTop.push({ path: p, size: r.size, sizeText: fmt(r.size), truncated: r.truncated })
  }
  profileTop.sort((a, b) => b.size - a.size)

  // AppData\\Local 一层细分（膨胀元凶通常在这层能看出来）
  const localTop = []
  const localDir = join(home, 'AppData', 'Local')
  if (existsSync(localDir)) {
    let entries = []
    try { entries = readdirSync(localDir, { withFileTypes: true }) } catch (e) { /* 忽略 */ }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue
      const p = join(localDir, ent.name)
      const r = du(p, { nodes: 200000, ms: 15000 })
      truncatedAny = truncatedAny || r.truncated
      localTop.push({ path: p, size: r.size, sizeText: fmt(r.size), truncated: r.truncated })
    }
    localTop.sort((a, b) => b.size - a.size)
  }

  // 大而旧文件（用户目录内，阈值可配：默认 >200MB 且 >180 天未修改）
  const bigOldMB = opts.bigOldMB || 200
  const oldDays = opts.oldDays || 180
  const bigOld = []
  const cutoff = Date.now() - oldDays * 86400e3
  const stack = [home]
  let nodes = 0
  while (stack.length && nodes < 600000) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
    for (const ent of entries) {
      if (++nodes > 600000) { truncatedAny = true; break }
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      try {
        if (ent.isDirectory()) {
          if (!['node_modules', '.git'].includes(ent.name)) stack.push(full) // 跳过开发噪音目录；AppData 要看（膨胀大户）
        } else {
          const st = statSync(full)
          if (st.size > bigOldMB * MB && st.mtimeMs < cutoff) bigOld.push({ path: full, size: st.size, sizeText: fmt(st.size), mtime: new Date(st.mtimeMs).toLocaleDateString('zh-CN') })
        }
      } catch (e) { continue }
    }
  }
  bigOld.sort((a, b) => b.size - a.size)

  const reclaimable = targets.filter((t) => t.cleanable).reduce((s, t) => s + t.size, 0)
  return {
    platform: platform(),
    targets, profileTop, localTop: localTop.slice(0, 15), bigOld: bigOld.slice(0, 15),
    reclaimable, reclaimableText: fmt(reclaimable), truncatedAny, generatedAt: new Date().toISOString()
  }
}

// ---- 重复文件检测（同 size → 同哈希分组；只读）----
export async function findDuplicates (roots, opts = {}) {
  const minSize = opts.minSizeMB ? opts.minSizeMB * MB : MB
  const hashLimit = (opts.hashLimitMB || 100) * MB
  const bySize = new Map()
  const stack = [...roots]
  let nodes = 0
  while (stack.length && nodes < 800000) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
    for (const ent of entries) {
      if (++nodes > 800000) break
      if (ent.isSymbolicLink()) continue
      const full = join(dir, ent.name)
      try {
        if (ent.isDirectory()) {
          if (!['node_modules', '.git', '$recycle.bin'].includes(ent.name.toLowerCase())) stack.push(full)
          continue
        }
        const st = statSync(full)
        if (st.size >= minSize) {
          if (!bySize.has(st.size)) bySize.set(st.size, [])
          bySize.get(st.size).push({ path: full, mtime: st.mtimeMs })
        }
      } catch (e) { continue }
    }
  }
  const groups = []
  for (const [size, files] of bySize) {
    if (files.length < 2) continue
    const byHash = new Map()
    for (const f of files) {
      try {
        if (size > hashLimit) continue // 超大文件不读内容
        const h = createHash('md5').update(readFileSync(f.path)).digest('hex')
        if (!byHash.has(h)) byHash.set(h, [])
        byHash.get(h).push(f.path)
      } catch (e) { continue }
    }
    for (const [h, ps] of byHash) {
      if (ps.length >= 2) groups.push({ size, sizeText: fmt(size), hash: h.slice(0, 12), files: ps, waste: size * (ps.length - 1), wasteText: fmt(size * (ps.length - 1)) })
    }
  }
  groups.sort((a, b) => b.waste - a.waste)
  return { groups: groups.slice(0, opts.limit || 30), totalWaste: groups.reduce((s, g) => s + g.waste, 0), wasteText: fmt(groups.reduce((s, g) => s + g.waste, 0)), scannedNodes: nodes }
}

// ---- 删除前校验（独立纯函数，可测；🔴 纪律的代码化）----
// 规则：1) 必须在允许根目录内 2) 敏感/禁碰级一票否决（除非 allowSensitive 且 still 记录）
// 3) 系统保护路径永不通过 4) dataBus 索引级别优先于路径判断
export function validateDeletable (path, opts = {}) {
  const allowedRoots = opts.allowedRoots || []
  const np = path.toLowerCase()
  // 🔴 防御纵深：系统保护路径最先判（即使将来 allowedRoots 配置过宽也拦得住）
  const protectedPaths = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata']
  if (protectedPaths.some((p) => np.startsWith(p))) return { ok: false, reason: '系统保护路径，永不清理' }
  const inRoot = allowedRoots.some((r) => {
    const norm = r.toLowerCase().replace(/[\\/]+$/, '') // 根路径尾部分隔符归一（'C:\\' → 'c:'），防拼出双反斜杠
    return np.startsWith(norm + '\\') || np.startsWith(norm + '/')
  })
  if (!inRoot) return { ok: false, reason: '不在允许清理的目录范围内' }
  const level = opts.lookupLevel ? opts.lookupLevel(path) : null
  if (level === 'sensitive' || level === 'restricted') {
    if (!opts.allowSensitive) return { ok: false, reason: `文件分级为「${level === 'sensitive' ? '敏感' : '禁碰'}」，一票否决（先在资源管理器改级再清理）` }
  }
  return { ok: true }
}

// ---- 回收站删除（可撤回；逐项执行并核验）----
export async function recycleDelete (paths) {
  const results = []
  for (const p of paths) {
    try {
      const st = statSync(p)
      const isDir = st.isDirectory()
      const arg = p.replaceAll("'", "''")
      const script = isDir
        ? `Add-Type -AssemblyName Microsoft.VisualBasic;[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${arg}','OnlyErrorDialogs','SendToRecycleBin')`
        : `Add-Type -AssemblyName Microsoft.VisualBasic;[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${arg}','OnlyErrorDialogs','SendToRecycleBin')`
      const enc = Buffer.from(script, 'utf16le').toString('base64')
      execSync(`"${join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}" -NoProfile -NonInteractive -EncodedCommand ${enc}`, { timeout: 30000, stdio: 'ignore' })
      results.push({ path: p, ok: !existsSync(p), error: existsSync(p) ? '删除后仍存在' : null })
    } catch (e) {
      results.push({ path: p, ok: false, error: String(e.message).slice(0, 120) })
    }
  }
  return results
}

export function formatReport (r) {  const lines = ['**C 盘空间分析**（只读报告，未删除任何文件）', '']
  lines.push(`可清理合计：约 **${r.reclaimableText}**`, '')
  lines.push('**已知清理目标**（按体积排序，仅列 >10MB）：')
  for (const t of r.targets.filter((x) => x.size > 10 * MB)) {
    const flag = t.cleanable ? (t.risk === 'low' ? '🟢' : t.risk === 'medium' ? '🟡' : '🔴') : '⚪'
    lines.push(`- ${flag} ${t.name}：${t.sizeText}${t.admin ? '（需管理员）' : ''}${t.note ? '——' + t.note : ''}`)
    if (t.warning) lines.push(`  ⚠️ ${t.warning}`)
    lines.push(`  \`${t.path}\``)
  }
  lines.push('', '**用户目录大头**：')
  for (const p of r.profileTop) lines.push(`- ${p.sizeText}  \`${p.path}\`${p.truncated ? '（统计不完整）' : ''}`)
  lines.push('', '**AppData\\Local 细分 TOP**：')
  for (const p of r.localTop.filter((x) => x.size > 100 * MB)) lines.push(`- ${p.sizeText}  \`${p.path}\``)
  if (r.bigOld.length) {
    lines.push('', '**大而旧文件**（>200MB 且 >180 天未动，仅列出）：')
    for (const f of r.bigOld) lines.push(`- ${f.sizeText} · ${f.mtime}  \`${f.path}\``)
  }
  if (r.truncatedAny) lines.push('', '（部分目录超预算未统计完，结果偏保守）')
  lines.push('', '⚪=只报告不建议清理；删除操作永远需要你在资源管理器/对话中逐项确认')
  return lines.join('\n')
}
