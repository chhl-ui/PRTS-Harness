/**
 * 记忆模块：派生项写入原语。
 *
 * 为什么从 `MemoryStore` 抽出来：`putProfile` / `putSummary` 原先只以类方法存在，
 * 而巩固管线（`consolidate.ts`）只拿得到 `DatabaseSync`，不能反向依赖 store 实例。
 * 两处各写一份 SQL 迟早会漂移——尤其 FTS 同步这种「少一行就静默查不到」的地方。
 * 所以抽成纯函数，store 与巩固管线共用同一份实现。
 *
 * 约定：调用方负责事务边界。这些函数内部不再 BEGIN/COMMIT——巩固管线要把
 * 「写画像 + 写摘要 + 推进水位线」放进同一个事务，嵌套 BEGIN 会直接报错。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { sha256hex } from '../chain/index.ts'
import type { Origin } from './types.ts'

const SCOPE = 'prts'

export interface WriteProfileInput {
  subject: string
  aspect: string
  profileText: string
  evidenceFactIds?: string[]
  confidence?: number
  origin?: Origin
  profileId?: string
}

/** 写入（或按 profileId 覆盖）一条画像，并同步 FTS。返回 profile_id。 */
export function writeProfile(db: DatabaseSync, input: WriteProfileInput, nowMs = Date.now()): string {
  const id = input.profileId ?? `prof-${randomUUID()}`
  db.prepare(
    `INSERT INTO mem_profiles
       (profile_id, scope, origin, subject, aspect, profile_body, evidence_fact_ids, confidence, updated_at_ms)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(profile_id) DO UPDATE SET
       origin = excluded.origin, subject = excluded.subject, aspect = excluded.aspect,
       profile_body = excluded.profile_body, evidence_fact_ids = excluded.evidence_fact_ids,
       confidence = excluded.confidence, updated_at_ms = excluded.updated_at_ms`,
  ).run(
    id, SCOPE, input.origin ?? 'live', input.subject, input.aspect, input.profileText,
    JSON.stringify(input.evidenceFactIds ?? []), input.confidence ?? 0.5, nowMs,
  )
  // FTS 是投影的一部分，与主表同一事务同步；不同步的话 bm25 路永远查不到新画像
  db.prepare('DELETE FROM mem_fts_profiles WHERE rowid = (SELECT rowid FROM mem_profiles WHERE profile_id = ?)').run(id)
  db.prepare('INSERT INTO mem_fts_profiles(rowid, body) SELECT rowid, profile_body FROM mem_profiles WHERE profile_id = ?').run(id)
  return id
}

export interface WriteSummaryInput {
  subjectKind: string
  subjectId: string
  text: string
  sourceTurnIds?: string[]
  origin?: Origin
  summaryId?: string
}

/** 写入（或按 summaryId 覆盖）一条摘要，正文走 mem_bodies，并同步 FTS。 */
export function writeSummary(db: DatabaseSync, input: WriteSummaryInput, nowMs = Date.now()): string {
  const id = input.summaryId ?? `sum-${randomUUID()}`
  const bodyRef = `body-${randomUUID()}`

  // 覆盖时先清掉旧正文与旧 FTS 行，避免留下孤儿
  const prev = db.prepare('SELECT rowid AS r, body_ref FROM mem_summaries WHERE summary_id = ?')
    .get(id) as { r: number; body_ref: string | null } | undefined
  if (prev !== undefined) {
    if (prev.body_ref !== null) db.prepare('DELETE FROM mem_bodies WHERE body_ref = ?').run(prev.body_ref)
    db.prepare('DELETE FROM mem_fts_summaries WHERE rowid = ?').run(prev.r)
  }

  db.prepare(
    'INSERT INTO mem_bodies (body_ref, sha256, body, byte_length, written_at_ms) VALUES (?,?,?,?,?)',
  ).run(bodyRef, sha256hex(input.text), input.text, Buffer.byteLength(input.text, 'utf8'), nowMs)

  db.prepare(
    `INSERT INTO mem_summaries
       (summary_id, scope, origin, subject_kind, subject_id, body_ref, source_turn_ids, generated_at_ms)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(summary_id) DO UPDATE SET
       origin = excluded.origin, subject_kind = excluded.subject_kind,
       subject_id = excluded.subject_id, body_ref = excluded.body_ref,
       source_turn_ids = excluded.source_turn_ids, generated_at_ms = excluded.generated_at_ms`,
  ).run(id, SCOPE, input.origin ?? 'live', input.subjectKind, input.subjectId, bodyRef,
    JSON.stringify(input.sourceTurnIds ?? []), nowMs)

  const rid = (db.prepare('SELECT rowid AS r FROM mem_summaries WHERE summary_id = ?').get(id) as { r: number }).r
  db.prepare('INSERT INTO mem_fts_summaries(rowid, body) VALUES (?,?)').run(rid, input.text)
  return id
}
