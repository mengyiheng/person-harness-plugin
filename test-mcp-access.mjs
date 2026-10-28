// MCP 宿主接入：授权、发现、配置注入、旁路盘点与并发登记回归
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { McpAccessStore } from './lib/mcp-access.mjs'

const dir = join(process.cwd(), '.tmp-mcp-access-test')
const home = join(dir, 'home')
const state = join(dir, 'state')
rmSync(dir, { recursive: true, force: true })
mkdirSync(join(home, '.workbuddy'), { recursive: true })
mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
mkdirSync(join(home, '.claude'), { recursive: true })
const workbuddyConfig = join(home, '.workbuddy', 'mcp.json')
const opencodeConfig = join(home, '.config', 'opencode', 'opencode.json')
writeFileSync(workbuddyConfig, JSON.stringify({ mcpServers: { filesystem: { command: 'filesystem-server' } }, keep: true }))
writeFileSync(opencodeConfig, JSON.stringify({ mcp: { linear: { type: 'local', command: ['npx', 'linear-mcp'] } }, keep: true }))
const store = new McpAccessStore(state, { home, env: {}, bridgePath: join(dir, 'plugin', 'mcp-server.mjs') })
let pass = 0
let fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log('✅ ' + name) } catch (e) { fail++; console.log('❌ ' + name + '：' + e.message) }
}

await t('内置 dsh 与插件宿主始终为必需接入', async () => {
  const r = await store.list()
  assert.equal(r.summary.required, 3)
  assert.ok(r.hosts.every((h) => h.required && h.status === 'required'))
})
await t('必需宿主不能被设为不接入', async () => {
  const r = await store.setStatus('dsh', 'denied')
  assert.equal(r.changed, false)
  assert.equal(r.host.status, 'required')
})
await t('首次握手登记为待授权且只请求一次弹窗', async () => {
  const first = await store.registerHandshake('workbuddy', { name: 'WorkBuddy', version: '1.2.3' }, '2025-06-18')
  const second = await store.registerHandshake('workbuddy', { name: 'WorkBuddy', version: '1.2.3' }, '2025-06-18')
  assert.equal(first.host.status, 'pending')
  assert.equal(first.shouldPrompt, true)
  assert.equal(second.shouldPrompt, false)
  assert.equal(second.host.protocolVersion, '2025-06-18')
})
await t('待授权宿主不具备数据访问资格', async () => {
  assert.equal((await store.accessFor('workbuddy')).allowed, false)
})
await t('配置发现关联既有握手并盘点旁路 Server', async () => {
  const r = await store.discover()
  assert.equal(r.found, 2)
  assert.deepEqual(r.prompts, ['opencode'])
  const wb = r.hosts.find((h) => h.agent === 'workbuddy')
  const oc = r.hosts.find((h) => h.agent === 'opencode')
  assert.equal(wb.configPath, workbuddyConfig)
  assert.deepEqual(wb.bypass, ['filesystem'])
  assert.deepEqual(oc.bypass, ['linear'])
  assert.equal(r.summary.bypass, 2)
})
await t('允许后自动写入桥接配置并保留原配置备份', async () => {
  const r = await store.setStatus('workbuddy', 'allowed', { install: true, by: 'test' })
  assert.equal(r.injected, true)
  assert.equal(r.setupRequired, false)
  assert.ok(existsSync(workbuddyConfig + '.ph-backup'))
  const config = JSON.parse(readFileSync(workbuddyConfig, 'utf8'))
  assert.equal(config.keep, true)
  assert.deepEqual(config.mcpServers['person-harness'].args, [join(dir, 'plugin', 'mcp-server.mjs')])
  assert.equal(config.mcpServers['person-harness'].env.PH_AGENT, 'workbuddy')
  assert.equal(config.mcpServers['person-harness'].env.PH_DATA_DIR, state)
})
await t('重复允许不会重复写入或覆盖备份', async () => {
  const before = readFileSync(workbuddyConfig + '.ph-backup', 'utf8')
  const r = await store.setStatus('workbuddy', 'allowed', { install: true })
  assert.equal(r.injected, false)
  assert.equal(readFileSync(workbuddyConfig + '.ph-backup', 'utf8'), before)
})
await t('允许后 accessFor 放行，拒绝后立即阻断', async () => {
  assert.equal((await store.accessFor('workbuddy')).allowed, true)
  await store.setStatus('workbuddy', 'denied', { install: false })
  assert.equal((await store.accessFor('workbuddy')).allowed, false)
})
await t('OpenCode 按官方 mcp local 结构自动接入并保留备份', async () => {
  const r = await store.setStatus('opencode', 'allowed', { install: true })
  assert.equal(r.injected, true)
  assert.equal(r.setupRequired, false)
  assert.ok(existsSync(opencodeConfig + '.ph-backup'))
  const config = JSON.parse(readFileSync(opencodeConfig, 'utf8'))
  assert.equal(config.keep, true)
  assert.deepEqual(config.mcp.linear.command, ['npx', 'linear-mcp'])
  assert.deepEqual(config.mcp['person-harness'], {
    type: 'local',
    command: [process.execPath, join(dir, 'plugin', 'mcp-server.mjs')],
    enabled: true,
    environment: { PH_AGENT: 'opencode', PH_DATA_DIR: state }
  })
  const backup = readFileSync(opencodeConfig + '.ph-backup', 'utf8')
  const again = await store.setStatus('opencode', 'allowed', { install: true })
  assert.equal(again.injected, false)
  assert.equal(readFileSync(opencodeConfig + '.ph-backup', 'utf8'), backup)
  const discovered = await store.discover()
  assert.equal(discovered.hosts.find((h) => h.agent === 'opencode').integrated, true)
})
await t('调用统计分别累计拒绝、错误和延迟', async () => {
  await store.recordCall('workbuddy', { tool: 'search_local_files', latencyMs: 12.4, ok: false })
  await store.recordCall('workbuddy', { tool: 'read_local_file', latencyMs: 8, ok: true, error: true })
  const r = await store.list()
  const stats = r.hosts.find((h) => h.agent === 'workbuddy').stats
  assert.equal(stats.calls, 2)
  assert.equal(stats.denied, 1)
  assert.equal(stats.errors, 1)
  assert.equal(stats.lastLatencyMs, 8)
  assert.equal(stats.totalLatencyMs, 20)
  assert.equal(stats.lastTool, 'read_local_file')
})
await t('已配置桥的新宿主被发现时识别为已接入', async () => {
  const claudeConfig = join(home, '.claude.json')
  writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'person-harness': { command: process.execPath, args: [join(dir, 'plugin', 'mcp-server.mjs')] } } }))
  const r = await store.discover()
  const claude = r.hosts.find((h) => h.agent === 'claude-code')
  assert.equal(claude.status, 'allowed')
  assert.equal(claude.integrated, true)
  assert.equal(claude.setupRequired, false)
})
await t('Qwen、Kimi、Pi、Copilot、Cursor、Gemini 使用各自真实 JSON 路径自动接入', async () => {
  const definitions = [
    ['qwen-code', '.qwen', 'settings.json'],
    ['kimi-code', '.kimi-code', 'mcp.json'],
    ['pi', join('.pi', 'agent'), 'mcp.json'],
    ['copilot-cli', '.copilot', 'mcp-config.json'],
    ['cursor', '.cursor', 'mcp.json'],
    ['gemini-cli', '.gemini', 'settings.json']
  ]
  const paths = new Map()
  for (const [agent, folder, file] of definitions) {
    mkdirSync(join(home, folder), { recursive: true })
    const path = join(home, folder, file)
    paths.set(agent, path)
    writeFileSync(path, JSON.stringify({ keep: true, mcpServers: { other: { command: 'other-server' } } }))
  }
  const discovered = await store.discover()
  assert.equal(discovered.found, 9)
  for (const [agent] of definitions) {
    const host = discovered.hosts.find((h) => h.agent === agent)
    assert.equal(host.configPath, paths.get(agent))
    assert.equal(host.installable, true)
    assert.deepEqual(host.bypass, ['other'])
    const allowed = await store.setStatus(agent, 'allowed', { install: true })
    assert.equal(allowed.injected, true)
    const config = JSON.parse(readFileSync(paths.get(agent), 'utf8'))
    assert.equal(config.keep, true)
    assert.equal(config.mcpServers.other.command, 'other-server')
    assert.equal(config.mcpServers['person-harness'].env.PH_AGENT, agent)
    if (agent === 'copilot-cli') {
      assert.equal(config.mcpServers['person-harness'].type, 'local')
      assert.deepEqual(config.mcpServers['person-harness'].tools, ['*'])
    }
    assert.ok(existsSync(paths.get(agent) + '.ph-backup'))
  }
})
await t('Codex TOML 原文保留、追加桥接且重复授权幂等', async () => {
  mkdirSync(join(home, '.codex'), { recursive: true })
  const path = join(home, '.codex', 'config.toml')
  const original = '# 保留这条注释\r\nmodel = "gpt-test"\r\n\r\n[mcp_servers.context7]\r\ncommand = "npx"\r\nargs = ["-y", "context7-mcp"]\r\n'
  writeFileSync(path, original)
  const discovered = await store.discover()
  assert.equal(discovered.found, 10)
  const host = discovered.hosts.find((h) => h.agent === 'codex')
  assert.equal(host.configFormat, 'toml-codex')
  assert.equal(host.installable, true)
  assert.deepEqual(host.bypass, ['context7'])
  const allowed = await store.setStatus('codex', 'allowed', { install: true })
  assert.equal(allowed.injected, true)
  const updated = readFileSync(path, 'utf8')
  assert.ok(updated.startsWith(original))
  assert.ok(updated.includes('[mcp_servers.person-harness]'))
  assert.ok(updated.includes('command = ' + JSON.stringify(process.execPath)))
  assert.ok(updated.includes('args = [' + JSON.stringify(join(dir, 'plugin', 'mcp-server.mjs')) + ']'))
  assert.ok(updated.includes('PH_AGENT = "codex"'))
  assert.ok(updated.includes('PH_DATA_DIR = ' + JSON.stringify(state)))
  assert.equal(readFileSync(path + '.ph-backup', 'utf8'), original)
  const again = await store.setStatus('codex', 'allowed', { install: true })
  assert.equal(again.injected, false)
  assert.equal(readFileSync(path, 'utf8'), updated)
  const rediscovered = await store.discover()
  assert.equal(rediscovered.hosts.find((h) => h.agent === 'codex').integrated, true)
})
await t('八家宿主按官方自定义目录发现、授权注入并备份，Cursor 不误用 CURSOR_CONFIG_DIR', async () => {
  const customHome = join(dir, 'custom-home')
  const roots = Object.fromEntries(['claude', 'codex', 'copilot', 'opencode', 'kimi', 'pi', 'qwen'].map((name) => [name, join(dir, 'custom-' + name)]))
  const env = {
    CLAUDE_CONFIG_DIR: roots.claude,
    CODEX_HOME: roots.codex,
    COPILOT_HOME: roots.copilot,
    OPENCODE_CONFIG: join(roots.opencode, 'custom.json'),
    KIMI_CODE_HOME: roots.kimi,
    PI_CODING_AGENT_DIR: roots.pi,
    QWEN_HOME: roots.qwen,
    CURSOR_CONFIG_DIR: join(dir, 'must-not-be-used-for-mcp')
  }
  const files = [
    ['claude-code', roots.claude, '.claude.json', 'json'],
    ['codex', roots.codex, 'config.toml', 'toml'],
    ['copilot-cli', roots.copilot, 'mcp-config.json', 'json'],
    ['opencode', roots.opencode, 'custom.json', 'opencode'],
    ['kimi-code', roots.kimi, 'mcp.json', 'json'],
    ['pi', roots.pi, 'mcp.json', 'json'],
    ['qwen-code', roots.qwen, 'settings.json', 'json'],
    ['cursor', join(customHome, '.cursor'), 'mcp.json', 'json']
  ]
  for (const [, folder, file, format] of files) {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, file), format === 'toml' ? '[mcp_servers.other]\ncommand = "other-server"\n' : JSON.stringify(format === 'opencode' ? { mcp: {} } : { mcpServers: {} }))
  }
  const custom = new McpAccessStore(join(dir, 'custom-state'), { home: customHome, env, bridgePath: join(dir, 'plugin', 'mcp-server.mjs') })
  const discovered = await custom.discover()
  assert.equal(discovered.found, 8)
  for (const [agent, folder, file] of files) {
    const path = join(folder, file)
    assert.equal(discovered.hosts.find((h) => h.agent === agent)?.configPath, path)
    const allowed = await custom.setStatus(agent, 'allowed', { install: true })
    assert.equal(allowed.injected, true, agent + ' 应完成授权注入')
    assert.ok(existsSync(path + '.ph-backup'), agent + ' 应保留配置备份')
    const integrated = await custom.discover()
    assert.equal(integrated.hosts.find((h) => h.agent === agent)?.integrated, true, agent + ' 应识别为已接入')
  }
})
await t('并发握手与调用登记不会丢失宿主或调用数', async () => {
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.registerHandshake('agent-' + i, { name: 'Agent ' + i })))
  await Promise.all(Array.from({ length: 12 }, () => store.recordCall('agent-0', { tool: 'tools/list', latencyMs: 1 })))
  const r = await store.list()
  assert.equal(r.summary.total, 21)
  assert.equal(r.hosts.find((h) => h.agent === 'agent-0').stats.calls, 12)
})
await t('未知宿主不能被 UI 直接改写授权状态', async () => {
  await assert.rejects(() => store.setStatus('not-registered', 'allowed'), /未知 Agent/)
})

const assistantDir = join(dir, 'assistant')
const assistantState = join(assistantDir, 'state')
const assistantConfig = join(assistantDir, 'unknown-host.json')
mkdirSync(assistantDir, { recursive: true })
const assistant = new McpAccessStore(assistantState, { home: assistantDir, env: {}, bridgePath: join(assistantDir, 'plugin', 'mcp-server.mjs') })
await t('通用助手生成真实 Node、桥接、数据目录与标准 JSON', async () => {
  const setup = assistant.setupInfo('WorkBuddy')
  assert.equal(setup.agent, 'workbuddy')
  assert.equal(setup.nodePath, process.execPath)
  assert.equal(setup.bridgePath, join(assistantDir, 'plugin', 'mcp-server.mjs'))
  assert.equal(setup.dataDir, assistantState)
  assert.deepEqual(JSON.parse(setup.configText), setup.config)
  assert.deepEqual(setup.config.mcpServers['person-harness'].args, [setup.bridgePath])
  assert.equal(setup.config.mcpServers['person-harness'].env.PH_AGENT, 'workbuddy')
  assert.equal(setup.config.mcpServers['person-harness'].env.PH_DATA_DIR, assistantState)
})
await t('自定义 JSON 宿主先登记待授权且绝不提前写配置', async () => {
  const original = JSON.stringify({ keep: true, mcpServers: { other: { command: 'other-server' } } }, null, 2)
  writeFileSync(assistantConfig, original)
  const r = await assistant.registerCustomHost('My-Agent', assistantConfig, '我的 MCP 宿主')
  assert.equal(r.host.agent, 'my-agent')
  assert.equal(r.host.label, '我的 MCP 宿主')
  assert.equal(r.host.status, 'pending')
  assert.equal(r.host.source, 'custom')
  assert.equal(r.host.configFormat, 'json-mcpServers')
  assert.deepEqual(r.host.bypass, ['other'])
  assert.equal(readFileSync(assistantConfig, 'utf8'), original)
  assert.equal(existsSync(assistantConfig + '.ph-backup'), false)
  assert.equal((await assistant.accessFor('my-agent')).allowed, false)
})
await t('自定义宿主明确允许后才写入、备份且重复操作幂等', async () => {
  const r = await assistant.setStatus('my-agent', 'allowed', { install: true, by: 'test' })
  assert.equal(r.injected, true)
  assert.equal(r.host.integrated, true)
  assert.ok(existsSync(assistantConfig + '.ph-backup'))
  const updated = JSON.parse(readFileSync(assistantConfig, 'utf8'))
  assert.equal(updated.keep, true)
  assert.equal(updated.mcpServers.other.command, 'other-server')
  assert.equal(updated.mcpServers['person-harness'].env.PH_AGENT, 'my-agent')
  assert.equal((await assistant.accessFor('my-agent')).allowed, true)
  const before = readFileSync(assistantConfig, 'utf8')
  const again = await assistant.setStatus('my-agent', 'allowed', { install: true })
  assert.equal(again.injected, false)
  assert.equal(readFileSync(assistantConfig, 'utf8'), before)
  const registered = await assistant.registerCustomHost('my-agent', assistantConfig)
  assert.equal(registered.host.status, 'allowed')
  assert.equal(registered.host.integrated, true)
})
await t('通用助手拒绝非法标识、相对路径和无效 JSON 配置', async () => {
  const invalidJson = join(assistantDir, 'invalid.json')
  const invalidShape = join(assistantDir, 'invalid-shape.json')
  const textFile = join(assistantDir, 'config.txt')
  writeFileSync(invalidJson, '{bad')
  writeFileSync(invalidShape, JSON.stringify({ mcpServers: [] }))
  writeFileSync(textFile, '{}')
  assert.throws(() => assistant.setupInfo('bad agent'), /Agent 标识/)
  await assert.rejects(() => assistant.registerCustomHost('bad agent', assistantConfig), /Agent 标识/)
  await assert.rejects(() => assistant.registerCustomHost('relative-host', 'relative.json'), /绝对路径/)
  await assert.rejects(() => assistant.registerCustomHost('missing-host', join(assistantDir, 'missing.json')), /无法读取或解析/)
  await assert.rejects(() => assistant.registerCustomHost('text-host', textFile), /JSON 配置文件/)
  await assert.rejects(() => assistant.registerCustomHost('invalid-host', invalidJson), /无法读取或解析/)
  await assert.rejects(() => assistant.registerCustomHost('shape-host', invalidShape), /mcpServers 必须是对象/)
  await assert.rejects(() => assistant.registerCustomHost('dsh', assistantConfig), /无需重复登记/)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n结果：${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
