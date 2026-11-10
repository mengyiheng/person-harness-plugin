// 🔴 T27：每 Agent 独立包与发布产物——一键构建 6 个自包含 npm 包 + npm pack tarball + SHA256SUMS。
// 用法：node scripts/package-editions.mjs
// 产物：artifacts/t27/<pkg>/（包目录，可 npm pack/install 的 staging）与 artifacts/t27/*.tgz + SHA256SUMS.txt
// 自包含策略：打全 lib/ 闭包 ＋ person-harness-core/ ＋ 本 edition 入口（bin 可直接 node 运行）；
// 运行时唯一静态外部依赖 = qrcode（ws 用 Node≥22 内置全局 WebSocket；@anthropic-ai/claude-agent-sdk
// 仅 claude 驱动运行时动态 import，不属静态闭包——如实记录在 README/边界）。
// 离线单动作安装：bundleDependencies 全量闭包 ＋ 实体 node_modules 一起进 tarball → npm install --offline 免网络。
// 硬性检查：包内任何文件命中本机绝对路径（pythonProject / C:\Users\<用户名>）即构建失败。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'artifacts', 't27')
const CORE_VERSION = '0.2.0' // 🔴 相对 0.1.0 递增：T24–T26 核心有变更
const EDITION_VERSION = '0.1.0'

let fail = 0
const ok = (msg) => console.log('✅ ' + msg)
const bad = (msg) => { fail++; console.log('❌ ' + msg) }

// ---- 6 个包定义 ----
const CORE = {
  pkg: 'person-harness-core', version: CORE_VERSION,
  desc: 'Person Harness 共享核心（装配骨架 + 兼容契约）：各宿主版本（dsh/qwen/kimi/opencode/pi）唯一装配入口',
  main: 'person-harness-core/index.mjs'
}
const EDITIONS = [
  { pkg: 'person-harness-dsh', entry: 'lib/index.js', bin: 'person-harness-dsh', desc: 'dsh 宿主版本（需 dsh 宿主 ctx 注入，bin 用于查看用法/定位入口）', usage: '由 dsh 宿主加载 lib/index.js 的 apply(ctx, cfg)；本 bin 仅展示用法' },
  { pkg: 'person-harness-opencode', entry: 'lib/opencode/plugin.mjs', bin: 'person-harness-opencode', desc: 'OpenCode 宿主版本（插件服务端）', usage: '由 OpenCode 以插件方式加载 lib/opencode/plugin.mjs；本 bin 仅展示用法' },
  { pkg: 'person-harness-kimi', entry: 'lib/p4/kimi-agent.mjs', bin: 'person-harness-kimi', desc: 'Kimi Code 独立 Agent（ACP）', usage: 'node bin/person-harness-kimi.mjs [--pair|--status|--server URL|--command kimi|...]' },
  { pkg: 'person-harness-qwen', entry: 'lib/p4/agent.mjs', bin: 'person-harness-qwen', desc: 'Qwen Code 独立 Agent（ACP，--config JSON 启动）', usage: 'node bin/person-harness-qwen.mjs --config <config.json> [--pair|--status|...]' },
  { pkg: 'person-harness-pi', entry: 'lib/p4/pi-bridge.mjs', bin: 'person-harness-pi', desc: 'pi 桥（pi --mode rpc → Person Harness 轻协议）', usage: 'node bin/person-harness-pi.mjs [--port 7707] [--cwd DIR] [--pi PI_CLI_JS]' }
]

// ---- 依赖闭包：从根 .pnpm store 解析 qrcode 的完整传递闭包并实体拷贝 ----
const pnpmStore = path.join(root, 'node_modules', '.pnpm')
function findStoreDir (name) {
  const prefix = name.replace('/', '+') + '@'
  for (const e of fs.readdirSync(pnpmStore)) {
    if (!e.startsWith(prefix)) continue
    const inner = path.join(pnpmStore, e, 'node_modules', name)
    if (fs.existsSync(inner)) return inner
  }
  return null
}
function copyDepClosure (name, stagedNM, copied) {
  if (copied.has(name)) return
  copied.add(name)
  const src = findStoreDir(name)
  if (!src) { bad('pnpm store 中找不到依赖 ' + name); return }
  fs.cpSync(src, path.join(stagedNM, name), { recursive: true })
  const pkgJson = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'))
  for (const dep of Object.keys(pkgJson.dependencies || {})) copyDepClosure(dep, stagedNM, copied)
}

// ---- 硬性检查：本机绝对路径零泄漏 ----
const ABS_PATTERNS = [
  { re: /pythonProject/i, label: 'D:\\pythonProject（本仓库本机路径）' },
  { re: /C:\\+Users\\+[A-Za-z0-9_.\- ]/i, label: 'C:\\Users\\<本机用户名>' }
]
// 豁免：C:\Users\Public 为 Windows 全机器相同的公共账户目录（lib/p4…tool-runtime 公共桌面常量），
// 非本机用户路径；按纪律不改 lib 产品代码，如实登记到 T27 报告。
const ABS_ALLOW = /C:\\+Users\\+Public\b/i
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.ps1', '.cmd', '.yml', '.yaml', '.html', '.css', '.toml'])
function scanAbsPaths (dir) {
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
        let text
        try { text = fs.readFileSync(p, 'utf8') } catch { continue }
        const lines = text.split(/\r?\n/)
        lines.forEach((line, i) => {
          for (const { re, label } of ABS_PATTERNS) {
            if (re.test(line) && !ABS_ALLOW.test(line)) hits.push(`${path.relative(dir, p)}:${i + 1} [${label}] ${line.trim().slice(0, 120)}`)
          }
        })
      }
    }
  }
  walk(dir)
  return hits
}

// ---- README / CHANGELOG 模板 ----
const installReadme = (name, version, desc, extra = '') => `# ${name}（v${version}）

${desc}

## 是什么

USCP 生态「Person Harness」的独立发布包（T27 产物）：手机 App ↔ 桌面 Agent 的身份/隧道/数据总线/工具运行时整套能力。本包**自包含**：依赖以 npm bundleDependencies 随 tarball 内置，**离线单动作安装**，不依赖其它 edition 包。

${extra}

## 单动作安装（离线）

\`\`\`bash
npm install -g ./person-harness-xxx-${version}.tgz   # 全局（或本地目录 npm install <tarball>）
\`\`\`
全程无需网络拉依赖（qrcode 闭包已内置，bundleDependencies）。

## 与其它版本共存

每个 edition（dsh / opencode / kimi / qwen / pi）使用**独立身份数据目录、独立会话目录、独立数据总线本地目录**（默认 \`~/.ph/<profile>\` 等，互不共用索引），可同时安装运行；共享索引仅在显式配置 \`PH_DATABUS_SHARED_INDEX\` 等环境变量时启用。卸载任一 edition 不影响其余 edition。

## 卸载

\`\`\`bash
npm uninstall -g ${name}   # 全局安装时；本地安装删除安装目录即可
\`\`\`
可选清理用户数据：删除 \`~/.ph/\` 下对应 profile 目录与 \`~/.pi\`/\`~/.kimi\` 等宿主自身会话目录（由宿主 CLI 自管理）。

## 边界（如实）

- 本包为本地 Release 产物，未发布到 npm registry。
- Node ≥ 22（使用内置全局 WebSocket）。ws 仅测试用；\`@anthropic-ai/claude-agent-sdk\` 仅 claude 驱动运行时动态加载，非本包静态闭包（如需 claude 驱动请宿主自备）。
`

const changelog = (version, name) => `# Changelog — ${name}

## ${version}（首发）

- 范围：T00–T26 全部既有能力随包首发（身份/配对、出站隧道、协议适配、数据总线 T19–T23、工具运行时 T07、edition 隔离 T04–T09、资源调度 T22、编码链 T24–T26 等见仓库任务卡）。
- T27：新增独立 npm 包与 npm pack tarball（bundleDependencies 离线单动作安装），每 edition 自包含。
- 相对前一核心版本 0.1.0，核心含 T24–T26 变更，故 core 以 ${version} 首发；各 edition 包 ${version} 首发。
`

// ---- 组装单个包 staging ----
function stagePackage (def) {
  const staged = path.join(outDir, def.pkg)
  fs.rmSync(staged, { recursive: true, force: true })
  fs.mkdirSync(staged, { recursive: true })

  if (def.pkg === CORE.pkg) {
    // core 包：保留 person-harness-core/ 子目录（index.mjs 相对引用 '../lib/*'、'./tool-runtime.mjs'，
    // 依赖方向契约 core → lib/*；平铺会破坏相对路径），main=person-harness-core/index.mjs。
    fs.cpSync(path.join(root, 'person-harness-core'), path.join(staged, 'person-harness-core'), { recursive: true })
    fs.cpSync(path.join(root, 'lib'), path.join(staged, 'lib'), { recursive: true })
  } else {
    // edition 包：全 lib/ + person-harness-core/ + 生成 bin
    fs.cpSync(path.join(root, 'lib'), path.join(staged, 'lib'), { recursive: true })
    fs.cpSync(path.join(root, 'person-harness-core'), path.join(staged, 'person-harness-core'), { recursive: true })
    const binDir = path.join(staged, 'bin')
    fs.mkdirSync(binDir)
    const binName = def.bin + '.mjs'
    fs.writeFileSync(path.join(binDir, binName), `#!/usr/bin/env node
// 🔴 T27 生成文件：${def.pkg} 可直接 node 运行的入口。--help 自描述；其余参数转发到真实入口
//（以子进程 node 方式运行 lib 入口文件，保留其 isMain 语义与 argv 解析习惯）。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', ${JSON.stringify(def.entry)})
const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(${JSON.stringify(def.pkg + ' — ' + def.desc)})
  console.log('用法: ' + ${JSON.stringify(def.usage)})
  console.log('入口模块: ' + ${JSON.stringify(def.entry)})
  process.exit(0)
}

const child = spawn(process.execPath, [entry, ...args], { stdio: 'inherit' })
child.on('exit', (code, signal) => process.exit(code == null ? 1 : code))
`)
    fs.chmodSync(path.join(binDir, binName), 0o755)
  }

  // 依赖闭包（core 的 tool-runtime 也静态 import qrcode）
  copyDepClosure('qrcode', path.join(staged, 'node_modules'), new Set())

  // LICENSE / README / CHANGELOG / package.json
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staged, 'LICENSE'))
  const extra = def.pkg === CORE.pkg
    ? '本包是共享核心，**被各 edition 包依赖或随包内置**（每个 edition 包将本核心整包内置为 `person-harness-core/`），一般不单独安装。'
    : `入口：\`${def.entry}\`。快速自检：\`node bin/${def.bin}.mjs --help\`。`
  fs.writeFileSync(path.join(staged, 'README.md'), installReadme(def.pkg, def.version, def.desc, extra))
  fs.writeFileSync(path.join(staged, 'CHANGELOG.md'), changelog(def.version, def.pkg))
  const pkgJson = {
    name: def.pkg,
    version: def.version,
    type: 'module',
    main: def.main,
    description: def.desc,
    license: 'MIT',
    repository: 'mengyiheng/person-harness-plugin',
    engines: { node: '>=22' },
    bin: def.pkg === CORE.pkg ? undefined : { [def.bin]: 'bin/' + def.bin + '.mjs' },
    dependencies: { qrcode: '^1.5.4' },
    bundleDependencies: []
  }
  if (def.pkg === CORE.pkg) delete pkgJson.bin
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')

  // bundleDependencies = 实际内置的 node_modules 闭包（含传递依赖，保证 tarball 自包含）
  const bundled = fs.readdirSync(path.join(staged, 'node_modules')).sort()
  pkgJson.bundleDependencies = bundled
  fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify(pkgJson, null, 2) + '\n')

  // 硬性检查：绝对路径零泄漏
  const hits = scanAbsPaths(staged)
  if (hits.length) {
    bad(`${def.pkg} 绝对路径泄漏 ${hits.length} 处`)
    for (const h of hits.slice(0, 20)) console.log('   ' + h)
  } else ok(`${def.pkg} 绝对路径零泄漏`)

  // npm pack
  try {
    const tgz = execFileSync('npm', ['pack', '--pack-destination', outDir, '--silent'], { cwd: staged, encoding: 'utf8', shell: process.platform === 'win32' }).trim().split(/\r?\n/).pop()
    ok(`${def.pkg} npm pack → ${tgz}`)
  } catch (e) {
    bad(`${def.pkg} npm pack 失败: ${String(e?.message || e).slice(0, 300)}`)
  }
  return staged
}

// ---- 主流程 ----
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })
console.log(`[T27] 构建到 ${outDir}`)

if (!fs.existsSync(pnpmStore)) bad('根 node_modules/.pnpm 不存在（依赖闭包来源）')
stagePackage(CORE)
for (const ed of EDITIONS) stagePackage({ ...ed, version: EDITION_VERSION, main: ed.entry })

// SHA256SUMS.txt
const tarballs = fs.readdirSync(outDir).filter((f) => f.endsWith('.tgz')).sort()
const lines = tarballs.map((f) => {
  const sum = createHash('sha256').update(fs.readFileSync(path.join(outDir, f))).digest('hex')
  return `${sum}  ${f}`
})
fs.writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
ok(`SHA256SUMS.txt（${tarballs.length} 个 tarball）`)

console.log(fail ? `\n构建失败：${fail} 处问题` : `\n构建完成：6 包 + ${tarballs.length} tarball。安装：npm install -g <tarball>（离线）`)
process.exitCode = fail ? 1 : 0
