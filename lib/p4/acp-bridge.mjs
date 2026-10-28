// 默认启动 Kimi Code；其它 ACP Agent 用 --command/--args/--label 覆盖。
import os from 'node:os'
import path from 'node:path'
import { startLightBridge } from './light-bridge.mjs'
import { createAcpDriver } from './acp-driver.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
let agentArgs = ['acp']
try { agentArgs = JSON.parse(args.get('--args') || '["acp"]') } catch { throw new Error('--args 必须是 JSON 字符串数组') }
if (!Array.isArray(agentArgs) || agentArgs.some((v) => typeof v !== 'string')) throw new Error('--args 必须是 JSON 字符串数组')
const label = args.get('--label') || 'Kimi Code'
const cwd = args.get('--cwd') || process.cwd()
const port = Number(args.get('--port') || 7711)
const driver = createAcpDriver({
  command: args.get('--command') || 'kimi',
  args: agentArgs,
  cwd,
  env: args.get('--kimi-home') ? { ...process.env, KIMI_CODE_HOME: args.get('--kimi-home') } : process.env,
  log: (...value) => console.log('[acp-bridge]', ...value)
})
const server = startLightBridge({
  label, port, cwd, driver,
  regDir: args.get('--reg') || path.join(os.homedir(), '.ph', 'acp-kimi-bridge'),
  log: (...value) => console.log('[acp-bridge]', ...value)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 50).unref() })
}
