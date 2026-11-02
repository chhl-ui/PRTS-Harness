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
      // 身份键是**去重键**（subject|predicate|object 规范化），不是「更新」判定：
      // 「博士 偏好 50mm」与「博士 偏好 85mm」是两条并存的取值，字符串分不出哪个
      // 取代哪个——那是 fact.corrected 的显式职责，不能自动推断。这里只保证
      // 「完全相同的事实重复写入不产生第二条」，抽取反复抽到同一句时靠它兜住。
      //
      // **已退役的行不算重复**（Wave 5）：主人重新说了一遍曾淡忘的事，必须能被重新
      // 记住。若把退役行当 dup，记忆就变成单向失忆——淡忘之后说什么都想不起来。
      // 新行带新的写入时间与强度，旧行保持退役历史，两者都在链上。
      const identityKey = (p as { identity_key?: string }).identity_key
        ?? `${p.subject.trim().toLowerCase()}|${p.predicate.trim().toLowerCase()}|${p.body_sha256 ?? ''}`
      const dup = db.prepare(
        `SELECT fact_id FROM mem_facts
          WHERE identity_key = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL LIMIT 1`,
      ).get(identityKey) as { fact_id: string } | undefined

      if (dup === undefined) {
        db.prepare(
          `INSERT INTO mem_facts (
             fact_id, scope, subject, predicate, identity_key, body_ref, valid_from_ms, valid_to_ms,
             recorded_at_ms, provenance, confirmation_basis, origin, confidence,
             revision, applicable_when, retention_class, source_turn_ids, importance, slot
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(fact_id) DO NOTHING`,
        ).run(
          p.fact_id, e.scope, p.subject, p.predicate, identityKey, p.body_ref,
          p.valid_from_ms, p.valid_to_ms, e.recorded_at_ms,
          p.provenance, p.confirmation_basis, p.origin, p.confidence,
          1, p.applicable_when, p.retention_class,
          JSON.stringify(p.source_turn_ids ?? []), p.importance,
          (p as { slot?: string | null }).slot ?? null,
        )
      }
      // FTS 是投影的一部分，与 mem_facts 同一事务同步。索引文本含 subject / predicate /
      // slot——此前 LIKE 路径也搜这两列，换成 FTS 后不能把这份能力丢掉；
      // slot 进索引让「咖啡」这类查询能命中 object 为「拿铁」的事实。
      const rid = (db.prepare('SELECT rowid AS r FROM mem_facts WHERE fact_id = ?')
        .get(p.fact_id) as { r: number } | undefined)?.r
      const obj = p.body_ref === null ? '' : (
        db.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?')
          .get(p.body_ref) as { body: string | null } | undefined
      )?.body ?? ''
      if (rid !== undefined) {
        db.prepare('INSERT INTO mem_fts_facts(rowid, body) VALUES (?,?)')
          .run(rid, `${p.subject} ${p.predicate} ${(p as { slot?: string | null }).slot ?? ''} ${obj}`)
      }
      break
    }
    case 'fact.corrected': {
      const p = JSON.parse(e.payload_json) as FactAssertedPayload & {
        fact_id: string
        new_fact_id: string
      }
      // 新行：与 fact.asserted 同一插入（correctFact 已保证新 id 不与现有行撞）。
      db.prepare(
        `INSERT INTO mem_facts (
           fact_id, scope, subject, predicate, identity_key, body_ref, valid_from_ms, valid_to_ms,
           recorded_at_ms, provenance, confirmation_basis, origin, confidence,
           revision, applicable_when, retention_class, source_turn_ids, importance, slot
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(fact_id) DO NOTHING`,
      ).run(
        p.new_fact_id, e.scope, p.subject, p.predicate,
        (p as { identity_key?: string }).identity_key
          ?? `${p.subject.trim().toLowerCase()}|${p.predicate.trim().toLowerCase()}|${p.body_sha256 ?? ''}`,
        p.body_ref,
        p.valid_from_ms ?? null, p.valid_to_ms ?? null, e.recorded_at_ms,
        p.provenance, p.confirmation_basis, p.origin, p.confidence ?? null,
        1, p.applicable_when ?? null, p.retention_class,
        JSON.stringify(p.source_turn_ids ?? []), p.importance,
        (p as { slot?: string | null }).slot ?? null,
      )
      const rid = (db.prepare('SELECT rowid AS r FROM mem_facts WHERE fact_id = ?')
        .get(p.new_fact_id) as { r: number } | undefined)?.r
      const obj = p.body_ref === null ? '' : (
        db.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?')
          .get(p.body_ref) as { body: string | null } | undefined
      )?.body ?? ''
      if (rid !== undefined) {
        db.prepare('INSERT INTO mem_fts_facts(rowid, body) VALUES (?,?)')
          .run(rid, `${p.subject} ${p.predicate} ${(p as { slot?: string | null }).slot ?? ''} ${obj}`)
      }
      // 旧行退役 + 指向新行——纠正可逆靠 superseded_by 找回旧值。
      db.prepare(
        `UPDATE mem_facts SET retired_at_ms = ?, superseded_by = ?
          WHERE fact_id = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL`,
      ).run(e.recorded_at_ms, p.new_fact_id, p.fact_id)
      break
    }
    case 'fact.retired': {
      const p = JSON.parse(e.payload_json) as {
        fact_id: string
        reason: string
        threshold?: number
        effective_importance?: number
        age_days?: number
        /** 同槽取代时填新事实 id——与 fact.corrected 同一形状，找回旧值靠它。 */
        superseded_by?: string
      }
      // 退役 = 置 `retired_at_ms`，**不动正文、不动 FTS 索引**：这是可逆档，
      // 与 memory.deleted（清正文 + 删索引，不可逆）是两回事。
      //
      // `AND retired_at_ms IS NULL` 让重复退役幂等：重放同一序列时状态一致，
      // 且不会用第二次的时间覆盖第一次——退役时间是「首次降档」的事实。
      db.prepare(
        'UPDATE mem_facts SET retired_at_ms = ?, superseded_by = COALESCE(?, superseded_by) WHERE fact_id = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL',
      ).run(e.recorded_at_ms, p.superseded_by ?? null, p.fact_id)
      break
    }
    case 'fact.restored': {
      const p = JSON.parse(e.payload_json) as { fact_id: string; reason: string }
      // 恢复只清退役标记：已删除（deleted_at_ms 非空）的条目正文已清空，
      // 恢复它等于恢复一条空事实，必须拒绝。
      db.prepare(
        'UPDATE mem_facts SET retired_at_ms = NULL WHERE fact_id = ? AND deleted_at_ms IS NULL',
      ).run(p.fact_id)
      break
    }
    case 'fact.reinforced': {
      const p = JSON.parse(e.payload_json) as {
        fact_id: string
        access_count: number
        last_access_ms: number
      }
      // 存**绝对量**而不是 `access_count = access_count + 1`：重放时同一批事件
      // 必然得到同一结果，不会因为重建次数不同而漂移。
      // 幂等性是「重放确定性」，不是「重复执行无副作用」——后者由 reinforceFacts
      // 只在当前值基础上 +1 保证。
      db.prepare(
        'UPDATE mem_facts SET access_count = ?, last_access_ms = ? WHERE fact_id = ? AND deleted_at_ms IS NULL',
      ).run(p.access_count, p.last_access_ms, p.fact_id)
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

      // 维护 session 级索引（v2.12）。必须在写入路径上做——只在 open 时补建的话，
      // 本次会话新写的 turn 不会被 session 索引覆盖，检索阶段一选不到它所在会话，
      // 第二阶段就被过滤掉了：静默的「刚说的记不住」。
      // 单个 session 约 10 turn，重算成本可忽略。
      const sess = db.prepare(
        `SELECT group_concat(b2.body, ' ') AS body, count(*) AS n
           FROM mem_turns t2 JOIN mem_bodies b2 ON b2.body_ref = t2.body_ref
          WHERE t2.session_id = ? AND b2.body IS NOT NULL AND t2.deleted_at_ms IS NULL`,
      ).get(p.session_id) as { body: string | null; n: number } | undefined
      if (sess !== undefined && sess.body !== null && sess.body !== '') {
        db.prepare(
          `INSERT INTO mem_sessions (session_id, scope, origin, body, turn_count, updated_at_ms)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(session_id) DO UPDATE SET body = excluded.body,
             turn_count = excluded.turn_count, updated_at_ms = excluded.updated_at_ms`,
        ).run(p.session_id, e.scope, p.origin, sess.body, sess.n, e.recorded_at_ms)
        db.prepare('DELETE FROM mem_fts_sessions WHERE rowid = (SELECT rowid FROM mem_sessions WHERE session_id = ?)').run(p.session_id)
        db.prepare('INSERT INTO mem_fts_sessions(rowid, body) SELECT rowid, body FROM mem_sessions WHERE session_id = ?').run(p.session_id)
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
