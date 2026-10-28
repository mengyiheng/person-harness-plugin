// 本机 dsh session/list 入口合并：相同请求并发只扫描一次，成功后短暂复用。
// 只保存完整响应快照；每个调用者仍拿到独立 Response，避免 body 被重复消费。
export class SessionListCache {
  constructor ({ ttlMs = 1500, maxEntries = 4, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
    this.pending = new Map()
    this.completed = new Map()
    this.version = 0
  }

  invalidate () {
    this.version++
    this.completed.clear()
  }

  async fetch ({ origin, path, method, body }, doFetch) {
    const request = parseRequest(body)
    // 非标准 dsh 请求不参与合并，避免把无法识别 rpcId 的响应发给错误调用者。
    if (!request) return doFetch()
    const key = [origin, method, path, JSON.stringify(request.payload)].join('\n')
    const cached = this.completed.get(key)
    if (cached && this.now() - cached.at <= this.ttlMs) return responseOf(cached.snapshot, request.rpcId)
    this.completed.delete(key)

    const version = this.version
    let entry = this.pending.get(key)
    if (!entry || entry.version !== version) {
      const promise = (async () => {
        const res = await doFetch()
        const headers = {}
        res.headers.forEach((value, name) => { headers[name] = value })
        // fetch 已解压；缓存的是解压后的字节，不能保留原编码和长度。
        delete headers['content-encoding']
        delete headers['content-length']
        const snapshot = {
          status: res.status,
          statusText: res.statusText,
          headers,
          body: Buffer.from(await res.arrayBuffer()),
          patchRpcId: false
        }
        if (res.status === 200) {
          try {
            const payload = JSON.parse(snapshot.body.toString('utf8'))
            snapshot.patchRpcId = payload.type === 'server-response' && payload.rpcId === request.rpcId
          } catch {}
        }
        if (snapshot.patchRpcId && version === this.version) {
          this.completed.set(key, { at: this.now(), snapshot })
          while (this.completed.size > this.maxEntries) {
            this.completed.delete(this.completed.keys().next().value)
          }
        }
        return snapshot
      })()
      entry = { promise, version }
      this.pending.set(key, entry)
      const settle = () => {
        if (this.pending.get(key) === entry) this.pending.delete(key)
      }
      promise.then(settle, settle)
    }
    return responseOf(await entry.promise, request.rpcId)
  }
}

function parseRequest (body) {
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (value.type !== 'client-request' || value.method !== 'session/list' ||
      typeof value.rpcId !== 'string' || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return null
    return { rpcId: value.rpcId, payload: value.payload }
  } catch { return null }
}

function responseOf (snapshot, rpcId) {
  let body = snapshot.body
  if (snapshot.patchRpcId) {
    const payload = JSON.parse(body.toString('utf8'))
    payload.rpcId = rpcId
    body = Buffer.from(JSON.stringify(payload), 'utf8')
  }
  return new Response([204, 205, 304].includes(snapshot.status) ? null : body, {
    status: snapshot.status,
    statusText: snapshot.statusText,
    headers: snapshot.headers
  })
}
