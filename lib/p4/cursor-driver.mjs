// Cursor CLI 通用独立 Agent 驱动（agent --print --output-format stream-json --stream-partial-output）。
// print 模式每轮一个进程：首个 prompt 新建会话，后续用 --resume <chatId> 续；
// 流式 delta 与终稿从 stdout JSONL 防御性解析（官方字段 session_id / assistant / result，
// 兼容 claude 风格 content_block_delta）。print 模式无动态审批，审批走 CLI 配置 allowlist。
// 🔴 2026-10-28：本机 CLI 未登录（`agent login` 或 CURSOR_API_KEY），事件真实形状待登录后核对。
import { spawn } from 'node:child_process'

const lineText = (value) => {
  if (typeof value !== 'string') return ''
  return value
}

export function createCursorDriver ({ cwd, command = 'cmd.exe', cmdArgs, env = process.env, models = [], log = () => {} } = {}) {
  const sessions = new Map() // sid → { chatId, model }
  let hooks = null

  function spawnTurn (sid, promptText, resumeId, model, directory) {
    const args = [...(cmdArgs || [])]
    if (resumeId) args.push('--resume', resumeId)
    if (model && model !== 'default') args.push('--model', model)
    args.push('--print', '--output-format', 'stream-json', '--stream-partial-output', promptText)
    log(`spawn cursor agent：cwd=${directory} resume=${resumeId || 'new'}`)
    const child = spawn(command, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env, windowsVerbatimArguments: false })
    let stderr = ''
    return child
  }

  function handleLine (sid, state, line) {
    if (!line.trim() || !hooks) return
    let event
    try { event = JSON.parse(line) } catch { return }
    const type = event.type || event.event || ''
    // 会话 ID：常见字段防御性提取
    const nativeId = event.session_id || event.sessionId || event.chatId || event.conversation_id || ''
    if (nativeId && !state.chatId) {
      state.chatId = String(nativeId)
      hooks.nativeSession(sid, state.chatId)
    }
    // 流式 delta：claude 风格 content_block_delta / cursor delta 字段
    const delta = event.delta?.text || event.delta || (type === 'content_block_delta' ? event.delta?.text ?? event.text_delta?.text : '')
    if (typeof delta === 'string' && delta) {
      state.currentText += delta
      state.final = false
      hooks.text(sid, 'live', state.currentText)
      return
    }
    // assistant 终稿
    if (type === 'assistant' || event.message?.role === 'assistant') {
      const content = event.message?.content || event.content
      const text = Array.isArray(content)
        ? content.filter((c) => c?.type === 'text' || typeof c === 'string').map((c) => (typeof c === 'string' ? c : c.text || '')).join('')
        : lineText(content)
      if (text) {
        state.currentText = text
        state.finalText = text
        hooks.text(sid, 'live', text, true)
      }
      return
    }
    // 结果/结束
    if (type === 'result' || type === 'turn_end' || event.is_error !== undefined) {
      const text = lineText(event.result)
      if (!state.finalText && text) {
        state.finalText = text
        hooks.text(sid, 'live', text, true)
      } else if (state.currentText && !state.final) {
        hooks.text(sid, 'live', state.currentText, true)
      }
      state.final = true
      hooks.end(sid, event.is_error ? new Error(event.result || 'Cursor 执行失败') : null)
    }
  }

  async function runTurn (sid, text, model) {
    const meta = hooks?.getSession(sid)?.meta || {}
    let state = sessions.get(sid)
    if (!state) {
      state = { chatId: meta.nativeId || '', model: model || meta.model || '', currentText: '', finalText: '', final: true, directory: meta.cwd || cwd }
      sessions.set(sid, state)
    }
    if (meta.cwd) state.directory = meta.cwd
    if (model && model !== 'default') state.model = model
    state.currentText = ''
    state.finalText = ''
    state.final = true
    return new Promise((resolve) => {
      const child = spawnTurn(sid, text, state.chatId || '', state.model, state.directory)
      let buffer = ''
      let stderrTail = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          try { handleLine(sid, state, line) } catch (error) { log('cursor 事件处理异常:', error.message) }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2000)
        const textChunk = chunk.trim()
        if (textChunk) log('cursor stderr:', textChunk.slice(0, 200))
      })
      child.on('error', (error) => {
        log('cursor 进程错误:', error.message)
        hooks?.end(sid, error)
        resolve()
      })
      child.on('exit', (code) => {
        if (buffer.trim()) { try { handleLine(sid, state, buffer) } catch { } }
        const failure = code !== 0
          ? new Error((stderrTail.match(/Error: [^\r\n]+/) || [])[0] || `cursor 进程退出 code=${code}`)
          : null
        if (state.currentText && !state.final) hooks?.text(sid, 'live', state.currentText, true)
        hooks?.end(sid, failure)
        resolve()
      })
    })
  }

  return {
    capabilities: {
      transport: 'cursor agent --print stream-json', newSession: true, resumeSession: true,
      streaming: true, cancellation: 'none（print 模式逐轮进程）', models: '--model/--list-models',
      approvals: 'none（CLI 配置 allowlist，无动态审批）', dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      const items = models.length ? models.map((m) => ({ id: m, name: m })) : [{ id: 'default', name: 'Cursor 默认模型' }]
      return { items, selected: selected && selected !== 'default' ? selected : (models[0] || 'default') }
    },
    async selectModel (sid, model) {
      const state = sessions.get(sid)
      if (state) state.model = model
    },
    async prompt (sid, text, model) {
      // print 模式逐轮进程：不等待进程退出（light-bridge 以 end 钩子收轮）
      runTurn(sid, text, model)
    },
    async cancel (sid) {
      // print 模式无法中断单轮进程；如实回告不可取消
      throw new Error('Cursor print 模式暂不支持停止运行中的轮次')
    },
    close () {
      sessions.clear()
    }
  }
}
