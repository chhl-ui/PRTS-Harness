/**
 * 记忆模块：存储与检索。
 *
 * 事实来源是 `memory_events`（只追加哈希链），`mem_facts` 等是投影。
 * 每个变更在一个事务内「追加事件 + 应用投影」，投影只由 `fold.ts` 更新。
 *
 * 第一版只实现 `fact.asserted` 一条纵切（设计稿 §二 的范围）；检索统一走
 * `LIKE`（设计稿 §6.5），转义 `%` / `_` / `\`，不做相关度打分——`LIKE` 是
 * 布尔匹配，排序只用「时近衰减 × (0.5 + importance)」。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { appendChained, sha256hex, verifyChainRows, type ChainVerifyResult } from '../chain/index.ts'
import { applyMemoryEvent } from './fold.ts'
import { openMemoryDb } from './schema.ts'
import { parseTime } from './time.ts'
import { tokenize } from './tokenize.ts'
import type {
  ActorKind, AssertFactInput, ImportStats, MemoryEventKind, MemoryEventRow, MemoryHit, MemoryQuery, Origin, RecallPath, RecordTurnInput,
} from './types.ts'

const SCOPE = 'prts'
const DEFAULT_LIMIT = 20

/** `LIKE` 通配符转义。不转义时一条含 `%` 的提问会命中全表（设计稿 §6.5）。 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** 命中几个查询词——`LIKE` 不产生相关度分，这是它的代替品。 */
function countHits(body: string | null, tokens: string[]): number {
  if (!body) return 0
  const lower = body.toLowerCase()
  return tokens.filter((t) => lower.includes(t)).length
}

/** 时近衰减：半衰期 30 天。与 importance 一起构成第一版的全部排序信号。 */
function recency(recordedAtMs: number, nowMs: number): number {
  const days = Math.max(0, (nowMs - recordedAtMs) / 86_400_000)
  return 1 / (1 + days / 30)
}

export class MemoryStore {
  private readonly db: DatabaseSync

  // 不用参数属性：项目只允许可擦除语法（AGENTS.md「语法约束」）。
  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(path: string): MemoryStore {
    return new MemoryStore(openMemoryDb(path))
  }

  close(): void {
    this.db.close()
  }

  /**
   * 写入一条语义事实。
   *
   * 正文（object）外置到 `mem_bodies`，事件 payload 只存 `body_ref` 与
   * `body_sha256`——这样删除时清 body 即可，链保持完整（设计稿 §七 路线 D）。
   */
  assertFact(input: AssertFactInput): string {
    const now = Date.now()
    const factId = `fact-${randomUUID()}`
    const bodyRef = `body-${randomUUID()}`
    const bodySha = sha256hex(input.object)
    const origin: Origin = input.origin ?? 'live'

    const payload = {
      fact_id: factId,
      subject: input.subject,
      predicate: input.predicate,
      body_ref: bodyRef,
      body_sha256: bodySha,
      provenance: input.provenance,
      confirmation_basis: input.confirmationBasis,
      origin,
      confidence: null,
      applicable_when: null,
      retention_class: input.retentionClass ?? 'clearable',
      source_turn_ids: input.sourceTurnIds ?? [],
      importance: input.importance ?? 0.5,
      valid_from_ms: input.validFromMs ?? null,
      valid_to_ms: input.validToMs ?? null,
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO mem_bodies (body_ref, sha256, body, byte_length, written_at_ms)
         VALUES (?,?,?,?,?)`,
      ).run(bodyRef, bodySha, input.object, Buffer.byteLength(input.object, 'utf8'), now)

      this.appendEvent({
        kind: 'fact.asserted',
        actor: input.actor,
        recordedAtMs: now,
        occurredAtMs: payload.valid_from_ms,
        payload,
      })

      this.db.exec('COMMIT')
      return factId
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 检索。`origin` 默认只含 `'live'`——基准数据不进验收路径（设计稿 §6.4）。
   * 永不返回 `deleted_at_ms` 非空的行；`retired_at_ms` 非空的默认也不返回。
   */
  /** 追加一条事件并把投影、正文在**同一事务**内更新（调用方负责 BEGIN/COMMIT）。 */
  private appendEvent(input: {
    kind: MemoryEventKind
    actor: ActorKind
    recordedAtMs: number
    payload: Record<string, unknown>
    occurredAtMs?: number | null
    occurredRaw?: string | null
  }): void {
    const fields = {
      event_id: `evt-${randomUUID()}`,
      kind: input.kind,
      occurred_at_ms: input.occurredAtMs ?? null,
      occurred_raw: input.occurredRaw ?? null,
      recorded_at_ms: input.recordedAtMs,
      actor_kind: input.actor,
      scope: SCOPE,
      payload_json: JSON.stringify(input.payload),
    }
    const chained = appendChained(this.db, 'memory_events', fields, (f) => ({
      event_id: f.event_id as string,
      kind: f.kind as string,
      occurred_at_ms: f.occurred_at_ms as number | null,
      occurred_raw: f.occurred_raw as string | null,
      recorded_at_ms: f.recorded_at_ms as number,
      actor_kind: f.actor_kind as string,
      scope: f.scope as string,
      payload_json: f.payload_json as string,
      seq: f.seq as number,
      prev_hash: f.prev_hash as string,
      hash: f.hash as string,
    }))
    applyMemoryEvent(this.db, {
      seq: chained.seq,
      event_id: fields.event_id,
      kind: input.kind,
      occurred_at_ms: fields.occurred_at_ms,
      occurred_raw: fields.occurred_raw,
      recorded_at_ms: fields.recorded_at_ms,
      actor_kind: input.actor,
      scope: SCOPE,
      payload_json: fields.payload_json,
      prev_hash: chained.prev_hash,
      hash: chained.hash,
    })
  }

  /**
   * 删除一条事实。
   *
   * 追加两条事件（`memory.deleted` + `deletion.derivative-done`）；投影与正文
   * 在同一事务内更新。**链保持完整**——删除是追加，不是改历史（设计稿 §6.6）。
   */
  deleteFact(input: { actor: ActorKind; factId: string }): string {
    const now = Date.now()
    const deletionId = `del-${randomUUID()}`

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.appendEvent({
        kind: 'memory.deleted',
        actor: input.actor,
        recordedAtMs: now,
        payload: {
          deletion_id: deletionId,
          target_kind: 'fact',
          target_id: input.factId,
          derivatives: ['body', 'projection'],
        },
      })
      this.appendEvent({
        kind: 'deletion.derivative-done',
        actor: input.actor,
        recordedAtMs: now,
        payload: { deletion_id: deletionId },
      })
      this.db.exec('COMMIT')
      return deletionId
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 记录一条对话回合。
   *
   * 正文外置到 `mem_bodies`；事件的 `occurred_raw` 保留原始时间串，
   * `occurred_at_ms` 由 `parseTime` 解析——**解析失败也不丢原始串**（设计稿 §6.3）。
   */
  recordTurn(input: RecordTurnInput): string {
    const now = Date.now()
    const turnId = input.dedupeKey === undefined
      ? `turn-${randomUUID()}`
      : `turn-${sha256hex(input.dedupeKey).slice(0, 32)}`

    // 幂等：同一 dedupeKey 已存在就直接返回，不重写 body、不追加事件。
    if (this.db.prepare('SELECT 1 AS x FROM mem_turns WHERE turn_id = ?').get(turnId) !== undefined) {
      return turnId
    }
    const bodyRef = `body-${randomUUID()}`
    const bodySha = sha256hex(input.text)
    const occurredRaw = input.occurredRaw ?? null
    const occurredAtMs = occurredRaw === null ? null : parseTime(occurredRaw)

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO mem_bodies (body_ref, sha256, body, byte_length, written_at_ms)
         VALUES (?,?,?,?,?)`,
      ).run(bodyRef, bodySha, input.text, Buffer.byteLength(input.text, 'utf8'), now)

      this.appendEvent({
        kind: 'turn.recorded',
        actor: input.actor,
        recordedAtMs: now,
        occurredAtMs,
        occurredRaw,
        payload: {
          turn_id: turnId,
          session_id: input.sessionId,
          turn_index: input.turnIndex,
          external_id: input.externalId ?? null,
          speaker: input.speaker,
          body_ref: bodyRef,
          body_sha256: bodySha,
          origin: input.origin ?? 'live',
          is_evidence: input.isEvidence ?? false,
        },
      })
      this.db.exec('COMMIT')
      return turnId
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  search(q: MemoryQuery): MemoryHit[] {
    const nowMs = q.nowMs ?? Date.now()
    const origins = q.includeOrigin ?? ['live']
    if (origins.length === 0) return []
    const scope = q.scope ?? SCOPE
    const limit = q.limit ?? DEFAULT_LIMIT
    const tokens = tokenize(q.text)
    if (tokens.length === 0) return []
    const pats = tokens.map((t) => `%${escapeLike(t)}%`)
    // 任一词命中即召回；命中数与 score 相乘充当相关度代理。
    const factConds = tokens
      .map(() => "(b.body LIKE ? ESCAPE '\\' OR f.subject LIKE ? ESCAPE '\\' OR f.predicate LIKE ? ESCAPE '\\')")
      .join(' OR ')
    const turnConds = tokens.map(() => "b.body LIKE ? ESCAPE '\\'").join(' OR ')
    const originSlots = origins.map(() => '?').join(',')

    // 相关度必须在 SQL 层表达。`LIMIT` 在 `ORDER BY` 之前生效，不排序的
    // `LIMIT limit*4` 等于「按扫描顺序随便取 limit*4 行」——LongMemEval 全库口径下
    // 平均每题有 4113 行满足 `LIKE` 条件，任取 80 行让证据 turn 的召回率掉到 2.1%；
    // 去掉截断是 43.4%。截断没错，错在没有排序（见 .scratch/probe-recall-decompose.mjs
    // 与 test/memory/recall.test.ts 的两个用例）。
    const factHitExpr = tokens
      .map(() => `(CASE WHEN b.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
                     + CASE WHEN f.subject LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
                     + CASE WHEN f.predicate LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
      .join(' + ')
    const rows = this.db.prepare(
      `SELECT f.fact_id, f.provenance, f.origin, f.importance, f.recorded_at_ms, b.body,
              (${factHitExpr}) AS hit_count
         FROM mem_facts f
         LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
        WHERE f.scope = ?
          AND f.deleted_at_ms IS NULL
          AND f.retired_at_ms IS NULL
          AND f.origin IN (${originSlots})
          AND (${factConds})
        ORDER BY hit_count DESC, f.recorded_at_ms DESC
        LIMIT ?`,
    ).all(
      ...pats.flatMap((p) => [p, p, p]), // SELECT 里的相关度表达式
      scope, ...origins,
      ...pats.flatMap((p) => [p, p, p]), // WHERE 里的命中条件
      limit * 4,
    ) as Array<{
      fact_id: string
      provenance: 'stated' | 'inferred'
      origin: Origin
      importance: number
      recorded_at_ms: number
      body: string | null
    }>

    const recallPath: RecallPath = 'like'
    const factHits: MemoryHit[] = rows.map((r) => ({
      kind: 'fact' as const,
      id: r.fact_id,
      score: recency(r.recorded_at_ms, nowMs) * (0.5 + r.importance) * (1 + countHits(r.body, tokens)),
      provenance: r.provenance,
      origin: r.origin,
      text: r.body ?? '',
      recallPath,
    }))

    // turn 与 fact 走同一套 LIKE 召回；turn 没有 importance 列，
    // 排序只用时间（有 occurred_at_ms 就用它，没有就退化为固定值）。
    const turnHitExpr = tokens
      .map(() => `(CASE WHEN b.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
      .join(' + ')
    const turnRows = this.db.prepare(
      `SELECT t.turn_id, t.session_id, t.turn_index, t.external_id, t.origin,
              t.occurred_at_ms, b.body,
              (${turnHitExpr}) AS hit_count
         FROM mem_turns t
         LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE t.scope = ?
          AND t.deleted_at_ms IS NULL
          AND t.origin IN (${originSlots})
          AND (${turnConds})
        ORDER BY hit_count DESC, t.occurred_at_ms IS NULL, t.occurred_at_ms DESC
        LIMIT ?`,
    ).all(
      ...pats, // SELECT 里的相关度表达式
      scope, ...origins,
      ...pats, // WHERE 里的命中条件
      limit * 4,
    ) as unknown as Array<{
      turn_id: string
      session_id: string
      turn_index: number
      external_id: string | null
      origin: Origin
      occurred_at_ms: number | null
      body: string | null
    }>

    const turnHits: MemoryHit[] = turnRows.map((r) => ({
      kind: 'turn' as const,
      id: r.turn_id,
      score: (r.occurred_at_ms === null ? 0.5 : recency(r.occurred_at_ms, nowMs)) * (1 + countHits(r.body, tokens)),
      origin: r.origin,
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      ...(r.external_id === null ? {} : { externalId: r.external_id }),
      text: r.body ?? '',
      recallPath,
    }))

    return [...factHits, ...turnHits].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * 按 seq 重放事件，重建全部投影。
   *
   * 与增量路径调用**同一个** `applyMemoryEvent`（`src/ledger/fold.ts:50-53` 的形态），
   * 因此投影是事件序列的纯函数。`mem_bodies` 不在重建范内——它是链外正文，
   * 不是投影（设计稿 §6.2）。
   */
  /**
   * 导入 LoCoMo 结构（`locomo10.json`）。
   *
   * 结构实测（2026-11-01）：每个 sample 有 `sample_id` 与 `conversation`；
   * `conversation` 里 `session_<N>` 是 turn 数组，`session_<N>_date_time` 是
   * **自由文本时间**（`"1:56 pm on 8 May, 2023"`），turn 有 `speaker` / `dia_id` / `text`。
   *
   * 导入的 turn 一律 `origin='benchmark'`——默认不进验收路径（设计稿 §6.4）。
   * `dedupeKey` 让重复导入幂等。
   */
  importLoCoMo(data: unknown): ImportStats {
    if (!Array.isArray(data)) throw new Error('memory: importLoCoMo 需要数组')
    let sessions = 0
    let turns = 0
    let unparsedTime = 0

    for (const raw of data) {
      const sample = raw as { sample_id?: string; conversation?: Record<string, unknown> }
      const sampleId = sample.sample_id ?? 'unknown'
      const conv = sample.conversation ?? {}

      for (const key of Object.keys(conv)) {
        if (!/^session_\d+$/.test(key)) continue
        const list = conv[key]
        if (!Array.isArray(list)) continue

        const dateRaw = conv[`${key}_date_time`]
        const occurredRaw = typeof dateRaw === 'string' ? dateRaw : undefined
        if (occurredRaw !== undefined && parseTime(occurredRaw) === null) unparsedTime++
        sessions++

        list.forEach((t, i) => {
          const turn = t as { speaker?: string; dia_id?: string; text?: string }
          this.recordTurn({
            actor: 'system',
            sessionId: `${sampleId}/${key}`,
            turnIndex: i,
            ...(turn.dia_id === undefined ? {} : { externalId: turn.dia_id }),
            speaker: turn.speaker ?? 'unknown',
            text: turn.text ?? '',
            ...(occurredRaw === undefined ? {} : { occurredRaw }),
            origin: 'benchmark',
            dedupeKey: `${sampleId}|${key}|${i}`,
          })
          turns++
        })
      }
    }
    return { sessions, turns, evidence: 0, unparsedTime }
  }

  /**
   * 导入 LongMemEval 结构（`longmemeval_oracle.json` 等）。
   *
   * 实测字段：`question_id` / `haystack_session_ids` / `haystack_dates` /
   * `haystack_sessions`（每会话是一个 turn 列表，turn 是 `{role, content}`，
   * 证据 turn 额外带 `has_answer: true`）。
   *
   * `sessionId` 带 `question_id` 前缀——不同 question 的 `haystack_session_ids`
   * 可能重名，不加前缀会撞车。
   */
  importLongMemEval(data: unknown): ImportStats {
    if (!Array.isArray(data)) throw new Error('memory: importLongMemEval 需要数组')
    let sessions = 0
    let turns = 0
    let evidence = 0
    let unparsedTime = 0

    for (const raw of data) {
      const q = raw as {
        question_id?: string
        haystack_session_ids?: string[]
        haystack_dates?: string[]
        haystack_sessions?: Array<Array<{ role?: string; content?: string; has_answer?: boolean }>>
      }
      const qid = q.question_id ?? 'unknown'
      const ids = q.haystack_session_ids ?? []
      const dates = q.haystack_dates ?? []

      ;(q.haystack_sessions ?? []).forEach((turnList, si) => {
        const sid = ids[si] ?? `s${si}`
        const dateRaw = dates[si]
        if (typeof dateRaw === 'string' && parseTime(dateRaw) === null) unparsedTime++
        sessions++

        turnList.forEach((t, ti) => {
          const isEvidence = t.has_answer === true
          if (isEvidence) evidence++
          this.recordTurn({
            actor: 'system',
            sessionId: `${qid}/${sid}`,
            turnIndex: ti,
            speaker: t.role ?? 'unknown',
            text: t.content ?? '',
            ...(typeof dateRaw === 'string' ? { occurredRaw: dateRaw } : {}),
            origin: 'benchmark',
            isEvidence,
            dedupeKey: `${qid}|${sid}|${ti}`,
          })
          turns++
        })
      })
    }
    return { sessions, turns, evidence, unparsedTime }
  }

  rebuildProjections(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM mem_turns; DELETE FROM mem_facts; DELETE FROM mem_summaries; DELETE FROM mem_topics; DELETE FROM mem_deletions')
      const rows = this.db.prepare('SELECT * FROM memory_events ORDER BY seq')
        .all() as unknown as MemoryEventRow[]
      for (const r of rows) applyMemoryEvent(this.db, r)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 链校验。投影是事件序列的纯函数，链断则投影不可信。 */
  verifyChain(): ChainVerifyResult {
    const rows = this.db.prepare(
      `SELECT seq, prev_hash, hash, event_id, kind, occurred_at_ms, occurred_raw,
              recorded_at_ms, actor_kind, scope, payload_json
         FROM memory_events ORDER BY seq`,
    ).all() as unknown as Array<MemoryEventRow & { seq: number }>
    return verifyChainRows(rows, (r) => ({
      // appendChained 把 seq 一起算进 hash（chainHash(prev, {...fields, seq})），
      // toFields 必须还原同一个字段集，否则每条都会重算不一致。
      seq: r.seq,
      event_id: r.event_id,
      kind: r.kind,
      occurred_at_ms: r.occurred_at_ms,
      occurred_raw: r.occurred_raw,
      recorded_at_ms: r.recorded_at_ms,
      actor_kind: r.actor_kind,
      scope: r.scope,
      payload_json: r.payload_json,
    }))
  }
}
