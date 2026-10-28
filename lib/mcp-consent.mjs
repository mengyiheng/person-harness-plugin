// 独立弹窗进程：即使用户随后关闭 Agent / MCP 桥，授权选择仍会写回登记册。
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { McpAccessStore } from './mcp-access.mjs'

const args = process.argv.slice(2)
const value = (name) => args[args.indexOf(name) + 1] || ''
const agent = value('--agent')
const dir = value('--data-dir')
if (!agent || !dir) process.exit(2)
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')
const script = join(dirname(fileURLToPath(import.meta.url)), 'mcp-consent.ps1')
const title = '智枢 · 发现新的 MCP 宿主'
const message = `检测到 Agent「${agent}」希望接入智枢 MCP 总线。\n\n允许：接入后按你的数据策略授权，并记录调用台账；支持的配置会自动写入。\n不接入：拒绝其通过总线检索和读取本机数据。\n\n插件所在的 dsh 宿主始终强制接入。`
try {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, b64(title), b64(message)], { stdio: 'ignore', windowsHide: false })
  if (r.error || r.status === null) throw r.error || new Error('授权窗口异常退出，未记录用户选择')
  const store = new McpAccessStore(dir)
  await store.setStatus(agent, r.status === 0 ? 'allowed' : 'denied', { install: true, by: 'popup' })
} catch (e) {
  try { writeFileSync(join(dir, 'mcp-consent-error.log'), String(e?.stack || e)) } catch {}
}
