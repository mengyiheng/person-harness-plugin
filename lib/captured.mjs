// CaptureDaemon（P3 窗口视频通道）：管理常驻采集进程 capture-helper.exe
// - 首次使用用 .NET Framework 自带 csc.exe 编译 lib/capture-helper.cs（缓存：源比 exe 新才重编）
// - 请求串行队列 + 15s 超时；进程死亡/超时自动杀进程，下次请求惰性重拉
// - 空闲 15 分钟自动回收进程（释放 GDI/内存），请求到来再拉起
// - 任何环节失败都抛异常，调用方回退 PowerShell 管线（永不阻塞主链路）
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // lib/
const ROOT = dirname(HERE)                            // 插件根
const CACHE_DIR = join(ROOT, 'capture-cache')
const SRC = join(HERE, 'capture-helper.cs')
const EXE = join(CACHE_DIR, 'capture-helper.exe')
const IDLE_KILL_MS = 15 * 60 * 1000
const REQ_TIMEOUT_MS = 15000

const CSC_CANDIDATES = [
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
]

export class CaptureDaemon {
  constructor ({ log }) {
    this.log = log || (() => {})
    this.child = null
    this.buf = ''
    this.nextId = 1
    this.pending = new Map() // id → { resolve, reject, timer }
    this.queue = Promise.resolve()
    this.lastUse = 0
    this.idleTimer = null
    this.ready = false
  }

  _csc () { return CSC_CANDIDATES.find((p) => existsSync(p)) || null }

  _compile () {
    if (existsSync(EXE) && statSync(EXE).mtimeMs >= statSync(SRC).mtimeMs) return
    const csc = this._csc()
    if (!csc) throw new Error('未找到 csc.exe（.NET Framework），capture-helper 无法编译')
    mkdirSync(CACHE_DIR, { recursive: true })
    this.log(`编译 capture-helper: ${EXE}`)
    return new Promise((resolve, reject) => {
      execFile(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', '/out:' + EXE, SRC], { timeout: 60000, windowsHide: true }, (e, so, se) => {
        if (e || !existsSync(EXE)) return reject(new Error('csc 失败: ' + String(se || e?.message).slice(0, 200)))
        resolve()
      })
    })
  }

  async _spawn () {
    await this._compile()
    if (this.child && !this.child.killed) return
    this.log('拉起 capture-helper 进程')
    const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.buf = ''
    child.stdout.on('data', (d) => this._onData(d))
    child.stderr.on('data', () => { /* 诊断时开 */ })
    child.on('exit', () => {
      if (this.child === child) this.child = null
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('capture-helper 进程退出')) }
      this.pending.clear()
    })
    // 预热：GDI+/编码器类型加载并入 JIT（首帧经常 >1s，预热后 <100ms）
    await this._rawRequest('0|screen|160|30', 20000).catch((e) => { this.log('capture-helper 预热失败: ' + e.message) })
  }

  _onData (chunk) {
    this.buf += chunk.toString('utf8')
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      const p = line.indexOf('|')
      if (p < 0) continue
      const id = line.slice(0, p)
      const pend = this.pending.get(id)
      if (!pend) continue
      this.pending.delete(id)
      clearTimeout(pend.timer)
      pend.resolve(line.slice(p + 1))
    }
  }

  _rawRequest (line, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = line.slice(0, line.indexOf('|'))
      const timer = setTimeout(() => {
        this.pending.delete(id)
        try { this.child?.kill() } catch (e) { /* 忽略 */ }
        this.child = null
        reject(new Error('capture-helper 请求超时'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.child.stdin.write(line + '\n') } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e) }
    })
  }

  /** 串行化请求（采集是 CPU 密集，避免并行帧互相拖慢） */
  async _request (line) {
    const run = this.queue.then(async () => {
      this.lastUse = Date.now()
      this._armIdleKill()
      await this._spawn()
      return this._rawRequest(line, REQ_TIMEOUT_MS)
    })
    this.queue = run.catch(() => {})
    return run
  }

  _armIdleKill () {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.child && Date.now() - this.lastUse >= IDLE_KILL_MS - 5000) {
        this.log('capture-helper 空闲超时，回收进程')
        try { this.child.kill() } catch (e) { /* 忽略 */ }
        this.child = null
      }
    }, IDLE_KILL_MS)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  /** 窗口采集 → { still: true } | { w, h, b64 }；force=1 跳过静止判定（新观看会话强制全帧） */
  async win (hwnd, maxW, q, force) {
    const r = await this._request(`${this.nextId++}|win|${hwnd}|${maxW | 0}|${q | 0}|${force ? 1 : 0}`)
    if (r === 'still') return { still: true }
    const p = r.split('|')
    if (p[0] !== 'ok') throw new Error(p.slice(1).join('|') || 'capture error')
    return { w: Number(p[1]), h: Number(p[2]), b64: p[3] }
  }

  /** 整屏采集 → 同 win */
  async screen (maxW, q) {
    const r = await this._request(`${this.nextId++}|screen|${maxW | 0}|${q | 0}`)
    if (r === 'still') return { still: true }
    const p = r.split('|')
    if (p[0] !== 'ok') throw new Error(p.slice(1).join('|') || 'capture error')
    return { w: Number(p[1]), h: Number(p[2]), b64: p[3] }
  }

  destroy () {
    clearTimeout(this.idleTimer)
    try { this.child?.kill() } catch (e) { /* 忽略 */ }
    this.child = null
  }
}
