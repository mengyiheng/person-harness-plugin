// OpenCode 通用独立 Agent 驱动：本驱动托管一个 `opencode serve` 子进程（或复用 origin 指向的外部服务），
// 通过 HTTP + SSE(/event) 与内核交互，映射到与 acp/claude/codex 相同的驱动契约。
// 每个 sid 对应一个 opencode session（nativeId 存会话台账 meta.nativeId）；
// session 创建与 prompt 携带 ?directory=<会话工作区>，尽量让内核使用各自 cwd（内核是否落盘该目录取决于其版本）。
// 审批：SSE permission.asked → approve-once/always/reject → POST /session/<id>/permissions/<pid>。
// 🔴 隔离建议：不同 Agent 配置各自的 XDG_DATA_HOME（driver.env），避免共享 opencode 全局会话存储。
import net from 'node:net'
import { spawn } from 'node:child_process'

async function freePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

export function createOpencodeDriver ({ cwd, command = 'opencode', args, port, origin, env = process.env, log = () => {} } = {}) {
  let baseUrl = origin ? String(origin).replace(/\/$/, '') : null
  let child = null
  let sseController = null
  let sseAlive = false
  let nextNative = 1
  const sessions = new Map() // sid → { nativeId, model, directory, lastMid, lastText, msgRole }
  const sidByNative = new Map()
  const approvalResponders = new Map() // permissionId → responder
  let hooks = null

  const oc = async (method, apiPath, body) => {
    const res = await fetch(baseUrl + apiPath, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new Error(`opencode ${method} ${apiPath} → ${res.status}`)
    if (res.status === 204) return null
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  async function waitReady () {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(baseUrl + '/session', { signal: AbortSignal.timeout(2000) })
        if (res.ok) { log(`opencode 服务就绪: ${baseUrl}`); return }
      } catch { }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('opencode serve 30s 内未就绪: ' + baseUrl)
  }

  async function ensureServer () {
    if (baseUrl) return
    const serverPort = port || await freePort()
    baseUrl = `http://127.0.0.1:${serverPort}`
    const serverArgs = args || ['serve', '--hostname', '127.0.0.1', '--port', String(serverPort)]
    log(`spawn opencode serve: ${command} ${serverArgs.join(' ')}`)
    child = spawn(command, serverArgs, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => log('opencode:', chunk.trim().slice(0, 200)))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => log('opencode stderr:', chunk.trim().slice(0, 200)))
    child.on('exit', (code) => { log(`opencode serve 退出 code=${code}`); child = null })
    child.on('error', (error) => log('opencode serve 错误:', error.message))
    await waitReady()
  }

  async function ensureSse () {
    if (sseController) return
    sseController = new AbortController()
    sseAlive = true
    const controller = sseController
    ;(async () => {
      while (sseAlive) {
        try {
          const res = await fetch(baseUrl + '/event', { signal: controller.signal, headers: { accept: 'text/event-stream' } })
          if (!res.ok || !res.body) throw new Error('SSE → ' + res.status)
          log('SSE 增量订阅已建立（/event）')
          let buffer = ''
          for await (const chunk of res.body) {
            buffer += Buffer.from(chunk).toString('utf8')
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''
            for (const raw of lines) {
              const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
              if (!line.startsWith('data:')) continue
              let event
              try { event = JSON.parse(line.slice(5).trimStart()) } catch { continue }
              try { handleEvent(event) } catch (error) { log('SSE 事件处理异常:', error.message) }
            }
          }
        } catch (error) {
          if (!sseAlive || controller.signal.aborted) return
          log('SSE 断开，5s 后重连:', error.message)
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
    })().catch(() => { })
  }

  function handleEvent (event) {
    const type = event.type
    const p = event.properties || {}
    const sid = sidByNative.get(p.sessionID)
    if (!sid || !hooks) return
    const session = sessions.get(sid)
    if (type === 'session.updated' && p.info?.title) {
      hooks.title(sid, p.info.title)
      return
    }
    if (type === 'message.updated' && p.info) {
      session.msgRole.set(p.info.id, p.info.role)
      return
    }
    if (type === 'message.part.updated' && p.part?.type === 'text') {
      const mid = p.part.messageID
      if (session.msgRole.get(mid) === 'user') return // 用户消息由轻壳台账记录，避免重复
      const text = p.part.text || ''
      if (!text) return
      session.lastMid = mid
      session.lastText = text
      hooks.text(sid, mid, text)
      return
    }
    if (type === 'permission.asked' && p.id) {
      const reqId = String(p.id)
      approvalResponders.set(reqId, async (response) => {
        approvalResponders.delete(reqId)
        try { await oc('POST', `/session/${p.sessionID}/permissions/${p.id}`, { response }) } catch (error) { log('审批回传失败:', error.message) }
      })
      hooks.approval(sid, {
        id: reqId,
        permission: p.permission || '操作',
        command: p.metadata?.command || (p.patterns || []).join(' ') || 'OpenCode 操作',
        options: [
          { optionId: 'once', label: '批准一次', kind: 'allow_once' },
          { optionId: 'always', label: '本会话总是批准', kind: 'allow_always' },
          { optionId: 'reject', label: '拒绝', kind: 'reject_once' }
        ],
        respond: (choice) => {
          const response = choice.cancelled || choice.optionId === 'reject' || choice.response === 'reject'
            ? 'reject'
            : (choice.optionId === 'always' || choice.response === 'always' ? 'always' : 'once')
          approvalResponders.get(reqId)?.(response)
        }
      })
      return
    }
    if (type === 'session.idle' || (type === 'session.status' && p.status?.type === 'idle')) {
      if (session.lastMid && session.lastText) hooks.text(sid, session.lastMid, session.lastText, true)
      session.lastMid = ''
      session.lastText = ''
      hooks.end(sid, null)
      return
    }
    log('未映射 SSE 事件:', type)
  }

  const session = (sid) => sessions.get(sid)

  async function ensureSession (sid, model) {
    let state = sessions.get(sid)
    if (state) return state
    const meta = hooks?.getSession(sid)?.meta || {}
    state = { nativeId: meta.nativeId || '', model: model || meta.model || '', directory: meta.cwd || cwd, msgRole: new Map(), lastMid: '', lastText: '' }
    sessions.set(sid, state)
    if (state.nativeId) sidByNative.set(state.nativeId, sid)
    await ensureSse()
    return state
  }

  const modelPayload = (model) => {
    if (!model || model === 'default') return undefined
    const separator = model.indexOf('/')
    if (separator < 1) throw new Error('模型 ID 格式无效（应为 provider/model）')
    return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
  }

  return {
    capabilities: {
      transport: 'opencode serve', newSession: true, resumeSession: true,
      streaming: true, cancellation: 'session/abort', models: 'provider/list',
      approvals: 'permission.asked:once/always/reject', dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      try {
        await ensureServer()
        const providers = await oc('GET', '/provider')
        const items = []
        for (const provider of providers?.all || []) {
          for (const [modelId, model] of Object.entries(provider.models || {})) {
            items.push({ id: `${provider.id}/${modelId}`, name: model.name || modelId, description: provider.name || '' })
          }
        }
        if (items.length) {
          const defaultId = Object.entries(providers?.default || {})[0]?.join('/')
          return { items, selected: !selected || selected === 'default' ? (defaultId || items[0].id) : selected }
        }
      } catch (error) { log('model/list 失败:', error.message) }
      return { items: [{ id: 'default', name: 'OpenCode 默认模型' }], selected: selected || 'default' }
    },
    async selectModel (sid, model) {
      const state = await ensureSession(sid, model)
      state.model = model
    },
    async prompt (sid, text, model) {
      const state = await ensureSession(sid, model)
      if (model && model !== state.model) state.model = model
      await ensureServer()
      if (!state.nativeId) {
        const created = await oc('POST', `/session?directory=${encodeURIComponent(state.directory)}`, {})
        if (!created?.id) throw new Error('opencode /session 未返回 session id')
        state.nativeId = created.id
        sidByNative.set(created.id, sid)
        hooks?.nativeSession(sid, created.id)
      }
      await oc('POST', `/session/${state.nativeId}/prompt_async?directory=${encodeURIComponent(state.directory)}`, {
        parts: [{ type: 'text', text }],
        ...(modelPayload(state.model) ? { model: modelPayload(state.model) } : {})
      })
    },
    async cancel (sid) {
      const state = session(sid)
      if (!state?.nativeId) return
      await oc('POST', `/session/${state.nativeId}/abort`, {})
    },
    close () {
      sseAlive = false
      try { sseController?.abort() } catch { }
      sseController = null
      for (const responder of approvalResponders.values()) { try { responder('reject') } catch { } }
      approvalResponders.clear()
      try { child?.kill() } catch { }
      child = null
      sessions.clear()
      sidByNative.clear()
    }
  }
}
