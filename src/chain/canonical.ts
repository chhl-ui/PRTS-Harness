import { createHash } from 'node:crypto'

export const ZERO_HASH = '0'.repeat(64)

/** 键按字典序递归排序的 JSON；undefined 值的键与 JSON.stringify 一样被丢弃。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map((item) => canonicalJson(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** 参与哈希计算的事件字段（prev_hash/hash 自身除外）。 */
export interface HashableEvent {
  seq: number
  task_id: string
  revision: number
  kind: string
  actor: unknown
  payload: unknown
  ts: number
}

export function eventHash(e: HashableEvent, prevHash: string): string {
  const { seq, task_id, revision, kind, actor, payload, ts } = e
  return sha256hex(prevHash + canonicalJson({ seq, task_id, revision, kind, actor, payload, ts }))
}
