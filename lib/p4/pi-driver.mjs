// Pi (@earendil-works/pi-coding-agent) 通用独立 Agent 驱动。
// 每个会话懒拉起一个 `pi --mode rpc --session-id <id> --session-dir <dir>` 子进程（JSON lines over stdio），
// 进程 cwd = 会话台账 meta.cwd，工作区互不串用；nativeId 即 pi session id，存台账可跨重启续用。
// 协议（2026-10-25 实测）：命令 {id, type:'prompt'|'get_state'|'get_available_models'|'set_model'|'abort'}
// 响应 {type:'response', id, success, data|error}；事件 agent_start/message_update/message_end/agent_end；
// 审批为 extension_ui_request{method:'confirm'} → extension_ui_response{confirmed}（仅 批准一次/拒绝）。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const textOfMessage = (m) => (Array.isArray(m?.content) ? m.content : [])
  .filter((c) => c && (c.type === 'text' || typeof c === 'string'))
  .map((c) => (typeof c === 'string' ? c : c.text || '')).join('')

export function createPiDriver ({ cwd, node = process.execPath, piScript = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'), sessionDir, env = process.env, log = () => {} } = {}) {
  const sessionsHome = sessionDir || path.join(os.homedir(), '.pi', 'agent', 'sessions')
  const procs = new Map() // sid → proc 状态
  const sessions = new Map() // sid → { nativeId, model }
  const approvalResponders = new Map() // `${sid}:${reqId}` → responder
  let hooks = null

  function rpc (p, command) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      p.pending.set(id, { resolve, reject })
      try { p.child.stdin.write(JSON.stringify({ id, ...command }) + '\n') } catch (error) { p.pending.delete(id); reject(error); return }
      setTimeout(() => { if (p.pending.has(id)) { p.pending.delete(id); reject(new Error('pi rpc 超时: ' + command.type)) } }, 60_000).unref()
    })
  }

  function handleUpstream (sid, p, msg) {
    if (msg.type === 'response') {
      const waiter = p.pending.get(msg.id)
      if (waiter) { p.pending.delete(msg.id); msg.success ? waiter.resolve(msg.data) : waiter.reject(new Error(msg.error || 'pi rpc 失败')) }
      return
    }
    if (!hooks) return
    if (msg.type === 'extension_ui_request' && msg.method === 'confirm') {
      const reqId = String(msg.id)
      approvalResponders.set(`${sid}:${reqId}`, (confirmed) => {
        approvalResponders.delete(`${sid}:${reqId}`)
        try { p.child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: msg.id, confirmed }) + '\n') } catch { }
      })
      hooks.approval(sid, {
        id: reqId,
        permission: msg.title || 'confirm',
        command: msg.message || 'Pi 操作',
        options: [
          { optionId: 'once', label: '批准一次', kind: 'allow_once' },
          { optionId: 'reject', label: '拒绝', kind: 'reject_once' }
        ],
        respond: (choice) => {
          const confirmed = !choice.cancelled && choice.optionId !== 'reject' && choice.response !== 'reject'
          approvalResponders.get(`${sid}:${reqId}`)?.(confirmed)
        }
      })
      return
    }
    if ((msg.type === 'agent_start' || msg.type === 'turn_start') && !p.turn) {
      p.turn = true
      p.curText = ''
      return
    }
    if (msg.type === 'message_update') {
      if (msg.usage && (msg.usage.totalTokens > 0 || msg.usage.output > 0)) p.usage = msg.usage
      const event = msg.assistantMessageEvent || {}
      if (event.type === 'text_delta' && typeof event.delta === 'string') {
        p.curText = (p.curText || '') + event.delta
        hooks.text(sid, 'live', p.curText)
      }
      return
    }
    if (msg.type === 'message_end') {
      const m = msg.message
      if (!m || m.role === 'user') return
      if (m.errorMessage) p.lastError = m.errorMessage
      const text = textOfMessage(m)
      if (text) {
        p.curText = text
        p.finalText = text
        hooks.text(sid, 'live', text, true)
        if (m.usage && (m.usage.totalTokens > 0 || m.usage.output > 0)) p.usage = m.usage
      }
      return
    }
    if (msg.type === 'agent_end' || msg.type === 'agent_settled') {
      if (p.turn) {
        p.turn = false
        if (!p.finalText && p.curText) hooks.text(sid, 'live', p.curText, true)
        const failure = p.lastError ? new Error(p.lastError) : null
        p.finalText = ''
        p.curText = ''
        p.lastError = null
        p.usage = null
        hooks.end(sid, failure)
      }
    }
  }

  function ensureProc (sid) {
    let p = procs.get(sid)
    if (p && !p.dead) return p
    const state = sessions.get(sid)
    const nativeId = state?.nativeId || sid
    const directory = state?.directory || cwd
    log(`spawn pi --mode rpc：session=${nativeId} cwd=${directory}`)
    const child = spawn(node, [piScript, '--mode', 'rpc', '--session-id', nativeId, '--session-dir', sessionsHome], {
      cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], env
    })
    p = { child, dead: false, buf: '', pending: new Map(), turn: false, curText: '', finalText: '', usage: null }
    procs.set(sid, p)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      p.buf += chunk
      let nl
      while ((nl = p.buf.indexOf('\n')) >= 0) {
        const line = p.buf.slice(0, nl).trim()
        p.buf = p.buf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        try { handleUpstream(sid, p, msg) } catch (error) { log('upstream 处理异常:', error.message) }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => { const text = chunk.trim(); if (text) log('pi stderr:', text.slice(0, 200)) })
    child.on('exit', (code) => { p.dead = true; log(`pi 进程退出 code=${code} session=${nativeId}`); if (procs.get(sid) === p) procs.delete(sid) })
    child.on('error', (error) => { p.dead = true; log('pi 进程错误:', error.message); if (procs.get(sid) === p) procs.delete(sid) })
    return p
  }

  async function ensureSession (sid, model) {
    let state = sessions.get(sid)
    if (!state) {
      const meta = hooks?.getSession(sid)?.meta || {}
      state = { nativeId: meta.nativeId || sid, model: model || meta.model || '', directory: meta.cwd || cwd }
      sessions.set(sid, state)
    }
    if (model && model !== state.model && model !== 'default') state.model = model
    if (state.nativeId) hooks?.nativeSession(sid, state.nativeId)
    return state
  }

  return {
    capabilities: {
      transport: 'pi --mode rpc', newSession: true, resumeSession: true,
      streaming: true, cancellation: 'abort', models: 'get_available_models/set_model',
      approvals: 'extension_ui_request:confirm:once/reject', dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      try {
        const state = sid ? await ensureSession(sid, selected) : null
        const directory = state?.directory || cwd
        const probe = ensureProc(sid || '__probe__')
        const [result, procState] = await Promise.all([
          rpc(probe, { type: 'get_available_models' }),
          rpc(probe, { type: 'get_state' })
        ])
        const items = (result?.models || []).map((m) => {
          const modelId = m.id || m.modelId
          return { id: `${m.provider}/${modelId}`, name: m.name || modelId, description: m.provider || '' }
        }).filter((m) => !m.id.startsWith('/') && m.id !== '/')
        let current = selected && selected !== 'default' ? selected : ''
        if (!current && procState?.model) current = `${procState.model.provider}/${procState.model.id || procState.model.modelId}`
        return { items, selected: current || items[0]?.id || 'default' }
      } catch (error) {
        log('model/list 失败:', error.message)
        return { items: [{ id: 'default', name: 'Pi 默认模型' }], selected: selected || 'default' }
      }
    },
    async selectModel (sid, model) {
      const state = await ensureSession(sid, model)
      state.model = model
      const p = ensureProc(sid)
      const separator = model.indexOf('/')
      if (separator > 0) {
        await rpc(p, { type: 'set_model', provider: model.slice(0, separator), modelId: model.slice(separator + 1) })
      }
    },
    async prompt (sid, text, model) {
      const state = await ensureSession(sid, model)
      const p = ensureProc(sid)
      if (state.model && state.model !== 'default' && model !== 'default') {
        const separator = state.model.indexOf('/')
        if (separator > 0) {
          await rpc(p, { type: 'set_model', provider: state.model.slice(0, separator), modelId: state.model.slice(separator + 1) }).catch((error) => log('set_model 失败:', error.message))
        }
      }
      await rpc(p, { type: 'prompt', message: text })
    },
    async cancel (sid) {
      const p = procs.get(sid)
      if (p && !p.dead) await rpc(p, { type: 'abort' })
    },
    close () {
      for (const responder of approvalResponders.values()) { try { responder(false) } catch { } }
      approvalResponders.clear()
      for (const p of procs.values()) { try { p.child.kill() } catch { } }
      procs.clear()
      sessions.clear()
    }
  }
}
