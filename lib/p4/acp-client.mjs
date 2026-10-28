// 最小 ACP v1 JSON-RPC stdio 客户端：换行分帧、请求/通知、Agent 反向请求。
import { spawn } from 'node:child_process'

export class AcpClient {
  constructor ({ command, args = [], cwd, env = process.env, log = () => {}, onNotification, onRequest }) {
    this.nextId = 1
    this.pending = new Map()
    this.onNotification = onNotification
    this.onRequest = onRequest
    this.buffer = ''
    this.child = spawn(command, args, {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#consume(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => { if (chunk.trim()) log('ACP stderr:', chunk.trim().slice(0, 300)) })
    this.child.on('error', (error) => this.#fail(error))
    this.child.on('exit', (code) => this.#fail(new Error(`ACP 进程退出 code=${code}`)))
  }
  #consume (chunk) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.method && msg.id !== undefined) {
        Promise.resolve(this.onRequest?.(msg)).catch((error) => this.respondError(msg.id, -32603, error.message))
      } else if (msg.method) {
        Promise.resolve(this.onNotification?.(msg)).catch(() => { })
      } else if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id)
        if (!waiter) continue
        this.pending.delete(msg.id)
        clearTimeout(waiter.timer)
        if (msg.error) waiter.reject(new Error(msg.error.message || 'ACP 请求失败'))
        else waiter.resolve(msg.result)
      }
    }
  }
  #write (value) {
    if (this.child.destroyed || this.child.stdin.destroyed) throw new Error('ACP 进程不可用')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  #fail (error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error) }
    this.pending.clear()
  }
  request (method, params = {}, timeoutMs = 120_000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('ACP 请求超时: ' + method)) }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try { this.#write({ jsonrpc: '2.0', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  notify (method, params = {}) { this.#write({ jsonrpc: '2.0', method, params }) }
  respond (id, result) { this.#write({ jsonrpc: '2.0', id, result }) }
  respondError (id, code, message) { this.#write({ jsonrpc: '2.0', id, error: { code, message } }) }
  close () {
    try { this.child.stdin.end() } catch { }
    try { this.child.kill() } catch { }
    this.#fail(new Error('ACP 客户端已关闭'))
  }
}
