import os from 'node:os'
import path from 'node:path'
import { startLightBridge } from './light-bridge.mjs'
import { createClaudeDriver } from './claude-driver.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const cwd = args.get('--cwd') || process.cwd()
const port = Number(args.get('--port') || 7710)
const driver = createClaudeDriver({
  cwd,
  sdkModule: args.get('--sdk') || '@anthropic-ai/claude-agent-sdk',
  executable: args.get('--claude'),
  configuredModels: (args.get('--models') || '').split(',').map((m) => m.trim()).filter(Boolean),
  defaultModel: args.get('--model') || 'default'
})
const server = startLightBridge({
  label: 'Claude Code', port, cwd, driver,
  regDir: args.get('--reg') || path.join(os.homedir(), '.ph', 'claude-bridge'),
  log: (...value) => console.log('[claude-bridge]', ...value)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 50).unref() })
}
