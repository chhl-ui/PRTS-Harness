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
      break
    }
    // 其余事件种类（fact.corrected / turn.recorded / summary.generated /
    // memory.deleted / deletion.derivative-done）尚未实现——第一版只做
    // fact.asserted 这一条纵切。**未实现的分支不静默忽略**：
    default:
      throw new Error(`memory: 未实现的事件种类 ${e.kind}`)
  }
}
