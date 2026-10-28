#!/usr/bin/env node
// Kimi Code 独立 Agent：通用独立启动层 + ACP；保留原命令和编程接口。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startIndependentAgent } from './independent-agent.mjs'

const DEFAULT_SERVER = 'http://8.137.177.62:9400'

export function startKimiAgent (options = {}) {
  return startIndependentAgent({
    ...options,
    label: options.label || 'Kimi Code',
    name: options.name || 'kimi-code',
    driverConfig: options.driverConfig || {
      type: 'acp',
      command: options.command || 'kimi',
      args: options.args || ['acp'],
      env: { ...(options.env || process.env), ...(options.kimiHome ? { KIMI_CODE_HOME: options.kimiHome } : {}) }
    }
  })
}

function parseArgs (argv) {
  const values = new Map()
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    if (['--pair', '--status', '--no-tunnel'].includes(key)) flags.add(key)
    else if (key === '--workspace') values.set(key, [...(values.get(key) || []), argv[++i]])
    else values.set(key, argv[++i])
  }
  return { values, flags }
}

async function main () {
  const { values, flags } = parseArgs(process.argv.slice(2))
  const home = path.resolve(values.get('--home') || path.join(os.homedir(), '.ph', 'kimi-code'))
  const workspaces = (values.get('--workspace') || []).map((value, index) => {
    const separator = value.indexOf('=')
    const name = separator > 0 ? value.slice(0, separator) : `工作区 ${index + 1}`
    const cwd = separator > 0 ? value.slice(separator + 1) : value
    if (!cwd) throw new Error('--workspace 需要 名称=目录')
    return { id: `workspace-${index + 1}`, name, cwd }
  })
  if (flags.has('--status')) {
    let deviceId = null
    try { deviceId = JSON.parse(fs.readFileSync(path.join(home, 'identity', 'identity.json'), 'utf8')).deviceId } catch { }
    console.log(JSON.stringify({ agent: 'kimi-code', home, deviceId, pairedIdentity: !!deviceId }, null, 2))
    return
  }
  let agentArgs = ['acp']
  try { agentArgs = JSON.parse(values.get('--args') || '["acp"]') } catch { throw new Error('--args 必须是 JSON 字符串数组') }
  if (!Array.isArray(agentArgs) || agentArgs.some((value) => typeof value !== 'string')) throw new Error('--args 必须是 JSON 字符串数组')
  const agent = await startKimiAgent({
    name: values.get('--name') || 'kimi-code',
    label: values.get('--label') || 'Kimi Code',
    port: Number(values.get('--port') || 7711),
    cwd: values.get('--cwd') || process.cwd(),
    workspaces,
    home,
    regDir: values.get('--reg'),
    server: values.get('--server') || DEFAULT_SERVER,
    command: values.get('--command') || 'kimi',
    args: agentArgs,
    kimiHome: values.get('--kimi-home'),
    localOnly: flags.has('--no-tunnel')
  })
  if (flags.has('--pair')) await agent.pair()
  console.log(`Kimi Code 独立 Agent 已就绪: ${agent.origin}`)
  if (!flags.has('--no-tunnel')) console.log('手机 App 选择此 Agent；尚未配对时使用 --pair')
  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    agent.close()
    setTimeout(() => process.exit(0), 50).unref()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch((error) => { console.error('[kimi-code] 启动失败:', error); process.exitCode = 1 })
