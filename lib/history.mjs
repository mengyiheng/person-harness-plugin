// 连接历史（V4.3）——只落 Agent 电脑本地的 JSONL，两行式 open/close：
//   连接建立即写 open 行（毫秒级落盘）；断开补 close 行（路径/时长）；断电由启动自愈补 close(abnormal)
// 滚动清理：单文件超 5MB 重命名为 .old（保留一代），永不膨胀。云端没有任何副本。
import { appendFileSync, existsSync, readFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

export function historyFileFor (dir) { return join(dir, 'connection-history.jsonl') }

export function record (file, e) {
  try {
    maybeRollover(file)
    appendFileSync(file, JSON.stringify({ ...e, t: new Date().toISOString() }) + '\n')
  } catch (e2) { /* 历史记录失败不影响主流程 */ }
}

/** 启动自愈：为未闭合的 open 行补 close(abnormal)，返回补写条数 */
export function repair (file) {
  try {
    if (!existsSync(file)) return 0
    const opens = new Map()
    for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(l)
        if (e.ev === 'open') opens.set(e.attachId, e)
        else if (e.ev === 'close') opens.delete(e.attachId)
      } catch { /* 跳过坏行 */ }
    }
    let n = 0
    for (const [attachId, e] of opens) {
      record(file, { ev: 'close', attachId, peer: e.peer, seq: e.seq, path: e.path, reason: 'abnormal' })
      n++
    }
    return n
  } catch (e) { return 0 }
}

/** 会话视图：open/close 配对成"一次连接"，未闭合的显示为进行中；返回最近 limit 条 */
export function sessions (file, limit = 20) {
  if (!existsSync(file)) return []
  const evs = []
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { evs.push(JSON.parse(l)) } catch { /* 跳过坏行 */ }
  }
  const opens = new Map()
  const out = []
  const finish = (attachId, o, c) => ({
    start: o.t, end: c?.t ?? null, peer: o.peer, seq: o.seq,
    path: c?.path ?? o.path ?? 'relay',
    durSec: c ? Math.max(0, Math.round((new Date(c.t) - new Date(o.t)) / 1000)) : null,
    reason: c?.reason ?? null
  })
  for (const e of evs) {
    if (e.ev === 'open') {
      if (opens.has(e.attachId)) out.push(finish(e.attachId, opens.get(e.attachId), { t: e.t, reason: 'abnormal' }))
      opens.set(e.attachId, e)
    } else if (e.ev === 'close') {
      const o = opens.get(e.attachId)
      if (o) { opens.delete(e.attachId); out.push(finish(e.attachId, o, e)) }
    }
  }
  for (const [attachId, o] of opens) out.push(finish(attachId, o, null))
  return out.slice(-limit)
}

function maybeRollover (file) {
  try {
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, file + '.old')
  } catch (e) { /* 忽略 */ }
}
