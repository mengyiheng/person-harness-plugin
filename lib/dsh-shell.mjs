// dsh GUI 壳与 P4 协议桥之间的兼容层。
// 目标显式配置 shell: 'dsh' 后，页面/通用 API 走 dsh，会话 API 与 remote.mux 仍走目标桥。
// 这里集中消化旧桥与当前 dsh Web 契约的差异，避免四个 bridge 各自复制补丁。

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

export function usesDshShell (target, path) {
  if (target?.shell !== 'dsh') return false
  const p = String(path || '/').split('?')[0]
  // 未支持的 session 方法也必须回桥并明确报错，绝不能误操作 dsh 本体会话。
  return !p.startsWith('/api/session/')
}

function envelope (rpcId, value) {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

/** 不应从 dsh 本体读取/执行的少量能力，在本地返回稳定、诚实的空结果。 */
export function localShellRpc (target, path, body) {
  if (target?.shell !== 'dsh') return null
  const p = String(path || '').split('?')[0]
  let parsed = {}
  try { parsed = JSON.parse(Buffer.from(body || '').toString('utf8') || '{}') } catch { /* 与桥一致：坏 body 走默认 */ }
  const rpcId = parsed.rpcId
  const provider = target.name
  const model = 'default'
  if (p === '/api/session/modelCatalog') {
    return envelope(rpcId, {
      default: { provider, model },
      routableProviders: [provider],
      groups: [{ id: provider, name: target.label || target.name, models: [{ id: model, name: 'Agent 默认模型' }] }],
      failures: []
    })
  }
  if (p === '/api/session/selectModel') {
    return envelope(rpcId, { selected: { provider, model } })
  }
  if (p === '/api/session/search') return envelope(rpcId, { items: [], hasMore: false })
  if (p === '/api/session/projections') return envelope(rpcId, null)
  if (p === '/api/skills/list') return envelope(rpcId, { skills: [] })
  if (p === '/api/commands/list') return envelope(rpcId, { commands: [] })
  return null
}

export function projectionValues ({ title, cwd, blank = false, updatedAt = null }) {
  const values = {
    sessionListMetadata: { blank: !!blank, lastPromptAt: Number.isFinite(updatedAt) ? updatedAt : null }
  }
  if (title) values.title = title
  if (cwd) values.workingDirectory = cwd
  return values
}

/** 将 P4 的旧 HTTP 返回值升级为当前 dsh Web 契约；非 JSON/失败响应原样保留。 */
export function normalizeBridgeRpc (path, buffer) {
  const p = String(path || '').split('?')[0]
  if (!p.startsWith('/api/session/')) return Buffer.from(buffer)
  let msg
  try { msg = JSON.parse(Buffer.from(buffer).toString('utf8')) } catch { return Buffer.from(buffer) }
  const result = msg?.result
  if (!result?.ok || !own(result, 'value')) return Buffer.from(buffer)
  const value = result.value
  if (p === '/api/session/list' && Array.isArray(value?.items)) {
    value.items = value.items.map((old) => {
      const item = { ...old }
      const updatedAt = Number(item.updatedAt)
      item.updatedAt = Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now()
      item.blank = typeof item.blank === 'boolean' ? item.blank : false
      item.running = !!item.running
      item.agentAvailable = item.agentAvailable !== false
      if (!item.projections) {
        item.projections = {
          kind: 'cached',
          asOfSeq: 0,
          values: projectionValues({ title: item.title, cwd: item.cwd, blank: item.blank, updatedAt: item.updatedAt })
        }
      }
      return item
    })
  } else if (p === '/api/session/prompt' || p === '/api/session/approve') {
    result.value = { ...value, accepted: true }
  } else if (p === '/api/session/page' && value && typeof value === 'object') {
    result.value = { records: Array.isArray(value.records) ? value.records : [], hasMore: false, assistantStream: { revision: 0 } }
  }
  return Buffer.from(JSON.stringify(msg), 'utf8')
}

function textBlocks (value) {
  if (Array.isArray(value)) return value
  return [{ type: 'text', text: String(value || '') }]
}

/** P4 的简化事件 → 当前 dsh SessionEvent；surface 消息必须有 append 与完整 MessageBase。 */
function normalizeSessionEvent (old, state, fromSnapshot) {
  const event = { ...old }
  const data = event.data && typeof event.data === 'object' ? { ...event.data } : {}
  const oldSeq = Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : 0
  if (state && !fromSnapshot) {
    // 流式 assistant/message 会重复用旧 seq；其余 seq=0 的控制事件每次都应获得新序号。
    const key = event.type === 'assistant/message' ? `assistant:${oldSeq}` : null
    if (key && state.assistantSeqs.has(key)) event.seq = state.assistantSeqs.get(key)
    else {
      event.seq = state.nextSeq++
      if (key) state.assistantSeqs.set(key, event.seq)
    }
  } else event.seq = oldSeq
  event.time = Number.isSafeInteger(event.time) ? event.time : Date.now()
  event.data = data
  if (event.type === 'user/message') {
    data.id = data.id || `user-${event.seq}`
    data.role = 'user'
    data.content = textBlocks(data.content)
    data.source = data.source || { kind: 'user' }
    event.surfaceOp = 'append'
  } else if (event.type === 'assistant/message') {
    data.turn = Number.isSafeInteger(data.turn) ? data.turn : 1
    data.step = Number.isSafeInteger(data.step) ? data.step : 1
    data.message = data.message && typeof data.message === 'object' ? { ...data.message } : {}
    data.message.id = data.message.id || `assistant-${event.seq}`
    data.message.role = 'assistant'
    data.message.content = textBlocks(data.message.content)
    data.message.source = data.message.source || { kind: 'model', provider: 'external', model: 'default' }
    data.stream = Array.isArray(data.stream) ? data.stream : []
    event.surfaceOp = 'append'
  } else if (event.type === 'turn/start') {
    data.turn = Number.isSafeInteger(data.turn) ? data.turn : 1
  } else if (event.type === 'turn/end') {
    data.turn = Number.isSafeInteger(data.turn) ? data.turn : 1
    data.reason = data.reason || { kind: 'completed' }
  } else if (event.type === 'session/title') {
    data.messageSeqs = Array.isArray(data.messageSeqs) ? data.messageSeqs : []
    data.source = data.source || { kind: 'fallback' }
  } else if (event.type === 'approval/request') {
    event.type = 'approval/asked'
    data.id = data.id || data.reqId
    data.toolName = data.toolName || data.permission || 'Agent 操作'
    if (data.command && !data.reason) data.reason = data.command
    delete data.reqId
    delete data.permission
    delete data.command
    delete data.options
  }
  return event
}

/** 旧 follow 快照/实时事件升级为当前 dsh 契约；state 在一条 mux 上保持 seq 单调。 */
export function normalizeBridgeMux (text, state = null) {
  let msg
  try { msg = JSON.parse(text) } catch { return text }
  const value = msg?.value
  if (value?.type === 'event' && value.event) {
    value.event = normalizeSessionEvent(value.event, state, false)
    return JSON.stringify(msg)
  }
  if (value?.type !== 'snapshot') return text
  const records = Array.isArray(value.records) ? value.records : []
  const oldHeader = value.header && typeof value.header === 'object' ? value.header : {}
  const titleRecord = records.find((r) => r?.type === 'event' && r.event?.type === 'session/title')
  const title = titleRecord?.event?.data?.title
  const hasConversation = records.some((r) => r?.type === 'event' && ['user/message', 'assistant/message'].includes(r.event?.type))
  value.records = records.map((record) => record?.type === 'event' && record.event
    ? { ...record, event: normalizeSessionEvent(record.event, state, true) }
    : record)
  const maxSeq = value.records.reduce((max, record) => Math.max(max, Number(record?.event?.seq) || 0), 0)
  const cursor = Math.max(Number.isFinite(value.cursor) ? value.cursor : 0, maxSeq)
  if (state) {
    state.nextSeq = cursor + 1
    state.assistantSeqs.clear()
    for (const record of value.records) {
      if (record?.event?.type === 'assistant/message') state.assistantSeqs.set(`assistant:${record.event.seq}`, record.event.seq)
    }
  }
  value.cursor = cursor
  value.header = {
    ...oldHeader,
    version: Number.isFinite(oldHeader.version) ? oldHeader.version : 1,
    createdAt: Number.isFinite(oldHeader.createdAt) ? oldHeader.createdAt : 0,
    isSeeded: typeof oldHeader.isSeeded === 'boolean' ? oldHeader.isSeeded : false
  }
  value.hasMore = false
  value.assistantStream = value.assistantStream || { revision: 0 }
  value.projections = value.projections || {
    asOfSeq: cursor,
    values: projectionValues({ title, cwd: oldHeader.cwd, blank: !hasConversation })
  }
  return JSON.stringify(msg)
}
