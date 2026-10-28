// MCP 宿主接入登记、发现与授权。索引/策略仍由 DataBus 管理，本模块只管“谁能走总线”。
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, closeSync } from 'node:fs'

const REQUIRED = new Set(['dsh', 'person-harness', 'person-harness-plugin'])
const BRIDGE_NAMES = new Set(['person-harness', 'zhishu', 'ph-databus'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const now = () => Date.now()
const safeAgent = (value) => String(value || 'mcp-unknown').trim().slice(0, 80) || 'mcp-unknown'
const customAgent = (value) => {
  const agent = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(agent)) throw new Error('Agent 标识需以字母或数字开头，只能包含字母、数字、点、下划线和连字符')
  return agent
}
const emptyStats = () => ({ calls: 0, denied: 0, errors: 0, totalLatencyMs: 0, lastLatencyMs: 0, lastTool: '', lastCall: 0 })

function knownAgents (home = homedir(), env = process.env) {
  const json = (path) => ({ path, format: 'json-mcpServers' })
  const opencode = (path) => ({ path, format: 'json-opencode' })
  const claudeHome = env.CLAUDE_CONFIG_DIR || home
  const qwenHome = env.QWEN_HOME || join(home, '.qwen')
  const opencodeHome = env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode')
  return [
    { agent: 'claude-code', label: 'Claude Code', configs: [json(join(claudeHome, '.claude.json')), json(join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'config.json'))] },
    { agent: 'codex', label: 'Codex CLI / Desktop', configs: [{ path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), format: 'toml-codex' }] },
    { agent: 'copilot-cli', label: 'GitHub Copilot CLI', configs: [json(join(env.COPILOT_HOME || join(home, '.copilot'), 'mcp-config.json'))] },
    { agent: 'opencode', label: 'OpenCode', configs: [...(env.OPENCODE_CONFIG ? [opencode(env.OPENCODE_CONFIG)] : []), ...(env.OPENCODE_CONFIG_DIR ? [opencode(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'))] : []), opencode(join(opencodeHome, 'opencode.json')), opencode(join(opencodeHome, 'config.json'))] },
    { agent: 'kimi-code', label: 'Kimi Code', configs: [json(join(env.KIMI_CODE_HOME || join(home, '.kimi-code'), 'mcp.json')), json(join(home, '.kimi', 'mcp.json'))] },
    { agent: 'pi', label: 'Pi', configs: [json(join(env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent'), 'mcp.json'))] },
    { agent: 'qwen-code', label: 'Qwen Code', configs: [json(join(qwenHome, 'settings.json')), json(join(qwenHome, 'config.json')), json(join(qwenHome, 'mcp.json'))] },
    { agent: 'gemini-cli', label: 'Gemini CLI', configs: [json(join(home, '.gemini', 'settings.json'))] },
    // Cursor CLI 的 MCP 用户级路径固定为 ~/.cursor/mcp.json；CURSOR_CONFIG_DIR 不改写此路径。
    { agent: 'cursor', label: 'Cursor', configs: [json(join(home, '.cursor', 'mcp.json'))] },
    { agent: 'workbuddy', label: 'WorkBuddy', configs: [json(join(home, '.workbuddy', 'config.json')), json(join(home, '.workbuddy', 'mcp.json'))] },
    { agent: 'openclaw', label: 'OpenClaw / 龙虾 Agent', configs: [json(join(home, '.openclaw', 'openclaw.json')), json(join(home, '.openclaw', 'config.json'))] },
    { agent: 'clawdbot', label: 'Clawdbot / 龙虾 Agent', configs: [json(join(home, '.clawdbot', 'clawdbot.json')), json(join(home, '.clawdbot', 'config.json'))] }
  ]
}

function readJson (path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// 只提取 Codex 的 MCP 表用于发现；写入采用原文追加，不重排或破坏其他 TOML 设置与注释。
function tomlServerEntries (text) {
  const found = []
  let current = null
  const finish = () => { if (current) found.push([current.name, { command: [current.block], args: [] }]); current = null }
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/.exec(line)
    if (match) {
      finish()
      current = { name: match[1] || match[2] || match[3], block: line + '\n' }
    } else if (/^\s*\[/.test(line)) {
      finish()
    } else if (current) current.block += line + '\n'
  }
  finish()
  return found
}

function readHostConfig (path, format) {
  if (format !== 'toml-codex') return readJson(path)
  try { return { mcpServers: Object.fromEntries(tomlServerEntries(readFileSync(path, 'utf8'))) } } catch { return null }
}

function serverEntries (config) {
  const servers = config?.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : config?.mcp
  return servers && typeof servers === 'object' ? Object.entries(servers) : []
}

function isBridge ([name, server]) {
  const command = Array.isArray(server?.command) ? server.command.join(' ') : ''
  return BRIDGE_NAMES.has(name) || String(server?.args?.join(' ') || '').includes('mcp-server.mjs') || command.includes('mcp-server.mjs')
}

function bridgePresent (config) {
  return serverEntries(config).some(isBridge)
}

function otherServers (config) {
  return serverEntries(config).filter((entry) => !isBridge(entry)).map(([name]) => name).slice(0, 50)
}

export class McpAccessStore {
  constructor (dir, options = {}) {
    this.dir = dir
    this.file = join(dir, 'mcp-access.json')
    this.lock = join(dir, 'mcp-access.lock')
    this.bridgePath = options.bridgePath || join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.mjs')
    this.nodePath = options.nodePath || process.execPath
    this.home = options.home || homedir()
    this.env = options.env || process.env
    this.agents = options.agents || knownAgents(this.home, this.env)
  }

  _blank () {
    return { version: 1, hosts: {}, updatedAt: now() }
  }

  _read () {
    const data = readJson(this.file) || this._blank()
    if (!data.hosts || typeof data.hosts !== 'object') data.hosts = {}
    return data
  }

  _ensure (data) {
    const ts = now()
    for (const agent of REQUIRED) {
      const old = data.hosts[agent] || {}
      data.hosts[agent] = {
        agent,
        label: old.label || (agent === 'dsh' ? 'dsh（插件所在宿主）' : '智枢插件'),
        required: true,
        status: 'required',
        source: old.source || 'builtin',
        createdAt: old.createdAt || ts,
        updatedAt: ts,
        stats: { ...emptyStats(), ...(old.stats || {}) },
        ...old,
        required: true,
        status: 'required',
        stats: { ...emptyStats(), ...(old.stats || {}) }
      }
    }
    return data
  }

  async _acquire () {
    mkdirSync(this.dir, { recursive: true })
    for (let i = 0; i < 150; i++) {
      try {
        const fd = openSync(this.lock, 'wx')
        writeFileSync(fd, String(process.pid))
        closeSync(fd)
        return
      } catch (e) {
        try { if (now() - statSync(this.lock).mtimeMs > 30000) unlinkSync(this.lock) } catch {}
        if (i === 149) throw new Error('MCP 接入登记忙，请稍后重试')
        await sleep(20)
      }
    }
  }

  async _update (mutator) {
    await this._acquire()
    try {
      const data = this._ensure(this._read())
      const result = await mutator(data)
      data.updatedAt = now()
      const tmp = this.file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp'
      writeFileSync(tmp, JSON.stringify(data, null, 2))
      let renameError
      // Windows 上 Defender / 刚关闭的读句柄可能短暂占用目标文件；只在临时文件完整后重试替换。
      for (let attempt = 0; attempt < 40; attempt++) {
        try { renameSync(tmp, this.file); return result } catch (e) {
          renameError = e
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(e?.code) || attempt === 39) break
          await sleep(25)
        }
      }
      rmSync(tmp, { force: true })
      throw renameError
    } finally {
      rmSync(this.lock, { force: true })
    }
  }

  async list () {
    return this._update(async (data) => {
      const hosts = Object.values(data.hosts).sort((a, b) => Number(b.required) - Number(a.required) || String(a.agent).localeCompare(String(b.agent)))
      return {
        hosts,
        summary: {
          total: hosts.length,
          required: hosts.filter((h) => h.required).length,
          pending: hosts.filter((h) => h.status === 'pending').length,
          denied: hosts.filter((h) => h.status === 'denied').length,
          bypass: hosts.reduce((n, h) => n + (h.bypass?.length || 0), 0)
        },
        updatedAt: data.updatedAt
      }
    })
  }

  async accessFor (agentValue) {
    const agent = safeAgent(agentValue)
    return this._update(async (data) => {
      const host = data.hosts[agent] || { agent, status: 'pending', required: false }
      return {
        agent,
        status: host.required ? 'required' : host.status,
        required: !!host.required,
        allowed: !!host.required || host.status === 'allowed'
      }
    })
  }

  async registerHandshake (agentValue, clientInfo = {}, protocolVersion = '') {
    const agent = safeAgent(agentValue)
    return this._update(async (data) => {
      const ts = now()
      const old = data.hosts[agent]
      const required = REQUIRED.has(agent)
      const host = old || {
        agent,
        label: clientInfo.name || agent,
        required,
        status: required ? 'required' : 'pending',
        source: 'handshake',
        createdAt: ts,
        stats: emptyStats()
      }
      host.clientInfo = { name: String(clientInfo.name || '').slice(0, 100), version: String(clientInfo.version || '').slice(0, 50) }
      if (clientInfo.name && !old?.label) host.label = clientInfo.name
      host.protocolVersion = String(protocolVersion || '').slice(0, 40)
      host.lastHandshake = ts
      host.lastSeen = ts
      host.updatedAt = ts
      host.stats = { ...emptyStats(), ...(host.stats || {}) }
      let shouldPrompt = false
      if (!host.required && host.status === 'pending' && !host.consentRequestedAt) {
        host.consentRequestedAt = ts
        shouldPrompt = true
      }
      data.hosts[agent] = host
      return { host, shouldPrompt }
    })
  }

  async recordCall (agentValue, { tool = '', latencyMs = 0, ok = true, error = false } = {}) {
    const agent = safeAgent(agentValue)
    return this._update(async (data) => {
      const ts = now()
      const host = data.hosts[agent] || { agent, label: agent, required: REQUIRED.has(agent), status: REQUIRED.has(agent) ? 'required' : 'pending', source: 'handshake', createdAt: ts, stats: emptyStats() }
      const stats = { ...emptyStats(), ...(host.stats || {}) }
      stats.calls++
      if (!ok) stats.denied++
      if (error) stats.errors++
      stats.lastLatencyMs = Math.max(0, Math.round(Number(latencyMs) || 0))
      stats.totalLatencyMs = Math.max(0, Number(stats.totalLatencyMs) || 0) + stats.lastLatencyMs
      stats.lastTool = String(tool).slice(0, 120)
      stats.lastCall = ts
      host.stats = stats
      host.lastSeen = ts
      host.updatedAt = ts
      data.hosts[agent] = host
      return stats
    })
  }

  _writeHostConfig (host, content) {
    const backup = host.configPath + '.ph-backup'
    if (!existsSync(backup)) copyFileSync(host.configPath, backup)
    const tmp = host.configPath + '.ph-tmp'
    writeFileSync(tmp, content)
    renameSync(tmp, host.configPath)
    return { injected: true, setupRequired: false }
  }

  _injectCodex (host) {
    const original = readFileSync(host.configPath, 'utf8')
    const parsed = { mcpServers: Object.fromEntries(tomlServerEntries(original)) }
    if (bridgePresent(parsed)) return { injected: false, setupRequired: false }
    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const block = [
      '# 智枢数据总线：由插件在用户授权后写入',
      '[mcp_servers.person-harness]',
      'command = ' + JSON.stringify(this.nodePath),
      'args = [' + JSON.stringify(this.bridgePath) + ']',
      'enabled = true',
      'env = { PH_AGENT = ' + JSON.stringify(host.agent) + ', PH_DATA_DIR = ' + JSON.stringify(this.dir) + ' }'
    ].join(eol)
    const updated = original + (original && !original.endsWith('\n') ? eol : '') + eol + block + eol
    return this._writeHostConfig(host, updated)
  }

  _inject (host) {
    if (!host.configPath || !['json-mcpServers', 'json-opencode', 'toml-codex'].includes(host.configFormat)) return { injected: false, setupRequired: true }
    if (host.configFormat === 'toml-codex') return this._injectCodex(host)
    const config = readJson(host.configPath)
    if (!config || typeof config !== 'object') throw new Error('无法解析宿主配置：' + host.configPath)
    if (bridgePresent(config)) return { injected: false, setupRequired: false }
    if (host.configFormat === 'json-opencode') {
      // OpenCode 官方本地 MCP 结构：mcp.<name>.command 是完整 argv，环境变量放在 environment。
      config.mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {}
      config.mcp['person-harness'] = {
        type: 'local',
        command: [this.nodePath, this.bridgePath],
        enabled: true,
        environment: { PH_AGENT: host.agent, PH_DATA_DIR: this.dir }
      }
    } else {
      config.mcpServers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}
      config.mcpServers['person-harness'] = {
        command: this.nodePath,
        args: [this.bridgePath],
        env: { PH_AGENT: host.agent, PH_DATA_DIR: this.dir },
        ...(host.agent === 'copilot-cli' ? { type: 'local', tools: ['*'] } : {})
      }
    }
    return this._writeHostConfig(host, JSON.stringify(config, null, 2))
  }

  setupInfo (agentValue = 'mcp-host') {
    const agent = customAgent(agentValue)
    const config = {
      mcpServers: {
        'person-harness': {
          command: this.nodePath,
          args: [this.bridgePath],
          env: { PH_AGENT: agent, PH_DATA_DIR: this.dir }
        }
      }
    }
    return {
      agent,
      format: 'json-mcpServers',
      nodePath: this.nodePath,
      bridgePath: this.bridgePath,
      dataDir: this.dir,
      config,
      configText: JSON.stringify(config, null, 2)
    }
  }

  async registerCustomHost (agentValue, configPathValue, labelValue = '') {
    const agent = customAgent(agentValue)
    if (REQUIRED.has(agent)) throw new Error('插件所在宿主已必需接入，无需重复登记')
    const configPath = String(configPathValue || '').trim()
    if (!isAbsolute(configPath)) throw new Error('请输入宿主 JSON 配置文件的绝对路径')
    if (!/\.json$/i.test(configPath)) throw new Error('通用助手仅支持 mcpServers 格式的 JSON 配置文件')
    let config
    try {
      if (!statSync(configPath).isFile()) throw new Error('配置路径不是文件')
      config = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch (e) {
      throw new Error('无法读取或解析宿主 JSON 配置：' + e.message)
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('宿主配置根节点必须是 JSON 对象')
    if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers))) {
      throw new Error('宿主配置的 mcpServers 必须是对象')
    }
    const label = String(labelValue || '').trim().slice(0, 80) || agent
    return this._update(async (data) => {
      const ts = now()
      const old = data.hosts[agent]
      const integrated = bridgePresent(config)
      const host = old || {
        agent,
        required: false,
        status: 'pending',
        createdAt: ts,
        stats: emptyStats()
      }
      // 登记只关联配置并进入待授权；真正的写入仍由 setStatus('allowed') 完成。
      host.label = label
      host.source = 'custom'
      host.configPath = configPath
      host.configFormat = 'json-mcpServers'
      host.installable = true
      host.integrated = integrated
      host.bypass = otherServers(config)
      host.lastRegistered = ts
      host.updatedAt = ts
      if (host.status === 'allowed') host.setupRequired = !integrated
      data.hosts[agent] = host
      return { host, registered: true, setup: this.setupInfo(agent) }
    })
  }

  async setStatus (agentValue, status, options = {}) {
    const agent = safeAgent(agentValue)
    if (!['allowed', 'denied', 'pending'].includes(status)) throw new Error('未知接入状态')
    return this._update(async (data) => {
      const host = data.hosts[agent]
      if (!host) throw new Error('未知 Agent：' + agent)
      if (host.required) return { host, changed: false, injected: false }
      let injected = false
      let setupRequired = !!host.setupRequired
      if (status === 'allowed' && options.install !== false && host.configPath) {
        const r = this._inject(host)
        injected = r.injected
        setupRequired = r.setupRequired
        host.integrated = !setupRequired
      }
      host.status = status
      host.setupRequired = setupRequired
      host.updatedAt = now()
      host.lastDecision = now()
      host.decisionBy = options.by || 'owner'
      if (status === 'allowed') host.setupRequired = setupRequired
      data.hosts[agent] = host
      return { host, changed: true, injected, setupRequired }
    })
  }

  async discover () {
    const found = []
    for (const definition of this.agents) {
      for (const config of definition.configs) {
        if (!existsSync(config.path)) continue
        const parsed = readHostConfig(config.path, config.format)
        if (!parsed) continue
        found.push({ ...definition, configPath: config.path, configFormat: config.format, config: parsed })
        break
      }
    }
    const result = await this._update(async (data) => {
      const prompts = []
      for (const item of found) {
        const ts = now()
        const old = data.hosts[item.agent]
        const integrated = bridgePresent(item.config)
        const host = old || {
          agent: item.agent,
          label: item.label,
          required: false,
          status: integrated ? 'allowed' : 'pending',
          source: 'discovery',
          createdAt: ts,
          stats: emptyStats()
        }
        host.configPath = item.configPath
        host.configFormat = item.configFormat
        host.installable = ['json-mcpServers', 'json-opencode', 'toml-codex'].includes(item.configFormat)
        host.bypass = otherServers(item.config)
        host.lastDiscovered = ts
        host.updatedAt = ts
        host.integrated = integrated
        if (integrated && !old) host.status = 'allowed'
        if (host.status === 'allowed') host.setupRequired = !integrated
        if (!host.required && host.status === 'pending' && !host.consentRequestedAt) {
          host.consentRequestedAt = ts
          prompts.push(host.agent)
        }
        data.hosts[item.agent] = host
      }
      return { found: found.length, prompts }
    })
    const listing = await this.list()
    return { ...result, ...listing }
  }
}

export function spawnConsentPrompt (agent, dir) {
  if (process.env.PH_NO_PROMPT === '1' || process.platform !== 'win32') return false
  const helper = join(dirname(fileURLToPath(import.meta.url)), 'mcp-consent.mjs')
  const child = spawn(process.execPath, [helper, '--agent', safeAgent(agent), '--data-dir', dir], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return true
}
