// Claude Code 官方 Agent SDK 驱动。测试可通过 sdkModule 注入模拟 SDK，不触发真实模型。
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function inputChannel () {
  const values = []
  const waiters = []
  let closed = false
  return {
    push (value) {
      if (closed) throw new Error('Claude 输入通道已关闭')
      const waiter = waiters.shift()
      if (waiter) waiter({ value, done: false }); else values.push(value)
    },
    close () {
      closed = true
      for (const resolve of waiters.splice(0)) resolve({ value: undefined, done: true })
    },
    iterable: {
      [Symbol.asyncIterator] () {
        return {
          next: async () => {
            if (values.length) return { value: values.shift(), done: false }
            if (closed) return { value: undefined, done: true }
            return new Promise((resolve) => waiters.push(resolve))
          }
        }
      }
    }
  }
}
const messageText = (message) => (Array.isArray(message?.content) ? message.content : [])
  .filter((block) => block?.type === 'text').map((block) => block.text || '').join('')

export function createClaudeDriver ({ cwd, sdkModule = '@anthropic-ai/claude-agent-sdk', executable, configuredModels = [], defaultModel = 'default', env = process.env }) {
  const sessions = new Map()
  let hooks
  let sdkPromise
  const loadSdk = () => {
    if (!sdkPromise) {
      const specifier = sdkModule.includes('://') || sdkModule.startsWith('@')
        ? sdkModule
        : pathToFileURL(path.resolve(sdkModule)).href
      sdkPromise = import(specifier)
    }
    return sdkPromise
  }
  async function ensure (sid, model = defaultModel) {
    if (sessions.has(sid)) return sessions.get(sid)
    const sdk = await loadSdk()
    const input = inputChannel()
    const state = { sid, input, q: null, currentText: '', mid: '', finalized: true, model }
    const meta = hooks.getSession(sid)?.meta || {}
    const nativeId = meta.nativeId
    const canUseTool = (toolName, toolInput, context) => new Promise((resolve) => {
      const reqId = context?.toolUseID || `claude-${Date.now()}-${Math.random()}`
      let settled = false
      const finish = (allow, message) => {
        if (settled) return
        settled = true
        resolve(allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: message || '用户拒绝或审批已取消' })
      }
      context?.signal?.addEventListener('abort', () => finish(false, '审批已取消'), { once: true })
      hooks.approval(sid, {
        id: reqId,
        permission: toolName,
        command: JSON.stringify(toolInput, null, 2).slice(0, 6000),
        options: [{ optionId: 'once', label: '批准一次', kind: 'allow_once' }, { optionId: 'reject', label: '拒绝', kind: 'reject_once' }],
        respond: async (choice) => finish(choice.optionId === 'once' && !choice.cancelled)
      })
    })
    const options = {
      cwd: meta.cwd || cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      canUseTool,
      env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'person-harness' }
    }
    if (nativeId) options.resume = nativeId; else options.sessionId = sid
    if (model && model !== 'default') options.model = model
    if (executable) options.pathToClaudeCodeExecutable = executable
    const q = sdk.query({ prompt: input.iterable, options })
    state.q = q
    sessions.set(sid, state)
    state.run = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === 'system' && msg.session_id) {
            state.nativeId = msg.session_id
            hooks.nativeSession(sid, msg.session_id)
          } else if (msg.type === 'stream_event') {
            const delta = msg.event?.delta
            if (msg.event?.type === 'content_block_delta' && delta?.type === 'text_delta') {
              state.mid = msg.uuid || state.mid || 'live'
              state.currentText += delta.text || ''
              state.finalized = false
              hooks.text(sid, state.mid, state.currentText)
            }
          } else if (msg.type === 'assistant') {
            const value = messageText(msg.message)
            if (value) {
              state.mid = msg.uuid || state.mid || 'assistant-' + Date.now()
              state.currentText = value
              state.finalized = true
              hooks.text(sid, state.mid, value, true)
            }
          } else if (msg.type === 'result') {
            if (state.currentText && !state.finalized) hooks.text(sid, state.mid || 'live', state.currentText, true)
            state.currentText = ''
            state.finalized = true
            const failed = msg.is_error || msg.subtype === 'error_during_execution'
            hooks.end(sid, failed ? new Error(msg.result || 'Claude 执行失败') : null)
          }
        }
      } catch (error) {
        hooks.end(sid, error)
      }
    })()
    return state
  }
  return {
    capabilities: {
      transport: '@anthropic-ai/claude-agent-sdk', newSession: true, resumeSession: true,
      streaming: true, cancellation: 'interrupt', models: 'supportedModels/setModel',
      approvals: 'canUseTool:once/reject', dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      if (!sid) return { items: [{ id: 'default', name: 'Claude 默认模型' }], selected: selected || 'default' }
      const state = await ensure(sid, selected)
      const native = await state.q.supportedModels()
      const items = (native || []).map((m) => ({ id: m.value || m.id || m.model, name: m.displayName || m.name || m.value || m.id, description: m.description || '' })).filter((m) => m.id)
      if (!items.length) for (const id of configuredModels) items.push({ id, name: id })
      if (!items.length) items.push({ id: 'default', name: 'Claude 默认模型' })
      return { items, selected: selected || items[0].id }
    },
    async selectModel (sid, model) {
      const state = await ensure(sid, model)
      await state.q.setModel(model === 'default' ? undefined : model)
      state.model = model
    },
    async prompt (sid, text, model) {
      const state = await ensure(sid, model)
      if (model && model !== state.model) await state.q.setModel(model === 'default' ? undefined : model)
      state.model = model
      state.currentText = ''
      state.finalized = true
      state.input.push({
        type: 'user', session_id: state.nativeId || sid, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] }
      })
    },
    async cancel (sid) { if (sessions.has(sid)) await sessions.get(sid).q.interrupt() },
    close () {
      for (const state of sessions.values()) { state.input.close(); state.q.close() }
      sessions.clear()
    }
  }
}
