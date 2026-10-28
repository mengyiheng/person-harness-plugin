// 数据总线监测台：真实 DataBus 快照 + 无依赖浏览器脚本接线回归
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DataBus } from './lib/data-bus.mjs'
import { databusHtml } from './lib/databus-ui.mjs'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log('✅ ' + name) } catch (e) { fail++; console.log('❌ ' + name + '：' + e.message) }
}

const dir = join(process.cwd(), '.tmp-databus-ui-test')
rmSync(dir, { recursive: true, force: true })
const docs = join(dir, 'docs')
mkdirSync(docs, { recursive: true })
writeFileSync(join(docs, 'notes.md'), 'hello databus')
writeFileSync(join(docs, '.env'), 'API_KEY=test')
const bus = new DataBus(join(dir, 'state'))
bus.addSource(docs)
await bus.scan()
for (let i = 0; i < 12; i++) bus.recordAccess('codex', 'read', join(docs, 'notes.md'), true)
bus.recordAccess('auditor', 'read', join(docs, '.env'), true)
const monitor = bus.monitor()

t('监测快照：目录与文件总数', () => assert.equal(monitor.sources, 1) || assert.equal(monitor.total, 2))
t('监测快照：分级与待复核', () => assert.equal(monitor.byLevel.sensitive, 1) || assert.equal(monitor.byLevel.internal, 1) || assert.equal(monitor.uncertain, 1))
t('监测快照：扫描与监听状态', () => assert.equal(monitor.scanning, false) || assert.equal(monitor.watching, 0) || assert.ok(monitor.lastScan))
t('监测快照：本地存储体积', () => assert.ok(monitor.storage.indexBytes > 0) || assert.ok(monitor.storage.accessBytes > 0))
t('台账：同毫秒事件不再被折叠', () => assert.ok(bus.allAccessEntries().filter((a) => a.agent === 'codex').length >= 12))
t('周报：安全提醒按 time 字段统计', () => assert.ok(bus.weeklyReport(7).alerts.high >= 1))
bus.stopWatch()
rmSync(dir, { recursive: true, force: true })

const html = databusHtml()
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
t('页面：包含七个功能视图', () => assert.equal((html.match(/class="tab[ "]/g) || []).length, 7))
t('页面：采用官网品牌 Hero 与统一配色', () => assert.ok(html.includes('PERSON HARNESS · LOCAL DATA BUS') && html.includes('智枢 MCP 数据总线') && html.includes('--mint:#63ddc7') && html.includes('--blue:#527df5') && html.includes('--dark:#090e18') && html.includes('--bg:#f6f7f9')))
t('页面：官网风格保留响应式布局与原有操作', () => assert.ok(html.includes('@media(max-width:620px)') && html.includes('class="topbar"') && html.includes('id="scanBtn"') && html.includes('id="refreshBtn"')))
t('页面：包含独立 Agent 与 MCP 宿主分组、授权和重检', () => assert.ok(html.includes('id="agentHosts"') && html.includes('id="mcpHosts"') && html.includes('独立 Agent') && html.includes('MCP 宿主') && html.includes("api('mcp/discover')") && html.includes('已发现') && html.includes('不等于')))
t('页面：包含通用助手、配置复制、自定义登记和状态检查', () => assert.ok(html.includes('id="mcpSetupJson"') && html.includes('id="mcpConfigPath"') && html.includes('copyMcpConfig()') && html.includes("api('mcp/register'") && html.includes("api('mcp/setup'") && html.includes('checkMcpConnection()')))
t('页面：包含监测指标与自动刷新', () => assert.ok(html.includes('id="runtime"') && html.includes('id="autoRefresh"') && html.includes("api('monitor')")))
t('页面：浏览器脚本语法有效', () => new Function(script))
t('页面：动态内容统一转义', () => assert.ok(script.includes('const esc =') && !script.includes("a.msg+'</div>")))

const elements = {}
const makeClassList = (initial = '') => {
  const values = new Set(initial.split(/\s+/).filter(Boolean))
  return { toggle: (name, on) => { if (on) values.add(name); else values.delete(name) }, contains: (name) => values.has(name), toString: () => [...values].join(' ') }
}
const makeElement = (id, className = '') => ({ id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, style: {}, dataset: {}, className, classList: makeClassList(className), selectedOptions: [] })
for (const m of html.matchAll(/id="([^"]+)"/g)) elements[m[1]] = makeElement(m[1])
elements.mcpAgent.value = 'workbuddy'
const tabs = [...html.matchAll(/class="tab([^"]*)" data-tab="([^"]+)"/g)].map((m) => { const e = makeElement('tab-' + m[2], 'tab' + m[1]); e.dataset.tab = m[2]; return e })
const panels = [...html.matchAll(/class="panel([^"]*)" id="tab-([^"]+)"/g)].map((m) => makeElement('tab-' + m[2], 'panel' + m[1]))
const document = {
  hidden: false,
  getElementById: (id) => elements[id] || (elements[id] = makeElement(id)),
  querySelectorAll: (selector) => selector === '.tab' ? tabs : selector === '.panel' ? panels : []
}
const state = {
  monitor: { sources: 1, total: 2, uncertain: 1, scanning: false, watching: 1, lastScan: Date.now(), byLevel: { public: 0, internal: 1, sensitive: 1, restricted: 0 }, storage: { indexBytes: 2048, accessBytes: 1024 } },
  alerts: [{ level: 'high', msg: '<敏感> 被读取', time: Date.now(), path: 'D:\\secret.env' }],
  access: [{ time: '10/28 12:00:00', agent: '<codex>', ev: 'read', path: 'D:\\notes.md', ok: true }],
  policy: { agents: { '*': ['public', 'internal'] }, dirs: [{ path: 'D:\\docs', agent: 'auditor', levels: ['public', 'internal', 'sensitive'] }] },
  mcp: {
    hosts: [
      { agent: 'dsh', label: 'dsh（插件所在宿主）', required: true, status: 'required', source: 'builtin', stats: { calls: 4 } },
      { agent: 'kimi-code', label: 'Kimi Code', status: 'allowed', source: 'discovery', stats: { calls: 1 } },
      { agent: 'workbuddy', label: '<WorkBuddy>', status: 'pending', source: 'handshake', lastHandshake: Date.now(), stats: { calls: 2, denied: 1, errors: 0, lastTool: 'search_local_files', lastLatencyMs: 3 } },
      { agent: 'openclaw', label: 'OpenClaw', status: 'denied', source: 'discovery', bypass: ['<filesystem>'], configPath: 'D:\\openclaw.json', stats: {} }
    ],
    summary: { total: 4, required: 1, pending: 1, denied: 1, bypass: 1 }
  }
}
const actions = []
const consents = []
const registrations = []
const clipboard = []
const remote = []
const respond = (body) => ({ ok: true, status: 200, json: async () => body })
const setupFor = (agent) => {
  const config = { mcpServers: { 'person-harness': { command: 'D:\\node.exe', args: ['D:\\plugin\\mcp-server.mjs'], env: { PH_AGENT: agent, PH_DATA_DIR: 'D:\\state' } } } }
  return { agent, nodePath: 'D:\\node.exe', bridgePath: 'D:\\plugin\\mcp-server.mjs', dataDir: 'D:\\state', config, configText: JSON.stringify(config, null, 2) }
}
const fetch = async (url, opts = {}) => {
  if (url.includes('/__ph/file/get')) { remote.push('get'); return respond({ name: 'a.txt', size: 3, b64: Buffer.from('abc').toString('base64') }) }
  if (url.includes('/__ph/file/put')) { remote.push('put'); return respond({ ok: true, savedTo: 'D:\\inbox\\a.txt', size: 3 }) }
  const body = JSON.parse(opts.body || '{}')
  actions.push(body.action)
  switch (body.action) {
    case 'monitor': return respond({ monitor: state.monitor })
    case 'mcp/hosts': return respond(state.mcp)
    case 'mcp/discover': return respond({ ...state.mcp, found: 2, prompts: [] })
    case 'mcp/setup': return respond(setupFor(body.agent))
    case 'mcp/register': registrations.push({ agent: body.agent, path: body.path, label: body.label }); return respond({ host: { agent: body.agent, status: 'pending' }, registered: true, setup: setupFor(body.agent) })
    case 'mcp/consent': consents.push({ agent: body.agent, status: body.status }); return respond({ host: {}, changed: true, injected: body.agent === 'workbuddy', setupRequired: false })
    case 'alerts': return respond({ alerts: state.alerts })
    case 'access': return respond({ items: state.access })
    case 'sources': return respond({ sources: [{ path: 'D:\\docs', files: 2, lastScan: '2026/10/28 12:00:00' }] })
    case 'sources/add': return respond({ ok: true })
    case 'sources/remove': return respond({ ok: true })
    case 'uncertain': return respond({ total: 1, items: [{ id: 'D:\\notes.md', name: 'notes.md', ext: 'md', kb: 1, dir: 'docs' }] })
    case 'setlevel': return respond({ ok: true })
    case 'policy': return respond(state.policy)
    case 'policy/set': return respond({ ok: true })
    case 'policy/setdir': return respond({ ok: true })
    case 'policy/deldir': return respond({ ok: true })
    case 'search': return respond({ results: [{ name: '<报告>.md', path: 'D:\\<报告>.md', level: 'internal', size: 12, hits: body.content ? [{ line: 1, context: '<命中>' }] : null }] })
    case 'read': return respond({ content: '<hello>&' })
    case 'scan': return respond({ result: { total: 2, changed: 1 } })
    default: return respond({ error: 'unknown action: ' + body.action })
  }
}
const context = {
  document,
  fetch,
  console,
  navigator: { clipboard: { writeText: async (text) => clipboard.push(text) } },
  location: { pathname: '/api/ph-databus' },
  localStorage: { getItem: () => JSON.stringify([{ key: 'self', name: '本机' }, { key: 'peer', name: '对端' }]) },
  confirm: () => true,
  prompt: () => '0',
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1
}
vm.createContext(context)
vm.runInContext(script, context)
await context.refresh()

t('总览：真实监测数据完成渲染', () => assert.equal(elements.metricFiles.textContent, '2') || assert.equal(elements.metricSources.textContent, '1') || assert.match(elements.runtime.innerHTML, /已开启/))
t('总览：高风险状态与提醒可见', () => assert.match(elements.serviceText.textContent, /高风险/) || assert.match(elements.overviewAlerts.innerHTML, /&lt;敏感&gt;/))
t('总览：访问流水动态内容被转义', () => assert.ok(elements.overviewAccess.innerHTML.includes('&lt;codex&gt;') && !elements.overviewAccess.innerHTML.includes('<codex>')))
t('导航：页签切换更新激活状态', () => { context.setTab('search'); assert.ok(tabs.find((x) => x.dataset.tab === 'search').classList.contains('active')) })
t('MCP：汇总、必需宿主与调用统计可见', () => assert.equal(elements.mcpPending.textContent, '1') || assert.equal(elements.mcpRequired.textContent, '1') || assert.ok(elements.mcpHosts.innerHTML.includes('不可关闭') && elements.mcpHosts.innerHTML.includes('search_local_files')))
t('MCP：独立 Agent 与其他 MCP 宿主分组且不重复', () => assert.ok(elements.agentHosts.innerHTML.includes('Kimi Code') && !elements.agentHosts.innerHTML.includes('WorkBuddy') && elements.mcpHosts.innerHTML.includes('WorkBuddy') && !elements.mcpHosts.innerHTML.includes('Kimi Code')))
t('MCP：宿主和旁路 Server 动态内容被转义', () => assert.ok(elements.mcpHosts.innerHTML.includes('&lt;WorkBuddy&gt;') && elements.mcpBypass.innerHTML.includes('&lt;filesystem&gt;') && !elements.mcpBypass.innerHTML.includes('<filesystem>')))
t('通用助手：初始配置与真实桥接路径完成渲染', () => assert.ok(elements.mcpSetupJson.value.includes('workbuddy') && elements.mcpSetupJson.value.includes('mcp-server.mjs') && elements.mcpBridgePath.textContent.includes('mcp-server.mjs')))
await context.copyMcpConfig()
t('通用助手：复制配置使用完整 JSON', () => assert.ok(clipboard.length === 1 && clipboard[0] === elements.mcpSetupJson.value))
elements.mcpAgent.value = 'new-host'
await context.generateMcpSetup()
t('通用助手：按宿主标识重新生成配置', () => assert.ok(elements.mcpSetupJson.value.includes('new-host') && elements.mcpSetupBtn.disabled === false))
elements.mcpConfigPath.value = 'D:\\unknown\\mcp.json'
await context.registerCustomMcpHost()
t('通用助手：自定义宿主登记调用正确 API', () => assert.deepEqual(registrations, [{ agent: 'new-host', path: 'D:\\unknown\\mcp.json', label: 'new-host' }]) || assert.equal(elements.mcpRegisterBtn.disabled, false))
elements.mcpAgent.value = 'workbuddy'
await context.checkMcpConnection()
t('通用助手：状态检查区分待授权且恢复按钮', () => assert.match(elements.mcpSetupState.textContent, /待授权/) || assert.equal(elements.mcpCheckBtn.disabled, false))
await context.setMcpStatus('workbuddy', 'allowed')
await context.setMcpStatus('workbuddy', 'denied')
t('MCP：允许与不接入操作调用授权 API', () => assert.deepEqual(consents, [{ agent: 'workbuddy', status: 'allowed' }, { agent: 'workbuddy', status: 'denied' }]))
await context.discoverMcp()
t('MCP：重新检测后恢复按钮并刷新列表', () => assert.ok(actions.includes('mcp/discover') && actions.includes('mcp/hosts')) || assert.equal(elements.mcpDiscoverBtn.disabled, false) || assert.equal(elements.mcpDiscoverBtn.textContent, '重新检测'))
elements.q.value = '报告'
await context.doSearch()
t('检索：请求与结果渲染正确', () => assert.ok(actions.includes('search') && elements.results.innerHTML.includes('&lt;报告&gt;.md') && !elements.results.innerHTML.includes('<报告>.md')))
await context.preview('D:\\notes.md')
t('预览：正文安全转义并显示', () => assert.equal(elements.preview.style.display, 'block') || assert.ok(elements.preview.innerHTML.includes('&lt;hello&gt;&amp;')))
elements.newsrc.value = 'D:\\new-docs'
await context.addSrc()
t('目录：添加后清空输入并刷新', () => assert.ok(actions.includes('sources/add')) || assert.equal(elements.newsrc.value, ''))
await context.delSrc('D:\\new-docs')
t('目录：移除调用既有 API', () => assert.ok(actions.includes('sources/remove')))
await context.setLv('D:\\notes.md', 'sensitive')
t('复核：手工分级调用并刷新', () => assert.ok(actions.includes('setlevel')))
elements.ag.value = 'auditor'
elements.lvs.selectedOptions = [{ value: 'public' }, { value: 'sensitive' }]
await context.setPol()
t('策略：Agent 默认策略保存', () => assert.ok(actions.includes('policy/set')) || assert.equal(elements.ag.value, ''))
elements.dirPath.value = 'D:\\docs'
elements.dirAgent.value = 'auditor'
elements.dirLevels.selectedOptions = [{ value: 'internal' }]
await context.setDirPol()
t('策略：目录覆盖策略保存', () => assert.ok(actions.includes('policy/setdir')))
await context.delDirPol('D:\\docs', 'auditor')
t('策略：目录覆盖策略删除', () => assert.ok(actions.includes('policy/deldir')))
await context.loadAudit()
t('审计：提醒与 50 条台账渲染', () => assert.ok(elements.alerts.innerHTML.includes('&lt;敏感&gt;') && elements.access.innerHTML.includes('<table>')))
await context.doScan()
t('扫描：完成后恢复按钮并刷新', () => assert.ok(actions.includes('scan')) || assert.equal(elements.scanBtn.disabled, false) || assert.equal(elements.scanBtn.textContent, '重新扫描'))
context.location.pathname = '/r/self/api/ph-databus'
await context.ferry('D:\\folder\\a.txt')
t('跨机传输：读取与推送链路完整', () => assert.deepEqual(remote, ['get', 'put']))

console.log(`\n结果：${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
