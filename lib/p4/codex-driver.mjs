// Codex (codex app-server, JSON-RPC over stdio) 通用独立 Agent 驱动。
// 契约与 acp-driver / claude-driver 相同：attach/prompt/listModels/selectModel/cancel/close。
// 每个 sid 对应一个 codex thread（nativeId 存会话台账 meta.nativeId），
// thread/start / thread/resume 使用该会话台账自己的 meta.cwd，不串用工作区。
// 🔴 已知坑（2026-10-25）：CODEX_HOME 在 C:\Users\* 下初始化会报 os error 5；
//   初始化即退时自动切换 fallbackHome（默认 <cwd>/.p4-codex-home）重拉，也可用配置 codexHome 显式指定。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const RPC_TIMEOUT = 60_000
const INIT_PARAMS = { clientInfo: { name: 'person-harness-agent', title: 'Person Harness Agent', version: '0.1.0' } }
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'execCommandApproval', 'applyPatchApproval'
])

export function createCodexDriver ({ cwd, command = 'codex', args = ['app-server'], codexHome, fallbackHome, env = process.env, log = () => {} } = {}) {
  let child = null
  let childDead = false
  let initialized = false
  let usingFallbackHome = false
  let nextId = 1
  const pending = new Map() // rpcId → {resolve, reject}
  const sessions = new Map() // sid → { nativeId, model, turnId, cwd }
  const sidByThread = new Map() // codex threadId → sid
  const deltas = new Map() // 'thread:itemId' → 累积文本
  const approvalResponders = new Map() // rpcId → respond 函数
  let hooks = null

  const childEnv = () => {
    const value = { ...env }
    const home = usingFallbackHome ? (fallbackHome || path.join(cwd, '.p4-codex-home')) : codexHome
    if (home) {
      fs.mkdirSync(home, { recursive: true })
      value.CODEX_HOME = home
    }
    return value
  }

  function ensureChild () {
    if (child && !childDead) return child
    log(`spawn codex app-server${usingFallbackHome ? '（fallback CODEX_HOME）' : ''}`)
    childDead = false
    child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let message
        try { message = JSON.parse(line) } catch { continue }
        try { handleUpstream(message) } catch (error) { log('upstream 处理异常:', error.message) }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = chunk.trim()
      if (text && !text.includes('WARNING')) log('codex stderr:', text.slice(0, 200))
    })
    child.on('exit', (code) => {
      childDead = true
      log(`codex 进程退出 code=${code}；后续调用将重拉`)
      for (const waiter of pending.values()) waiter.reject(new Error(`codex 进程退出 code=${code}`))
      pending.clear()
      if (!initialized && !usingFallbackHome) {
        usingFallbackHome = true
        log('CODEX_HOME 初始化失败，切换 fallback 后重试 initialize')
        setTimeout(() => { rpc('initialize', INIT_PARAMS).catch(() => {}) }, 500)
      }
    })
    child.on('error', (error) => { childDead = true; log('codex 进程错误:', error.message) })
    rpc('initialize', INIT_PARAMS).catch((error) => log('initialize 失败:', error.message))
    return child
  }

  function rpc (method, params) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        ensureChild().stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (error) {
        pending.delete(id)
        reject(error)
        return
      }
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('codex rpc 超时: ' + method)) }
      }, RPC_TIMEOUT).unref()
    })
  }

  const sessionFor = (threadId) => sessions.get(sidByThread.get(threadId))

  function handleUpstream (message) {
    // JSON-RPC 响应
    if (message.id !== undefined && message.id !== null && !message.method) {
      initialized = true
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result)
      }
      return
    }
    // 服务端请求：动态审批
    if (message.method && message.id !== undefined && message.id !== null) {
      const params = message.params || {}
      const session = sessionFor(params.threadId)
      if (session && APPROVAL_METHODS.has(message.method)) {
        const reqId = String(message.id)
        approvalResponders.set(reqId, (decision) => {
          approvalResponders.delete(reqId)
          try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { decision } }) + '\n') } catch { }
        })
        hooks?.approval(sidByThread.get(params.threadId), {
          id: reqId,
          permission: message.method.includes('fileChange') || message.method === 'applyPatchApproval' ? 'fileChange' : 'commandExecution',
          command: params.command || params.reason || (params.changes ? JSON.stringify(params.changes).slice(0, 6000) : 'Codex 操作'),
          options: [
            { optionId: 'once', label: '批准一次', kind: 'allow_once' },
            { optionId: 'always', label: '本会话总是批准', kind: 'allow_always' },
            { optionId: 'reject', label: '拒绝', kind: 'reject_once' }
          ],
          respond: (choice) => {
            const decision = choice.cancelled || choice.optionId === 'reject' || choice.response === 'reject'
              ? 'decline'
              : (choice.optionId === 'always' || choice.response === 'always' ? 'acceptForSession' : 'accept')
            approvalResponders.get(reqId)?.(decision)
          }
        })
        return
      }
      // 未识别的服务端请求：空对象兜底应答，避免 app-server 挂起
      log('未处理的服务端请求:', message.method)
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n') } catch { }
      return
    }
    // 通知
    const params = message.params || {}
    const session = sessionFor(params.threadId)
    if (!session || !hooks) return
    const sid = sidByThread.get(params.threadId)
    switch (message.method) {
      case 'turn/started':
        if (params.turn?.id) session.turnId = params.turn.id
        break
      case 'item/agentMessage/delta': {
        const key = params.threadId + ':' + params.itemId
        deltas.set(key, (deltas.get(key) || '') + (params.delta || ''))
        hooks.text(sid, params.itemId, deltas.get(key))
        break
      }
      case 'item/completed': {
        const item = params.item
        if (item?.type === 'agentMessage') {
          deltas.delete(params.threadId + ':' + item.id)
          if (item.text) hooks.text(sid, item.id, item.text, true)
        } else if (item?.type === 'commandExecution') {
          hooks.text(sid, item.id, `🔧 **命令**（${item.status || '执行中'}）\n\`\`\`\n${(item.command || '').slice(0, 500)}\n\`\`\``, true)
        } else if (item?.type === 'fileChange') {
          hooks.text(sid, item.id, `📝 **文件修改**（${item.status || ''}）`, true)
        }
        break
      }
      case 'thread/name/updated':
        if (params.threadName) hooks.title(sid, params.threadName)
        break
      case 'turn/completed': {
        session.turnId = null
        const failure = params.turn?.error?.message || (params.turn?.status === 'failed' ? 'Codex 轮次失败' : null)
        hooks.end(sid, failure ? new Error(failure) : null)
        break
      }
      case 'error':
        log('codex 错误通知:', JSON.stringify(params.error || params).slice(0, 300))
        hooks.end(sid, new Error(params.error?.message || JSON.stringify(params.error || params).slice(0, 200) || 'Codex 错误'))
        break
      default:
        log('未映射通知:', message.method, JSON.stringify(params).slice(0, 200))
        break
    }
  }

  async function ensureSession (sid, model) {
    let session = sessions.get(sid)
    if (session) return session
    const meta = hooks?.getSession(sid)?.meta || {}
    session = { nativeId: meta.nativeId || '', model: model || meta.model || '', turnId: null, cwd: meta.cwd || cwd }
    sessions.set(sid, session)
    if (session.nativeId) sidByThread.set(session.nativeId, sid)
    return session
  }

  async function ensureThread (sid, session) {
    if (session.nativeId) {
      // 跨进程重启后 app-server 未必已加载该 thread：先 resume（已加载时是幂等 rejoins）
      try {
        await rpc('thread/resume', {
          threadId: session.nativeId,
          cwd: session.cwd,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
          model: session.model && session.model !== 'default' ? session.model : null
        })
        return session.nativeId
      } catch (error) {
        log('thread/resume 失败，改用新 thread:', error.message)
        sidByThread.delete(session.nativeId)
        session.nativeId = ''
      }
    }
    const result = await rpc('thread/start', {
      cwd: session.cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: session.model && session.model !== 'default' ? session.model : undefined
    })
    const thread = result?.thread || result?.data?.thread
    if (!thread?.id) throw new Error('thread/start 未返回 thread id')
    session.nativeId = thread.id
    sidByThread.set(thread.id, sid)
    return thread.id
  }

  return {
    capabilities: {
      transport: 'codex app-server', newSession: true, resumeSession: true,
      streaming: true, cancellation: 'turn/interrupt', models: 'model/list',
      approvals: 'requestApproval:accept/acceptForSession/decline', dynamicApprovalOptions: false, realAgentValidated: false
    },
    attach (value) { hooks = value },
    async listModels (sid, selected) {
      try {
        const result = await rpc('model/list', { limit: 100, includeHidden: false })
        const items = (result?.data || result?.models || [])
          .filter((m) => m && !m.hidden)
          .map((m) => ({ id: m.id || m.model, name: m.displayName || m.name || m.id || m.model, description: m.description || '', isDefault: !!m.isDefault }))
          .filter((m) => m.id)
        if (items.length) return { items, selected: selected || items.find((m) => m.isDefault)?.id || items[0].id }
      } catch (error) { log('model/list 失败:', error.message) }
      return { items: [{ id: 'default', name: 'Codex 默认模型' }], selected: selected || 'default' }
    },
    async selectModel (sid, model) {
      const session = await ensureSession(sid, model)
      session.model = model
    },
    async prompt (sid, text, model) {
      const session = await ensureSession(sid, model)
      if (model && model !== session.model) session.model = model
      const threadId = await ensureThread(sid, session)
      hooks?.nativeSession(sid, threadId)
      const result = await rpc('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        model: session.model && session.model !== 'default' ? session.model : undefined
      })
      session.turnId = result?.turn?.id || null
    },
    async cancel (sid) {
      const session = sessions.get(sid)
      if (!session?.nativeId || !session.turnId) return
      await rpc('turn/interrupt', { threadId: session.nativeId, turnId: session.turnId })
      session.turnId = null
    },
    close () {
      for (const responder of approvalResponders.values()) { try { responder('decline') } catch { } }
      approvalResponders.clear()
      try { child?.kill() } catch { }
      child = null
      sessions.clear()
      sidByThread.clear()
    }
  }
}
