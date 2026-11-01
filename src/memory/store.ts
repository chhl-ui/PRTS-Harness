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
import type {
  AssertFactInput, MemoryEventRow, MemoryHit, MemoryQuery, Origin, RecallPath,
} from './types.ts'

const SCOPE = 'prts'
const DEFAULT_LIMIT = 20

/** `LIKE` 通配符转义。不转义时一条含 `%` 的提问会命中全表（设计稿 §6.5）。 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
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

      const chained = appendChained(
        this.db,
        'memory_events',
        {
          event_id: `evt-${randomUUID()}`,
          kind: 'fact.asserted',
          occurred_at_ms: payload.valid_from_ms,
          occurred_raw: null,
          recorded_at_ms: now,
          actor_kind: input.actor,
          scope: SCOPE,
          payload_json: JSON.stringify(payload),
        },
        (f) => ({
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
        }),
      )

      applyMemoryEvent(this.db, {
        seq: chained.seq,
        event_id: '',
        kind: 'fact.asserted',
        occurred_at_ms: payload.valid_from_ms,
        occurred_raw: null,
        recorded_at_ms: now,
        actor_kind: input.actor,
        scope: SCOPE,
        payload_json: JSON.stringify(payload),
        prev_hash: chained.prev_hash,
        hash: chained.hash,
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
  search(q: MemoryQuery): MemoryHit[] {
    const nowMs = q.nowMs ?? Date.now()
    const origins = q.includeOrigin ?? ['live']
    if (origins.length === 0) return []
    const scope = q.scope ?? SCOPE
    const limit = q.limit ?? DEFAULT_LIMIT
    const pattern = `%${escapeLike(q.text)}%`
    const originSlots = origins.map(() => '?').join(',')

    const rows = this.db.prepare(
      `SELECT f.fact_id, f.provenance, f.origin, f.importance, f.recorded_at_ms, b.body
         FROM mem_facts f
         LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
        WHERE f.scope = ?
          AND f.deleted_at_ms IS NULL
          AND f.retired_at_ms IS NULL
          AND f.origin IN (${originSlots})
          AND (b.body LIKE ? ESCAPE '\\'
               OR f.subject LIKE ? ESCAPE '\\'
               OR f.predicate LIKE ? ESCAPE '\\')
        LIMIT ?`,
    ).all(scope, ...origins, pattern, pattern, pattern, limit * 4) as Array<{
      fact_id: string
      provenance: 'stated' | 'inferred'
      origin: Origin
      importance: number
      recorded_at_ms: number
      body: string | null
    }>

    const recallPath: RecallPath = 'like'
    return rows
      .map((r) => ({
        kind: 'fact' as const,
        id: r.fact_id,
        score: recency(r.recorded_at_ms, nowMs) * (0.5 + r.importance),
        provenance: r.provenance,
        origin: r.origin,
        text: r.body ?? '',
        recallPath,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
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
