#!/usr/bin/env node
// 数据总线 · MCP 标准桥（M3）——任何 MCP 宿主加一段配置即可检索本机资料
// 架构：本脚本作为宿主的子进程（stdio JSON-RPC，MCP 2024-11-05），与插件共享同一份
// 索引/策略/台账文件（调用前 syncFromDisk）——记录不靠事后收集，靠"路只有一条"。
// 身份：env HAPPY_AGENT 声明 agent 名（未声明=mcp-unknown，默认只有 公开/内部 级）。
// 零外部依赖；stdin/stdout 按行分隔 JSON-RPC 2.0。
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DataBus, LEVEL_LABEL } from './data-bus.mjs'

const AGENT = String(process.env.HAPPY_AGENT || 'mcp-unknown')
const DATA_DIR = process.env.HAPPY_DATA_DIR || join(homedir(), '.dsh', 'happy-harness', process.env.HAPPY_PROFILE || 'web')
const bus = new DataBus(DATA_DIR)
const RESCAN_MS = 10 * 60 * 1000
let lastScan = 0

async function freshen () {
  bus.syncFromDisk()
  if (!bus.state.sources.length) bus.defaultSources()
  if (Date.now() - lastScan > RESCAN_MS) {
    lastScan = Date.now()
    try { await bus.scan() } catch (e) { /* 插件可能正在扫（skipped），下轮再试 */ }
  }
}

const lv = (l) => LEVEL_LABEL[l] || l
const fmtHit = (f) => `- \`${f.name}\`（${lv(f.level)} · ${Math.max(1, Math.round(f.size / 1024))}KB）\n  \`${f.path}\``
const fmtContent = (f) => `- \`${f.name}\`（${lv(f.level)}）\n  \`${f.path}\`` +
  (f.hits || []).map((h) => `\n  L${h.line}: ${h.context.replaceAll('\n', ' ⏎ ').slice(0, 200)}`).join('')

const TOOLS = [
  {
    name: 'search_local_files',
    description: '在用户本机监控目录中检索文件（按名或正文）。支持语法：ext:png,pdf days:7 size:>10mb path:文档；content=true 时搜文件正文并返回命中行上下文。结果遵守用户的数据分级策略（敏感/禁碰内容可能不可见）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，可含 ext:/days:/size:/path: 语法' },
        content: { type: 'boolean', description: 'true=检索文件正文（默认 false 按文件名）' },
        limit: { type: 'number', description: '最多返回条数（默认 10，上限 50）' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_local_file',
    description: '读取本机某个文件的内容（≤64KB，须为索引内文件且级别在当前 agent 策略允许内）。先用 search_local_files 找到路径。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件完整路径（来自检索结果）' } },
      required: ['path']
    }
  }
]

async function callTool (name, args = {}) {
  await freshen()
  if (name === 'search_local_files') {
    const q = String(args.query || '')
    const limit = Number(args.limit) || 10
    const results = args.content ? bus.searchContent(q, { limit, agent: AGENT }) : bus.search(q, { limit, agent: AGENT })
    bus.recordAccess(AGENT, 'search', q, true, { hits: results.length })
    for (const f of results.slice(0, 20)) bus.recordAccess(AGENT, 'hit', f.path, true)
    const body = results.length
      ? results.map(args.content ? fmtContent : fmtHit).join('\n')
      : `无命中（当前 agent「${AGENT}」允许级别：${bus.allowedFor(AGENT).map(lv).join('/')}；可用语法 ext:/days:/size:/path:）`
    return { content: [{ type: 'text', text: body }] }
  }
  if (name === 'read_local_file') {
    const r = bus.read(String(args.path || ''), { agent: AGENT })
    bus.recordAccess(AGENT, 'read', String(args.path || ''), !r.error)
    if (r.error) return { content: [{ type: 'text', text: '读取失败：' + r.error }], isError: true }
    return { content: [{ type: 'text', text: r.content }] }
  }
  return { content: [{ type: 'text', text: '未知工具: ' + name }], isError: true }
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch (e) { return }
  if (!msg || msg.jsonrpc !== '2.0' || msg.id === undefined) return // notification：无需回复
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'happy-harness-data-bus', version: '1.0.0' }
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    callTool(String(params?.name || ''), params?.arguments || {})
      .then((r) => reply(id, r))
      .catch((e) => reply(id, { content: [{ type: 'text', text: '执行失败: ' + (e?.message ?? e) }], isError: true }))
    return
  }
  reply(id, { error: { code: -32601, message: 'method not found: ' + method } })
})
// 宿主关闭 stdin = 退出
rl.on('close', () => process.exit(0))
// 日志走 stderr（stdout 是协议通道，不能污染）
console.error(`[happy-mcp] 数据总线 MCP 桥就绪 · agent=${AGENT} · 数据目录=${DATA_DIR}`)
