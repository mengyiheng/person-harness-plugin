// 跨机互传 ferry——A 电脑 → B 电脑的文件搬运
// 通道：复用 ph link 的本地代理（127.0.0.1:<port> → E2E 隧道 → B 插件 file/put）
// 纪律：两端台账留痕（B 端以 upload 事件入账）；大小上限与文件互传一致（50MB/次）
import { basename } from 'node:path'
import { statSync, readFileSync } from 'node:fs'

export function parseFerryArgs (raw) {
  // 形态：/ph ferry <本地路径> [@目标备注]；@后为备注（v1 目标由当前 link 决定）
  const s = String(raw || '').trim()
  const at = s.indexOf('@')
  const path = (at >= 0 ? s.slice(0, at) : s).trim()
  const target = at >= 0 ? s.slice(at + 1).trim() : ''
  return { path, target }
}

export async function sendFerry (filePath, opts = {}) {
  const port = opts.port || 9630
  const maxMB = opts.maxMB || 50
  const fetchImpl = opts.fetchImpl || fetch
  let st
  try { st = statSync(filePath) } catch (e) { return { ok: false, error: '本地文件不存在: ' + filePath } }
  if (st.isDirectory()) return { ok: false, error: '暂只支持单文件（目录请打包后传）' }
  if (st.size > maxMB * 1048576) return { ok: false, error: `超过 ${maxMB}MB 单次上限（当前 ${(st.size / 1048576).toFixed(1)}MB）` }
  const name = basename(filePath)
  const b64 = readFileSync(filePath).toString('base64')
  const res = await fetchImpl(`http://127.0.0.1:${port}/__ph/file/put`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, b64 })
  })
  const body = await res.json().catch(() => ({}))
  if (res.status !== 200 || !body.ok) return { ok: false, error: body.error || ('对端返回 ' + res.status) }
  return { ok: true, savedTo: body.savedTo, size: body.size || st.size }
}
