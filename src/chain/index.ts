/** 共享追加式哈希链模块：K1 账本与 K4 审计同一条链原语。 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { canonicalJson, sha256hex, ZERO_HASH } from './canonical.ts'

export { canonicalJson, sha256hex, ZERO_HASH } from './canonical.ts'
export { eventHash } from './canonical.ts'
export type { HashableEvent } from './canonical.ts'

export function chainHash(prevHash: string, fields: Record<string, unknown>): string {
  return sha256hex(prevHash + canonicalJson(fields))
}

export interface ChainedRow {
  seq: number
  prev_hash: string
  hash: string
}

/**
 * 在调用方事务内追加一条链上事件：取 MAX(seq)+1 与上一条 hash，
 * 计算本条 hash，INSERT，返回 {seq, prev_hash, hash}。
 * 哈希输入 = {seq, ...fields}；encode 把完整字段（含 seq/prev_hash/hash）映射为列值。
 */
export function appendChained(
  db: DatabaseSync,
  table: string,
  fields: Record<string, unknown>,
  encode: (fields: Record<string, unknown>) => Record<string, SQLInputValue>,
): ChainedRow {
  const seq = (db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM ${table}`).get() as { s: number }).s
  const last = db.prepare(`SELECT hash FROM ${table} ORDER BY seq DESC LIMIT 1`).get() as { hash: string } | undefined
  const prev_hash = last?.hash ?? ZERO_HASH
  const hash = chainHash(prev_hash, { ...fields, seq })
  const cols = encode({ ...fields, seq, prev_hash, hash })
  const names = Object.keys(cols)
  db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map((n) => cols[n]))
  return { seq, prev_hash, hash }
}

export type ChainVerifyResult =
  | { ok: true; events: number }
  | { ok: false; brokenAtSeq: number }

/** 对按 seq 升序的行集校验链：prev 衔接 + 逐条重算 hash。 */
export function verifyChainRows<Row extends ChainedRow>(
  rows: Row[],
  toFields: (row: Row) => Record<string, unknown>,
): ChainVerifyResult {
  let prev = ZERO_HASH
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, brokenAtSeq: r.seq }
    if (chainHash(prev, toFields(r)) !== r.hash) return { ok: false, brokenAtSeq: r.seq }
    prev = r.hash
  }
  return { ok: true, events: rows.length }
}
