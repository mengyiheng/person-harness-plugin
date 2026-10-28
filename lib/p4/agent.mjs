#!/usr/bin/env node
// 配置驱动的独立 Agent 启动入口。复制 agent-templates/*.json 即可增加一个完全隔离的 Agent。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { startIndependentAgent } from './independent-agent.mjs'

const DEFAULT_SERVER = 'http://8.137.177.62:9400'

function parseArgs (argv) {
  const values = new Map()
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key?.startsWith('--')) throw new Error('无法识别参数: ' + key)
    if (['--pair', '--status', '--no-tunnel'].includes(key)) flags.add(key)
    else if (key === '--workspace') values.set(key, [...(values.get(key) || []), argv[++i]])
    else {
      const value = argv[++i]
      if (!value) throw new Error(key + ' 缺少参数值')
      values.set(key, value)
    }
  }
  return { values, flags }
}

function parseWorkspaces (items, baseDir) {
  return items.map((item, index) => {
    if (typeof item === 'string') {
      const separator = item.indexOf('=')
      const name = separator > 0 ? item.slice(0, separator) : `工作区 ${index + 1}`
      const cwd = separator > 0 ? item.slice(separator + 1) : item
      if (!cwd) throw new Error('workspace 需要 名称=目录')
      return { id: `workspace-${index + 1}`, name, cwd: path.resolve(baseDir, cwd) }
    }
    if (!item || typeof item.cwd !== 'string' || !item.cwd) throw new Error('workspaces[] 缺少 cwd')
    return {
      id: String(item.id || `workspace-${index + 1}`),
      name: String(item.name || item.id || `工作区 ${index + 1}`),
      cwd: path.resolve(baseDir, item.cwd)
    }
  })
}

export function resolveAgentConfig (configPath, values = new Map()) {
  const file = path.resolve(configPath)
  const baseDir = path.dirname(file)
  let config
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) { throw new Error('无法读取 Agent 配置 ' + file + ': ' + error.message) }
  const name = values.get('--name') || config.name
  if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('Agent name 须为 1–40 位小写字母、数字或连字符')
  const label = values.get('--label') || config.label || name
  const cwd = path.resolve(baseDir, values.get('--cwd') || config.cwd || '.')
  const cliWorkspaces = values.get('--workspace')
  const workspaces = cliWorkspaces?.length
    ? parseWorkspaces(cliWorkspaces, process.cwd())
    : parseWorkspaces(config.workspaces || [], baseDir)
  const port = Number(values.get('--port') || config.port || 7711)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port 必须是 1–65535 的整数')
  return {
    name, label, cwd, workspaces, port,
    home: path.resolve(baseDir, values.get('--home') || config.home || path.join(os.homedir(), '.ph', name)),
    regDir: values.get('--reg') ? path.resolve(baseDir, values.get('--reg')) : config.regDir ? path.resolve(baseDir, config.regDir) : undefined,
    server: values.get('--server') || config.server || DEFAULT_SERVER,
    driverConfig: config.driver,
    deviceName: config.deviceName
  }
}

async function main () {
  const { values, flags } = parseArgs(process.argv.slice(2))
  const configPath = values.get('--config')
  if (!configPath) throw new Error('必须指定 --config <agent.json>；可复制 agent-templates/acp-agent.json')
  const options = resolveAgentConfig(configPath, values)
  if (flags.has('--status')) {
    let deviceId = null
    try { deviceId = JSON.parse(fs.readFileSync(path.join(options.home, 'identity', 'identity.json'), 'utf8')).deviceId } catch { }
    console.log(JSON.stringify({ agent: options.name, home: options.home, deviceId, pairedIdentity: !!deviceId }, null, 2))
    return
  }
  if (!options.driverConfig || typeof options.driverConfig !== 'object') throw new Error('配置缺少 driver 对象')
  const agent = await startIndependentAgent({ ...options, localOnly: flags.has('--no-tunnel') })
  if (flags.has('--pair')) await agent.pair()
  console.log(`${agent.label} 独立 Agent 已就绪: ${agent.origin}`)
  if (!flags.has('--no-tunnel')) console.log('手机 App 选择此 Agent；每个配置使用独立身份和会话目录')
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

main().catch((error) => { console.error('[independent-agent] 启动失败:', error); process.exitCode = 1 })
