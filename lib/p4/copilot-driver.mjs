// GitHub Copilot CLI 通用独立 Agent 驱动（`copilot -p <text>` 非交互模式）。
// 每轮一个进程；--session-id <uuid> 固定会话（新会话由驱动生成 UUID 并落台账，跨轮/跨重启续用），
// 进程 cwd = 会话台账 meta.cwd；--model 每轮下发。
// 输出为纯文本（无流式事件），整轮结束后一次性落台账；print 模式无动态审批：
// allowAllTools 开启时等价于自动批准全部工具（--allow-all-tools），关闭时工具被拒、纯问答可用。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

export function createCopilotDriver ({ cwd, command = 'copilot', baseArgs = [], allowAllTools = false, env = process.env, models = [], log = () => {} } = {}) {
  const sessions = new Map() // sid → { sessionId, model, directory }
  let hooks = null

  function runTurn (sid, text, model) {
    const meta = hooks?.getSession(sid)?.meta || {}
    let state = sessions.get(sid)
    if (!state) {
      state = { sessionId: meta.nativeId || randomUUID(), model: model || meta.model || '', directory: meta.cwd || cwd }
      sessions.set(sid, state)
    }
    if (meta.cwd) state.directory = meta.cwd
    if (model && model !== 'default') state.model = model
    const args = [...baseArgs, '-p', text, '--session-id', state.sessionId]
    if (state.model && state.model !== 'default') args.push('--model', state.model)
    if (allowAllTools) args.push('--allow-all-tools')
    log(`spawn copilot：cwd=${state.directory} session=${state.sessionId} model=${state.model || 'default'}`)
    return new Promise((resolve) => {
      const child = spawn(command, args, { cwd: state.directory, stdio: ['ignore', 'pipe', 'pipe'], env })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
      child.on('error', (error) => {
        log('copilot 进程错误:', error.message)
        hooks?.end(sid, error)
        resolve()
      })
      child.on('exit', (code) => {
        hooks?.nativeSession(sid, state.sessionId)
        const stderrTail = stderr.trim().slice(-300)
        if (stderrTail) log('copilot stderr:', stderrTail)
        const failure = code !== 0
          ? new Error((stderr.match(/(?:Error|error)[:：][^\r\n]+/) || [])[0] || stderrTail || `copilot 进程退出 code=${code}`)
          : null
        const text = stdout.trim()
        if (text) hooks?.text(sid, 'copilot-' + Date.now(), text, true)
        hooks?.end(sid, failure)
        resolve()
      })
    })
  }

  return {
    capabilities: {
      transport: 'copilot -p（非交互 print）', newSession: true, resumeSession: true,
      streaming: false, cancellation: 'none（print 模式逐轮进程）', models: '--model',
      approvals: allowAllTools ? 'none（--allow-all-tools 自动批准全部工具）' : 'none（工具默认拒绝，仅纯问答）',
      dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      const items = models.length ? models.map((m) => ({ id: m, name: m })) : [{ id: 'default', name: 'Copilot 默认模型' }]
      return { items, selected: selected && selected !== 'default' ? selected : (models[0] || 'default') }
    },
    async selectModel (sid, model) {
      const state = sessions.get(sid)
      if (state) state.model = model
    },
    async prompt (sid, text, model) {
      // 逐轮进程，不等待退出（light-bridge 以 end 钩子收轮）
      runTurn(sid, text, model)
    },
    async cancel (sid) {
      throw new Error('Copilot print 模式暂不支持停止运行中的轮次')
    },
    close () {
      sessions.clear()
    }
  }
}
