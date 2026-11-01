/**
 * 记忆模块：**唯一**的投影更新函数。
 *
 * 与 `src/ledger/fold.ts` 同一形态：增量路径（每个事务里）与
 * `rebuildProjections`（按 seq 重放）调用同一个函数，因此投影是事件序列的纯函数。
 * 设计稿 §八 不变量 1、2。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryEventRow } from './types.ts'

interface FactAssertedPayload {
  fact_id: string
  subject: string
  predicate: string
  body_ref: string | null
  body_sha256: string | null
  provenance: 'stated' | 'inferred'
  confirmation_basis: 'owner-stated' | 'model-inferred' | 'verifier'
  origin: 'live' | 'benchmark'
  confidence: number | null
  applicable_when: string | null
  retention_class: 'permanent' | 'retirable' | 'clearable'
  source_turn_ids: string[]
  importance: number
  valid_from_ms: number | null
  valid_to_ms: number | null
}

export function applyMemoryEvent(db: DatabaseSync, e: MemoryEventRow): void {
  switch (e.kind) {
    case 'fact.asserted': {
      const p = JSON.parse(e.payload_json) as FactAssertedPayload
      db.prepare(
        `INSERT INTO mem_facts (
           fact_id, scope, subject, predicate, body_ref, valid_from_ms, valid_to_ms,
           recorded_at_ms, provenance, confirmation_basis, origin, confidence,
           revision, applicable_when, retention_class, source_turn_ids, importance
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(fact_id) DO NOTHING`,
      ).run(
        p.fact_id, e.scope, p.subject, p.predicate, p.body_ref,
        p.valid_from_ms, p.valid_to_ms, e.recorded_at_ms,
        p.provenance, p.confirmation_basis, p.origin, p.confidence,
        1, p.applicable_when, p.retention_class,
        JSON.stringify(p.source_turn_ids ?? []), p.importance,
      )
      // FTS 是投影的一部分，与 mem_facts 同一事务同步。索引文本含 subject / predicate
      // ——此前 LIKE 路径也搜这两列，换成 FTS 后不能把这份能力丢掉。
      const rid = (db.prepare('SELECT rowid AS r FROM mem_facts WHERE fact_id = ?')
        .get(p.fact_id) as { r: number } | undefined)?.r
      const obj = p.body_ref === null ? '' : (
        db.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?')
          .get(p.body_ref) as { body: string | null } | undefined
      )?.body ?? ''
      if (rid !== undefined) {
        db.prepare('INSERT INTO mem_fts_facts(rowid, body) VALUES (?,?)')
          .run(rid, `${p.subject} ${p.predicate} ${obj}`)
      }
      break
    }
    case 'turn.recorded': {
      const p = JSON.parse(e.payload_json) as {
        turn_id: string
        session_id: string
        turn_index: number
        external_id: string | null
        speaker: string
        body_ref: string
        origin: 'live' | 'benchmark'
        is_evidence: boolean
      }
      // 正文由 store 在事件前写入 mem_bodies；投影这里只写 mem_turns。
      db.prepare(
        `INSERT INTO mem_turns (
           turn_id, scope, session_id, turn_index, external_id, speaker, body_ref,
           occurred_at_ms, occurred_raw, origin, is_evidence
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(turn_id) DO NOTHING`,
      ).run(
        p.turn_id, e.scope, p.session_id, p.turn_index, p.external_id, p.speaker, p.body_ref,
        e.occurred_at_ms, e.occurred_raw, p.origin, p.is_evidence ? 1 : 0,
      )
      // 与 mem_turns 同一事务同步全文索引；rowid 对齐，检索时据此 JOIN 回投影。
      const rid = (db.prepare('SELECT rowid AS r FROM mem_turns WHERE turn_id = ?')
        .get(p.turn_id) as { r: number } | undefined)?.r
      const body = p.body_ref === null ? '' : (
        db.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?')
          .get(p.body_ref) as { body: string | null } | undefined
      )?.body ?? ''
      if (rid !== undefined && body !== '') {
        db.prepare('INSERT INTO mem_fts_turns(rowid, body) VALUES (?,?)').run(rid, body)
      }
      break
    }
    case 'memory.deleted': {
      const p = JSON.parse(e.payload_json) as {
        deletion_id: string
        target_kind: 'fact' | 'turn' | 'summary'
        target_id: string
        derivatives: string[]
      }
      // REQUESTED：写删除记录。六态在这里收成三态承载——D 是单库单事务，
      // LOCAL_PURGING 与 LOCAL_PURGED 之间没有可观测的中间状态（设计稿 §6.6）。
      db.prepare(
        `INSERT INTO mem_deletions
           (deletion_id, scope, target_json, derivatives_json, state, completed, requested_at)
         VALUES (?,?,?,?,?,0,?)`,
      ).run(
        p.deletion_id, e.scope,
        JSON.stringify({ kind: p.target_kind, id: p.target_id }),
        JSON.stringify(p.derivatives),
        'requested', e.recorded_at_ms,
      )

      // LOCAL_PURGING（同事务，不可观测）：清正文 + 投影置 deleted_at_ms。
      // 正文清空是删除生效的实体证据，只改投影不算删掉（设计稿 §9.2 R3）。
      if (p.target_kind === 'fact') {
        const row = db.prepare('SELECT rowid AS r, body_ref FROM mem_facts WHERE fact_id = ?')
          .get(p.target_id) as { r: number; body_ref: string | null } | undefined
        if (row?.body_ref) {
          db.prepare('UPDATE mem_bodies SET body = NULL WHERE body_ref = ?').run(row.body_ref)
        }
        // 索引也是派生项。正文清了但索引留着，检索仍能命中已删条目——
        // §5.3 L237「删除覆盖检索索引与派生摘要」要的正是这一条。
        if (row !== undefined) db.prepare('DELETE FROM mem_fts_facts WHERE rowid = ?').run(row.r)
        db.prepare('UPDATE mem_facts SET body_ref = NULL, deleted_at_ms = ? WHERE fact_id = ?')
          .run(e.recorded_at_ms, p.target_id)
      } else if (p.target_kind === 'turn') {
        const row = db.prepare('SELECT rowid AS r, body_ref FROM mem_turns WHERE turn_id = ?')
          .get(p.target_id) as { r: number; body_ref: string | null } | undefined
        if (row?.body_ref) {
          db.prepare('UPDATE mem_bodies SET body = NULL WHERE body_ref = ?').run(row.body_ref)
        }
        if (row !== undefined) db.prepare('DELETE FROM mem_fts_turns WHERE rowid = ?').run(row.r)
        db.prepare('UPDATE mem_turns SET body_ref = NULL, deleted_at_ms = ? WHERE turn_id = ?')
          .run(e.recorded_at_ms, p.target_id)
      }
      break
    }
    case 'deletion.derivative-done': {
      const p = JSON.parse(e.payload_json) as { deletion_id: string }
      // 自动收敛，不是手工置 completed——照 src/audit/audit.ts 的 afterWrite 形态。
      // completed_scope 必须是 'local-only'：live 正文经模型 API 出境，
      // 外部副本删不掉（设计稿 §八 第 12 条）。
      db.prepare(
        `UPDATE mem_deletions
            SET state = 'completed', completed = 1, completed_at = ?, completed_scope = 'local-only'
          WHERE deletion_id = ? AND completed = 0`,
      ).run(e.recorded_at_ms, p.deletion_id)
      break
    }
    // 其余事件种类（fact.corrected / turn.recorded / summary.generated）
    // 尚未实现——第一版只做 fact.asserted 与删除这一条纵切。
    // **未实现的分支不静默忽略**：
    default:
      throw new Error(`memory: 未实现的事件种类 ${e.kind}`)
  }
}
