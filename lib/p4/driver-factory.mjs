// 独立 Agent 驱动工厂：配置只描述执行内核，轻壳/配对/工作区/审批台账不随驱动复制。
import { createAcpDriver } from './acp-driver.mjs'
import { createClaudeDriver } from './claude-driver.mjs'
import { createCodexDriver } from './codex-driver.mjs'
import { createOpencodeDriver } from './opencode-driver.mjs'
import { createPiDriver } from './pi-driver.mjs'
import { createCursorDriver } from './cursor-driver.mjs'
import { createCopilotDriver } from './copilot-driver.mjs'

const stringArray = (value, fallback, label) => {
  const result = value === undefined ? fallback : value
  if (!Array.isArray(result) || result.some((item) => typeof item !== 'string')) throw new Error(label + ' 必须是字符串数组')
  return result
}

export function createDriverFromConfig (config = {}, { cwd, log = () => {} } = {}) {
  const type = config.type || 'acp'
  const env = { ...process.env, ...(config.env || {}) }
  if (type === 'acp') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    return createAcpDriver({
      command: config.command || 'kimi',
      args: stringArray(config.args, ['acp'], 'driver.args'),
      cwd, env, log
    })
  }
  if (type === 'codex') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    return createCodexDriver({
      cwd,
      command: config.command || 'codex',
      args: stringArray(config.args, ['app-server'], 'driver.args'),
      codexHome: config.codexHome,
      env,
      log
    })
  }
  if (type === 'opencode') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    if (config.origin !== undefined && (typeof config.origin !== 'string' || !config.origin)) throw new Error('driver.origin 必须是非空字符串')
    return createOpencodeDriver({
      cwd,
      command: config.command || 'opencode',
      args: config.args,
      origin: config.origin,
      env,
      log
    })
  }
  if (type === 'pi') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    return createPiDriver({
      cwd,
      node: config.node || process.execPath,
      piScript: config.command || undefined,
      sessionDir: config.sessionDir,
      env,
      log
    })
  }
  if (type === 'cursor') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    return createCursorDriver({
      cwd,
      command: config.command || 'cmd.exe',
      cmdArgs: config.args,
      models: stringArray(config.models, [], 'driver.models'),
      env,
      log
    })
  }
  if (type === 'copilot') {
    if (config.command !== undefined && (typeof config.command !== 'string' || !config.command)) throw new Error('driver.command 必须是非空字符串')
    return createCopilotDriver({
      cwd,
      command: config.command || 'copilot',
      baseArgs: stringArray(config.args, [], 'driver.args'),
      allowAllTools: config.allowAllTools === true,
      models: stringArray(config.models, [], 'driver.models'),
      env,
      log
    })
  }
  if (type === 'claude') {
    return createClaudeDriver({
      cwd,
      sdkModule: config.sdkModule || '@anthropic-ai/claude-agent-sdk',
      executable: config.executable,
      configuredModels: stringArray(config.models, [], 'driver.models'),
      defaultModel: config.defaultModel || 'default',
      env
    })
  }
  throw new Error('不支持的独立 Agent 驱动: ' + type + '（当前内置 acp、claude、codex、opencode、pi、cursor、copilot）')
}
