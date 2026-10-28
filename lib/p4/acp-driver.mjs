// 通用 ACP v1 驱动：Kimi/Qwen/Cursor 等只提供启动命令，不复制页面和会话桥。
import { AcpClient } from './acp-client.mjs'

export function createAcpDriver ({ command, args = [], cwd, env = process.env, log = () => {} }) {
  let hooks
  let clientPromise
  let initialized
  const sessions = new Map()
  const nativeToLocal = new Map()
  const modelsShape = (result, selected) => {
    const source = result?.models
    const items = (source?.availableModels || []).map((m) => ({
      id: m.modelId || m.id, name: m.name || m.modelId || m.id, description: m.description || ''
    })).filter((m) => m.id)
    return { items, selected: source?.currentModelId || selected || items[0]?.id || 'default' }
  }
  async function ensureClient () {
    if (!clientPromise) {
      clientPromise = (async () => {
        const client = new AcpClient({
          command, args, cwd, env, log,
          onNotification: (msg) => onNotification(client, msg),
          onRequest: (msg) => onRequest(client, msg)
        })
        initialized = await client.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'person-harness', title: 'Person Harness', version: '0.1.0' }
        })
        return client
      })()
      clientPromise.catch(() => { clientPromise = null })
    }
    return clientPromise
  }
  function onNotification (client, msg) {
    if (msg.method !== 'session/update') return
    const sid = nativeToLocal.get(msg.params?.sessionId)
    const state = sessions.get(sid)
    if (!state || state.loading) return
    const update = msg.params.update || {}
    if (update.sessionUpdate === 'agent_message_chunk') {
      const value = update.content?.type === 'text' ? update.content.text : ''
      if (!value) return
      state.currentText += value
      state.final = false
      hooks.text(sid, state.turnId, state.currentText)
    } else if (update.sessionUpdate === 'session_info_update' && update.title) {
      hooks.title(sid, update.title)
    } else if (update.sessionUpdate === 'current_model_update') {
      state.model = update.currentModelId
    }
  }
  function onRequest (client, msg) {
    if (msg.method !== 'session/request_permission') {
      client.respondError(msg.id, -32601, 'Person Harness 未实现该 ACP 客户端方法: ' + msg.method)
      return
    }
    const sid = nativeToLocal.get(msg.params?.sessionId)
    if (!sid) {
      client.respond(msg.id, { outcome: { outcome: 'cancelled' } })
      return
    }
    const tool = msg.params.toolCall || {}
    const options = (msg.params.options || []).map((o) => ({ optionId: o.optionId, label: o.name, kind: o.kind }))
    hooks.approval(sid, {
      id: 'acp-' + msg.id,
      permission: tool.title || tool.kind || '工具调用',
      command: JSON.stringify(tool.rawInput || tool.content || {}, null, 2).slice(0, 6000),
      options,
      respond: async (choice) => {
        const outcome = choice.cancelled
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId: choice.optionId }
        client.respond(msg.id, { outcome })
      }
    })
  }
  async function ensureSession (sid, selectedModel = 'default') {
    if (sessions.has(sid)) return sessions.get(sid)
    const client = await ensureClient()
    const meta = hooks.getSession(sid)?.meta || {}
    const state = { sid, nativeId: null, model: selectedModel, models: null, currentText: '', final: true, loading: false }
    sessions.set(sid, state)
    try {
      const sessionCwd = meta.cwd || cwd
      let result
      if (meta.nativeId && initialized?.agentCapabilities?.loadSession) {
        state.nativeId = meta.nativeId
        state.loading = true
        nativeToLocal.set(meta.nativeId, sid)
        result = await client.request('session/load', { sessionId: meta.nativeId, cwd: sessionCwd, mcpServers: [] })
      } else {
        result = await client.request('session/new', { cwd: sessionCwd, mcpServers: [] })
      }
      // ACP session/load 可只返回能力状态；未回传 sessionId 时必须保留已恢复的原生 ID。
      state.nativeId = result.sessionId || state.nativeId
      if (!state.nativeId) throw new Error('ACP 未返回有效 sessionId')
      state.models = result.models || null
      state.model = result.models?.currentModelId || selectedModel
      state.loading = false
      nativeToLocal.set(state.nativeId, sid)
      hooks.nativeSession(sid, state.nativeId)
      return state
    } catch (error) {
      sessions.delete(sid)
      if (state.nativeId) nativeToLocal.delete(state.nativeId)
      throw error
    }
  }
  return {
    capabilities: {
      transport: 'ACP v1 stdio JSON-RPC', newSession: 'session/new', resumeSession: 'session/load（按 Agent 能力）',
      streaming: 'session/update', cancellation: 'session/cancel', models: 'session/set_model（按 Agent 能力）',
      approvals: 'session/request_permission（原生 optionId）', dynamicApprovalOptions: true, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      if (!sid) return { items: [{ id: 'default', name: 'Agent 默认模型' }], selected: selected || 'default' }
      const state = await ensureSession(sid, selected)
      const result = modelsShape({ models: state.models }, state.model || selected)
      if (!result.items.length) result.items.push({ id: 'default', name: 'Agent 默认模型' })
      return result
    },
    async selectModel (sid, model) {
      const state = await ensureSession(sid, model)
      if (model !== 'default') await (await ensureClient()).request('session/set_model', { sessionId: state.nativeId, modelId: model })
      state.model = model
    },
    async prompt (sid, text, model) {
      const state = await ensureSession(sid, model)
      if (model && model !== 'default' && model !== state.model) {
        await (await ensureClient()).request('session/set_model', { sessionId: state.nativeId, modelId: model })
        state.model = model
      }
      state.currentText = ''
      state.final = true
      state.turnId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      const request = (await ensureClient()).request('session/prompt', {
        sessionId: state.nativeId, prompt: [{ type: 'text', text }]
      })
      state.promptPromise = request
      request.then(() => {
        if (state.currentText && !state.final) hooks.text(sid, state.turnId, state.currentText, true)
        state.final = true
        hooks.end(sid)
      }).catch((error) => hooks.end(sid, error))
    },
    async cancel (sid) {
      const state = sessions.get(sid)
      if (state) (await ensureClient()).notify('session/cancel', { sessionId: state.nativeId })
    },
    close () {
      if (clientPromise) clientPromise.then((client) => client.close()).catch(() => { })
      sessions.clear()
      nativeToLocal.clear()
    }
  }
}
