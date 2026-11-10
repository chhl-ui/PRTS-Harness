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
import { cosineSimilarity, decodeVector, encodeVector, type Embedder } from './embedding.ts'
import { MemVectorIndex } from './vector-index.ts'
import { extractEntities } from './extract.ts'
import { writeProfile, writeSummary } from './write.ts'
import { extractFacts, type FactPromptTurn } from './consolidate-facts.ts'
import type { TextGenerator } from './generate.ts'
import {
  readConsolidationCursor, runConsolidation, consolidationStats as readConsolidationStats,
  type ConsolidateOptions, type ConsolidateResult,
} from './consolidate.ts'
import { ensureSessionsBuilt, openMemoryDb } from './schema.ts'
import {
  decayedImportance, shouldRetire, importanceFromValence,
  IMPORTANCE_HALF_LIFE_DAYS, RETIRE_IMPORTANCE_FLOOR, RETIRE_MIN_AGE_DAYS,
  type RetireCandidate,
} from './lifecycle.ts'
import { parseTime } from './time.ts'
import { tokenize } from './tokenize.ts'
import { looksLikeCorrection, normalizeSlotKey } from './correction.ts'
import type {
  ActorKind, AssertFactInput, CreateIntentInput, FactMeta, ImportStats, InjectionRecord, IntentRow,
  IntentStatus, MemoryEventKind, MemoryEventRow, MemoryHit, MemoryQuery, Origin, RecallPath,
  RecordInjectionInput, RecordTurnInput, RecentTurn,
  ForgetPlan, ForgetResult,
  TurnEntityMention, VectorOwnerKind,
} from './types.ts'

const SCOPE = 'prts'
const DEFAULT_LIMIT = 20

/**
 * 意图触发时刻的合法窗口（V1-14）。
 *
 * 为什么要有下限：太近的时刻会在同一会话内触发，用户刚说完就被"提醒"，是噪声。
 * 为什么要有上限：两年的意图等于没有意图，还会永久占着 pending 表。
 * 这两个数是产品判断，不是物理常量——调整时改这里并同步文档。
 */
const INTENT_MIN_LEAD_MS = 60_000
const INTENT_MAX_LEAD_MS = 2 * 365 * 86_400_000

/** 时间校验：模型解析出的绝对时刻不可全信，这里是硬闸门。 */
function validateFireAt(fireAtMs: number, nowMs: number): void {
  if (!Number.isFinite(fireAtMs)) throw new Error(`intent: 非法的触发时刻 ${String(fireAtMs)}`)
  if (fireAtMs <= nowMs) throw new Error('intent: 触发时刻必须在未来（过去的时间无法触发）')
  if (fireAtMs - nowMs < INTENT_MIN_LEAD_MS) throw new Error('intent: 触发时刻过近，至少 1 分钟之后')
  if (fireAtMs - nowMs > INTENT_MAX_LEAD_MS) throw new Error('intent: 触发时刻过远，最多 2 年')
}

/** `mem_intents` 的原始行（snake_case），只在 store 内部流转。 */
interface RawIntentRow {
  intent_id: string
  condition_raw: string
  action: string
  fire_at_ms: number
  status: string
  created_at_ms: number
  fired_at_ms: number | null
  cancelled_at_ms: number | null
  source_turn_id: string | null
  session_id: string | null
}

function toIntentRow(r: RawIntentRow): IntentRow {
  return {
    intentId: r.intent_id,
    conditionRaw: r.condition_raw,
    action: r.action,
    fireAtMs: r.fire_at_ms,
    status: r.status as IntentStatus,
    createdAtMs: r.created_at_ms,
    firedAtMs: r.fired_at_ms,
    cancelledAtMs: r.cancelled_at_ms,
    sourceTurnId: r.source_turn_id,
    sessionId: r.session_id,
  }
}
/**
 * 时近衰减的权重上限（v2.7）。此前的 `score = recency × ...` 让 recency 成为乘性
 * 因子，实测把 bm25 名次靠前的证据压了下去：纯 FTS 探针 any@8 = 45.1%，
 * 实现只有 36.9%。改成 `1 + w×recency` 后，时间只提供微调，不覆盖 RRF 名次差异。
 *
 * `PRTS_RECENCY_WEIGHT` 可覆盖 w（默认 0.1）：它是「时间该有多大话语权」这一问题的
 * 实验旋钮。实测动机是 knowledge-update 的失败样本——top-5 全是比 gold 更新但无关
 * 的内容，说明时间信号在该题型上是负资产。改默认值之前必须用评测对照，不靠直觉。
 */
const RECENCY_WEIGHT = (() => {
  const raw = Number(process.env.PRTS_RECENCY_WEIGHT ?? '0.1')
  return Number.isFinite(raw) && raw >= 0 ? raw : 0.1
})()

/**
 * 向量路的扫描上限（v2.17）。全量余弦在百千级是毫秒级，但无上限会把 24.6 万条
 * 的库拖进每次查询。超过这个数量就该上 ANN 索引（HNSW / IVF），而不是继续硬扫。
 * 当前上限内扫描一遍的输出是确定的（ORDER BY 固定顺序），不依赖插入次序。
 */
const SEMANTIC_SCAN_CAP = 50_000

/**
 * 扩散候选的 RRF 权重（Wave 4）。
 *
 * 实测依据：与直接命中同权时，250 题上 any@8 从 32.8% 掉到 1.6%（-31.2pp），
 * 而 any@32 只掉 2.8pp。候选没有被删掉，是被扩散顶出了前排——扩散候选的
 * score 系数（1+0.1×overlap）还高于直接命中，于是系统性压过真正匹配的内容。
 *
 * 扩散是「关联证据」而不是「匹配证据」，权重必须显著低于字面/语义命中。
 */
const SPREAD_RRF_WEIGHT = 0.25

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

/**
 * 一行 fact 的折算重要性。
 *
 * `access_count` 是可选的：退役候选查询与生命周期统计不取这一列（它们只看写入强度
 * 与年龄），传进来的行没有该字段时按 0 处理——与没有这一维之前的行为一致。
 */
function rowImportance(
  r: { importance: number; recorded_at_ms: number; access_count?: number },
  nowMs: number,
): number {
  return decayedImportance(r.importance, r.recorded_at_ms, nowMs, IMPORTANCE_HALF_LIFE_DAYS, r.access_count ?? 0)
}

/**
 * `turnEntities` 的查询文本（模块级导出，供计划测试用）。
 *
 * 为什么它值得单独抽出来：`e.scope = ?` 若留在 JOIN 条件上，SQLite 会选
 * 「先扫 scope='prts' 的全部实体、再逐个回查 mentions」——基准库（71.7 万条
 * mentions）上单次 **646ms**；装配每轮调它一次，把 V1-16 端到端 p95 推到 1610ms。
 * 差异无法用行为断言捕捉，只能靠 `EXPLAIN QUERY PLAN`，
 * 见 `test/memory/turn-entities-plan.test.ts`。
 */
export function turnEntitiesSql(idCount: number): string {
  return `SELECT m.turn_id, m.entity_key, e.name, e.mention_count
            FROM mem_mentions m CROSS JOIN mem_entities e ON e.entity_key = m.entity_key
           WHERE m.turn_id IN (${Array.from({ length: idCount }, () => '?').join(',')}) AND e.scope = ?`
}

export class MemoryStore {
  private readonly db: DatabaseSync

  /**
   * 语义检索的内存向量索引。未预热时为空壳——`search` 自动降级回原 SQL 路径
   * （cap 50k，行为与 v2.17 逐字一致）。预热是显式动作，见 `warmVectorIndex()`。
   */
  private readonly vecIndex = new MemVectorIndex()

  // 不用参数属性：项目只允许可擦除语法（AGENTS.md「语法约束」）。
  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(path: string): MemoryStore {
    return new MemoryStore(openMemoryDb(path))
  }

  /**
   * 预热向量索引：把 `mem_vectors` 全量解码进 `Float32Array`（本库 1.0 GB / 约 5 秒）。
   *
   * 为什么必须显式：5 秒同步阻塞若发生在首轮注入之前，用户会把它记成「聊天卡了一下」。
   * 调用方应在首轮之后（或进程空闲时）调用；未预热时检索走原 SQL 路径，结果正确但
   * 只覆盖 `SEMANTIC_SCAN_CAP` 之内的向量（本库 19.9% 的 turn）——
   * 实测该上限下混合检索不如纯 bm25，依据见 `docs/memory-recall-criteria-retest-2026-11-03.md`。
   *
   * @returns 实际入索引的条数；0 表示库中没有可用向量。
   */
  warmVectorIndex(): number {
    return this.vecIndex.load(this.db)
  }

  /** 索引状态。诊断用：`ready=false` 时所有语义查询都在走降级路径。 */
  vectorIndexStatus(): { ready: boolean; size: number; dimension: number; skipped: number } {
    return {
      ready: this.vecIndex.isReady,
      size: this.vecIndex.size,
      dimension: this.vecIndex.dimension,
      skipped: this.vecIndex.skippedCount,
    }
  }

  close(): void {
    // 索引常驻 1 GB 级内存，关闭时必须释放，否则同进程内重开多个 store 会累积。
    this.vecIndex.reset()
    this.db.close()
  }

  /**
   * 降级路径：直接从 SQL 扫向量并算余弦（`warmVectorIndex()` 未调用时使用）。
   *
   * 保留 `SEMANTIC_SCAN_CAP` 的截断语义：`ORDER BY owner_kind, owner_id` 是字符串序，
   * `turn` 排在 `fact` / `profile` 之后，本库 24.6 万条 turn 只有 49,167 条能进扫描窗口。
   * 这不是 bug 而是**已知的降级边界**——要走全量必须预热内存索引。
   */
  private scanVectorsSql(
    qv: ArrayLike<number>,
    minSim: number,
  ): Array<{ ownerKind: string; ownerId: string; sim: number }> {
    const vecRows = this.db.prepare(
      `SELECT owner_kind, owner_id, vector FROM mem_vectors
        ORDER BY owner_kind, owner_id LIMIT ?`,
    ).all(SEMANTIC_SCAN_CAP) as unknown as Array<{
      owner_kind: string
      owner_id: string
      vector: Uint8Array
    }>

    const sims: Array<{ ownerKind: string; ownerId: string; sim: number }> = []
    for (const r of vecRows) {
      let v: Float32Array
      try {
        v = decodeVector(r.vector)
      } catch {
        continue // BLOB 损坏：跳过这一条，不让整条检索路失败
      }
      // 维度不符 = 换过模型但没重算：同样跳过。静默跳过是可接受的降级，
      // 但 vectorStats() 必须能把这种情况暴露出来，不能只有「检索变差」这一个症状。
      if (v.length !== qv.length) continue
      const sim = cosineSimilarity(qv, v)
      if (sim >= minSim) sims.push({ ownerKind: r.owner_kind, ownerId: r.owner_id, sim })
    }
    return sims
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
      // 身份键用于**去重**，不是判定「更新」：含 object 才算同一条事实。
      // 但**不能用 object 明文**——payload 在事件链上，正文外置（路线 D）的全部意义
      // 就是链上只留 body_ref + sha256，链上形状是唯一不可逆点（§八 不变量 9，M14 钉住）。
      // 用 body_sha256 当 object 的指纹：相同正文 → 相同键，不同正文 → 不同键。
      identity_key: `${input.subject.trim().toLowerCase()}|${input.predicate.trim().toLowerCase()}|${bodySha}`,
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
      // 规范化后空串统一落 NULL——「无槽」与「空槽」在库层不区分。
      slot: input.slot === undefined ? null : normalizeSlotKey(input.slot) || null,
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

      // 同槽取代（显式开启才走）：把同 subject|predicate、不同正文的在役旧事实
      // 退役并记 superseded_by。三条闸缺一不可：
      //  - `identity_key <> 新键`：同一句更正被重复抽取时，库里的在役同文行就是
      //    当前值本身，把它退役等于刚记住就忘掉（V1-06 F10 修复的直接回归点）。
      //  - model-inferred 不取代非 model-inferred：模型抽错一句话就把主人明说
      //    （owner-stated）或验证器确认的事实顶掉，是不可接受的失败形态。
      //  - 全部在同一事务内：投影与事件同生共死，重放 rebuild 得到同一结果。
      const slotKey = payload.slot
      if (input.supersedeSameSlot === true && typeof slotKey === 'string' && slotKey !== '') {
        const slot = this.db.prepare(
          `SELECT fact_id, confirmation_basis FROM mem_facts
             WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL
               AND fact_id <> ? AND identity_key <> ?
               AND lower(trim(subject)) = ? AND lower(trim(slot)) = ?`,
        ).all(
          SCOPE, factId, payload.identity_key,
          input.subject.trim().toLowerCase(), slotKey,
        ) as Array<{ fact_id: string; confirmation_basis: string }>
        for (const row of slot) {
          if (input.confirmationBasis === 'model-inferred' && row.confirmation_basis !== 'model-inferred') continue
          this.appendEvent({
            kind: 'fact.retired',
            actor: input.actor,
            recordedAtMs: now,
            payload: {
              fact_id: row.fact_id,
              reason: `superseded-by-slot: ${factId}`,
              superseded_by: factId,
            },
          })
        }
      }

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
   * 生命周期作业：把「已淡忘」的事实置为退役（Wave 5）。
   *
   * 只处理 `origin='live'` 且 `retention_class <> 'permanent'` 的行：
   * - benchmark 是评测数据，不该被生产作业改写；
   * - permanent 是身份性事实，淡忘它等于人格漂移。
   *
   * 幂等：已退役的行不在候选里，重复跑不会追加第二条事件。`dryRun` 只算不写，
   * 用来在真机上先看会退役多少条——退役虽然可逆，但批量改检索可见性之前先看数。
   *
   * 判定用的是 `shouldRetire()` 的**折算后**重要性，`mem_facts.importance` 本身不动
   * （衰减不写回，理由见 lifecycle.ts 头部）。
   */
  retireFacts(opts: {
    actor?: ActorKind
    nowMs?: number
    limit?: number
    dryRun?: boolean
    floor?: number
    minAgeDays?: number
    halfLifeDays?: number
  } = {}): { scanned: number; candidates: RetireCandidate[]; retired: string[] } {
    const nowMs = opts.nowMs ?? Date.now()
    const limit = Math.max(1, opts.limit ?? 500)
    const minAgeDays = opts.minAgeDays ?? RETIRE_MIN_AGE_DAYS
    const floor = opts.floor ?? RETIRE_IMPORTANCE_FLOOR
    const rows = this.db.prepare(
      `SELECT fact_id, importance, recorded_at_ms, retention_class
         FROM mem_facts
        WHERE scope = ? AND origin = 'live'
          AND deleted_at_ms IS NULL AND retired_at_ms IS NULL
          AND retention_class <> 'permanent'
          AND recorded_at_ms <= ?
        ORDER BY recorded_at_ms ASC
        LIMIT ?`,
    ).all(SCOPE, nowMs - minAgeDays * 86_400_000, limit) as Array<{
      fact_id: string
      importance: number
      recorded_at_ms: number
      retention_class: string
    }>

    const candidates: RetireCandidate[] = []
    for (const r of rows) {
      const c = shouldRetire(
        {
          factId: r.fact_id,
          importance: r.importance,
          recordedAtMs: r.recorded_at_ms,
          retentionClass: r.retention_class,
        },
        nowMs,
        { floor, minAgeDays, halfLifeDays: opts.halfLifeDays },
      )
      if (c !== null) candidates.push(c)
    }
    if (opts.dryRun === true || candidates.length === 0) {
      return { scanned: rows.length, candidates, retired: [] }
    }

    const actor = opts.actor ?? 'system'
    const retired: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const c of candidates) {
        this.appendEvent({
          kind: 'fact.retired',
          actor,
          recordedAtMs: nowMs,
          payload: {
            fact_id: c.factId,
            reason: `importance-decay: ${c.effective.toFixed(4)} < ${floor}`,
            threshold: floor,
            // 判定依据必须进链：只记「退役了」，事后无法复查阈值是否合理。
            effective_importance: Number(c.effective.toFixed(6)),
            age_days: Number(c.ageDays.toFixed(3)),
            importance_at_write: c.importance,
            half_life_days: opts.halfLifeDays ?? IMPORTANCE_HALF_LIFE_DAYS,
          },
        })
        retired.push(c.factId)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return { scanned: rows.length, candidates, retired }
  }

  /**
   * 恢复退役项（可逆档）。只处理当前确实处于退役状态的行。
   *
   * 返回**实际恢复条数**：传入已删除（正文已清空）或未退役的 id 不计入。
   * 静默返回 0 会让「我以为恢复了」变成无证据的错觉，调用方要据此判断有没有白跑。
   */
  restoreFacts(input: { actor?: ActorKind; factIds: string[]; reason?: string }): number {
    if (input.factIds.length === 0) return 0
    const now = Date.now()
    const actor = input.actor ?? 'owner'
    const rows = this.db.prepare(
      `SELECT fact_id FROM mem_facts
        WHERE fact_id IN (${input.factIds.map(() => '?').join(',')})
          AND deleted_at_ms IS NULL AND retired_at_ms IS NOT NULL
          AND superseded_by IS NULL`,
    ).all(...input.factIds) as Array<{ fact_id: string }>
    if (rows.length === 0) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        this.appendEvent({
          kind: 'fact.restored',
          actor,
          recordedAtMs: now,
          payload: { fact_id: r.fact_id, reason: input.reason ?? 'manual-restore' },
        })
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return rows.length
  }

  /**
   * 用进废退：把「被检索命中」的事实强化一次。
   *
   * 为什么不在 `search()` 里自动做：检索是纯只读路径，写库会让「查一次就改一次库」，
   * 违反读路径无副作用的约定，也让每次检索多一次写事务。改由调用方显式触发——
   * 目前是 `prts_memory_recall` 工具：模型真的拿到了这些记忆才算「用过」。
   *
   * 计数以**绝对量**写进事件，`rebuildProjections()` 后能精确还原。
   * 已删除的事实不参与（正文已清空，强化它没有意义）。
   */
  reinforceFacts(input: { actor?: ActorKind; factIds: string[]; nowMs?: number }): number {
    if (input.factIds.length === 0) return 0
    const now = input.nowMs ?? Date.now()
    const actor = input.actor ?? 'system'
    // 去重：同一个 fact 在一次检索里可能被多路召回，重复计数会把强化效果放大
    const unique = [...new Set(input.factIds)]
    const rows = this.db.prepare(
      `SELECT fact_id, access_count FROM mem_facts
        WHERE fact_id IN (${unique.map(() => '?').join(',')}) AND deleted_at_ms IS NULL`,
    ).all(...unique) as Array<{ fact_id: string; access_count: number }>
    if (rows.length === 0) return 0

    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        this.appendEvent({
          kind: 'fact.reinforced',
          actor,
          recordedAtMs: now,
          payload: { fact_id: r.fact_id, access_count: r.access_count + 1, last_access_ms: now },
        })
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    return rows.length
  }

  /**
   * 生命周期现状。`permanentLive` 单独报出来：它永不退役，混在 live 总数里
   * 会让「为什么退役作业没动那批」看不出原因。
   */
  lifecycleStats(nowMs: number = Date.now()): {
    live: number
    retired: number
    deleted: number
    permanentLive: number
    liveByClass: Array<{ retentionClass: string; live: number }>
    nearestCandidate: RetireCandidate | null
  } {
    const one = (sql: string): number => (this.db.prepare(sql).get(SCOPE) as { c: number }).c
    const live = one(
      "SELECT count(*) c FROM mem_facts WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL",
    )
    const retired = one(
      "SELECT count(*) c FROM mem_facts WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NOT NULL",
    )
    const deleted = one('SELECT count(*) c FROM mem_facts WHERE scope = ? AND deleted_at_ms IS NOT NULL')
    const permanentLive = one(
      "SELECT count(*) c FROM mem_facts WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL AND retention_class = 'permanent'",
    )
    const liveByClass = (this.db.prepare(
      `SELECT retention_class AS retentionClass, count(*) AS live FROM mem_facts
        WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL
        GROUP BY retention_class ORDER BY retention_class`,
    ).all(SCOPE) as Array<{ retentionClass: string; live: number }>)

    // 最接近退役的一条：给阈值调参提供依据，避免「跑一次才知道会杀多少」。
    const rows = this.db.prepare(
      `SELECT fact_id, importance, recorded_at_ms, retention_class FROM mem_facts
        WHERE scope = ? AND origin = 'live' AND deleted_at_ms IS NULL AND retired_at_ms IS NULL
          AND retention_class <> 'permanent'`,
    ).all(SCOPE) as Array<{
      fact_id: string
      importance: number
      recorded_at_ms: number
      retention_class: string
    }>
    let nearestCandidate: RetireCandidate | null = null
    for (const r of rows) {
      const effective = rowImportance(r, nowMs)
      if (nearestCandidate === null || effective < nearestCandidate.effective) {
        nearestCandidate = {
          factId: r.fact_id,
          importance: r.importance,
          recordedAtMs: r.recorded_at_ms,
          effective,
          ageDays: Math.max(0, (nowMs - r.recorded_at_ms) / 86_400_000),
        }
      }
    }
    return { live, retired, deleted, permanentLive, liveByClass, nearestCandidate }
  }

  /**
   * 模型层事实抽取（Wave 3 的 fact 部分）。
   *
   * 存在的理由：`assertFact` 此前零生产调用方，`mem_facts` 长期为 0，导致生命周期、
   * 用进废退、检索的 fact 通道全部空转。这里把它接上真实 turn。
   *
   * 三条纪律：
   * - **只抽 `live`**：benchmark 对话不进生产事实库。
   * - **幂等靠去重不靠水位线**：同一句重复抽取写入同一 identity_key，不会产生第二条；
   *   水位线只为省成本，中途失败重跑是安全的。
   * - **水位线按批推进**：一批写完才前进，模型报错时该批不会被跳过。
   *
   * `stop === 'budget'` 表示还有未处理的 turn，再调一次即可。
   */
  async consolidateFacts(opts: {
    generator: TextGenerator
    /** 本次最多处理多少条 turn，默认 200。 */
    limit?: number
    /** 每批多少条 turn 一次 prompt，默认 20。 */
    batchSize?: number
    actor?: ActorKind
    signal?: AbortSignal
    /**
     * 写入时的情绪效价（-1..1）提供者。
     *
     * **记忆库不 import 情感库**——那是 `emotion/store.ts:24` 明写的隔离约束
     * （「情感不污染事实」）。所以这里只接一个取值函数，由装配层接线：
     * start.ts 传 `() => emotion?.get()?.valence`。
     *
     * 缺席 / 读失败 → 事实落 0.5（旧行为不变）。有值时按
     * `lifecycle.ts:importanceFromValence` 折算，负效价下写入的事实更轻。
     */
    emotionValence?: () => number | undefined
  }): Promise<{
    turns: number
    extracted: number
    added: number
    skipped: number
    cursor: number
    stop: 'done' | 'budget' | 'cancelled'
  }> {
    const limit = Math.max(1, opts.limit ?? 200)
    const batchSize = Math.max(1, opts.batchSize ?? 20)
    const actor = opts.actor ?? 'system'
    let cursor = this.factCursor()
    const before = this.countFacts()
    const rows = this.db.prepare(
      `SELECT t.rowid AS rid, t.turn_id AS tid, t.speaker AS speaker, b.body AS body
         FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE t.rowid > ? AND t.deleted_at_ms IS NULL AND t.origin = 'live'
          AND b.body IS NOT NULL AND b.body <> ''
        ORDER BY t.rowid ASC LIMIT ?`,
    ).all(cursor, limit) as Array<{ rid: number; tid: string; speaker: string; body: string }>

    let turns = 0
    let extracted = 0
    let skipped = 0
    // 取满 limit 说明后面大概率还有，不要谎报 done
    let stop: 'done' | 'budget' | 'cancelled' = rows.length < limit ? 'done' : 'budget'

    for (let i = 0; i < rows.length; i += batchSize) {
      if (opts.signal?.aborted === true) {
        stop = 'cancelled'
        break
      }
      const batch = rows.slice(i, i + batchSize)
      const promptTurns: FactPromptTurn[] = batch.map((r, k) => ({
        index: k,
        speaker: r.speaker,
        text: r.body,
      }))
      // 已登记 slot 喂给模型：跨批次的更正必须复用同一主题名，
      // 否则它自己造近义词（相机→主力相机），旧值漏退役。
      const existingSlots = (this.db.prepare(
        `SELECT DISTINCT slot FROM mem_facts
           WHERE scope = ? AND deleted_at_ms IS NULL AND retired_at_ms IS NULL
             AND slot IS NOT NULL AND slot <> '' LIMIT 200`,
      ).all(SCOPE) as Array<{ slot: string }>).map(r => r.slot)
      const parsed = await extractFacts(opts.generator, promptTurns, existingSlots)
      skipped += parsed.skipped
      extracted += parsed.facts.length
      // 每批取一次情绪：批次之间有 await，跨批可能隔了一段时间；同一批内不再重复读。
      // 读失败按「没有情绪」处理——情绪库打不开不该让巩固整批失败。
      let batchValence: number | undefined
      try { batchValence = opts.emotionValence?.() } catch { batchValence = undefined }
      const batchImportance = importanceFromValence(batchValence)
      for (const f of parsed.facts) {
        const srcTurn = f.sourceIndex === null ? undefined : batch[f.sourceIndex]
        this.assertFact({
          actor,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          slot: f.slot,
          // 写入时的情绪决定这条事实有多重（§G2 ②）。负效价下提取的事实更轻，
          // 平静/正效价下更重——判据见 lifecycle.ts:importanceFromValence。
          importance: batchImportance,
          // 模型抽的不是主人明说的：库里的 CHECK 白名单禁止 stated + model-inferred
          provenance: 'inferred',
          confirmationBasis: 'model-inferred',
          origin: 'live',
          // 只有来源 turn 显式带更正标记才开同槽取代——这是「新值顶替旧值」
          // 与「同槽并存取值」在字符串层唯一可分的证据（correction.ts 头部）。
          ...(srcTurn === undefined ? {} : { sourceTurnIds: [srcTurn.tid] }),
          ...(srcTurn !== undefined && looksLikeCorrection(srcTurn.body) ? { supersedeSameSlot: true } : {}),
        })
      }
      turns += batch.length
      const last = batch[batch.length - 1]
      if (last !== undefined) {
        cursor = last.rid
        this.setFactCursor(cursor)
      }
    }

    return { turns, extracted, added: this.countFacts() - before, skipped, cursor, stop }
  }

  /**
   * 近期带更正标记的用户 turn（注入层的预留名额数据源，V1-06 F10）。
   *
   * 为什么不走 `search()`：更正句往往不含查询的关键词（「改喝拿铁」里没有「咖啡」），
   * BM25/FTS 在语义检索落地前召不回它；而「主人最近说要改」恰恰是最不能让模型
   * 错过的信号。这里按时间倒序取少量候选，用 `correction.ts` 的同一张词表过滤。
   *
   * 返回 MemoryHit 形状是为了直接进注入管线（sessionId 供同会话过滤）；
   * `recallPath` 标 `'correction'`，审计时能分清它是钉进去的还是检索出来的。
   */
  recentCorrections(opts: { sinceMs?: number; limit?: number; excludeSessionId?: string } = {}): MemoryHit[] {
    const sinceMs = opts.sinceMs ?? Date.now() - 30 * 86_400_000
    // `Math.max(1, NaN)` 仍是 NaN，会被原样带进 SQL 绑定层。同一缺陷模式
    // （`recentTurns` 已按规格回落）：非有限数落回默认值，0/负数的既有语义（→1）不动。
    const rawLimit = opts.limit ?? 5
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 5
    // 多取 10 倍给标记过滤留损耗——更正句是稀疏信号，窗口内绝大多数 turn 会被滤掉。
    const rows = this.db.prepare(
      `SELECT t.turn_id AS id, t.session_id AS sessionId,
              t.occurred_at_ms AS atMs, t.occurred_raw AS raw, b.body AS body
         FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE t.scope = ? AND t.origin = 'live' AND t.deleted_at_ms IS NULL
          AND t.speaker = 'user' AND t.occurred_at_ms >= ?
          AND b.body IS NOT NULL AND b.body <> ''
        ORDER BY t.occurred_at_ms DESC LIMIT ?`,
    ).all(SCOPE, sinceMs, limit * 10) as Array<{
      id: string; sessionId: string; atMs: number | null; raw: string | null; body: string
    }>
    const out: MemoryHit[] = []
    for (const r of rows) {
      if (opts.excludeSessionId !== undefined && r.sessionId === opts.excludeSessionId) continue
      if (!looksLikeCorrection(r.body)) continue
      out.push({
        kind: 'turn', id: r.id, score: 0, origin: 'live',
        sessionId: r.sessionId, occurredAtMs: r.atMs,
        ...(r.raw === null ? {} : { occurredRaw: r.raw }),
        text: r.body, recallPath: 'correction',
      })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * 近期情景：跨会话按**发生时刻**倒序的 turn 切片（⑦ 跨会话连续 S4 的数据基础）。
   *
   * 为什么不走 `search()`：那是相关性检索——没有查询词时「最近」是纯时间语义，
   * 硬塞给 BM25 只会得到按字面重叠排序的结果。这里不筛内容，由调用方决定渲染谁。
   *
   * 过滤口径：
   * - 只 `live`：基准数据的 turn 不进注入/验收路径（设计稿 §6.4）
   * - 已删除、正文为空的跳过：注进去只有壳没有内容
   * - `occurred_at_ms` 为 NULL 的排最后（`COALESCE(..., 0) DESC`）——时间缺失
   *   不等于「很早」，但更不等于「刚刚」，排最后是唯一不撒谎的位置
   */
  recentTurns(opts: {
    limit?: number
    sinceMs?: number
    excludeSessionId?: string
    speaker?: string
  } = {}): RecentTurn[] {
    // 非法 limit 回落 1 而不是 0：0 条与「库里没有数据」不可区分，调用方会误读成空库。
    const rawLimit = opts.limit ?? 5
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 1
    const where: string[] = [
      't.scope = ?',
      "t.origin = 'live'",
      't.deleted_at_ms IS NULL',
      'b.body IS NOT NULL',
      "b.body <> ''",
    ]
    const params: Array<string | number> = [SCOPE]
    if (opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs)) {
      // 非有限数不当窗口用：`>= NaN` 在 SQLite 里恒假，会静默返回空数组。
      where.push('t.occurred_at_ms >= ?')
      params.push(opts.sinceMs)
    }
    if (opts.excludeSessionId !== undefined) {
      where.push('t.session_id <> ?')
      params.push(opts.excludeSessionId)
    }
    if (opts.speaker !== undefined) {
      where.push('t.speaker = ?')
      params.push(opts.speaker)
    }
    const rows = this.db.prepare(
      `SELECT t.turn_id AS turnId, t.session_id AS sessionId, t.turn_index AS turnIndex,
              t.speaker AS speaker, t.occurred_at_ms AS occurredAtMs, b.body AS text
         FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(t.occurred_at_ms, 0) DESC, t.turn_id
        LIMIT ?`,
    ).all(...params, limit) as Array<{
      turnId: string
      sessionId: string
      turnIndex: number
      speaker: string
      occurredAtMs: number | null
      text: string
    }>
    return rows.map((r) => ({
      turnId: r.turnId,
      sessionId: r.sessionId,
      turnIndex: r.turnIndex,
      speaker: r.speaker,
      text: r.text,
      occurredAtMs: r.occurredAtMs,
    }))
  }

  /**
   * 阅读阶段（`reading.ts`，roadmap P1）的事实元数据二阶补查。
   *
   * 不挂 `MemoryHit`：`search()` 的投影面已横跨四张表，而 subject/slot/
   * sourceTurnIds 只有注入与召回这两个「组织上下文」的消费方才用。
   * IN 查询走主键，调用方按命中条数传参（注入 ≤ limit、召回 ≤ 20），代价可忽略。
   */
  factMeta(factIds: readonly string[]): Map<string, FactMeta> {
    const out = new Map<string, FactMeta>()
    if (factIds.length === 0) return out
    const rows = this.db.prepare(
      `SELECT fact_id, subject, predicate, slot, valid_from_ms, recorded_at_ms, source_turn_ids
         FROM mem_facts
        WHERE scope = ? AND fact_id IN (${factIds.map(() => '?').join(',')})`,
    ).all(SCOPE, ...factIds) as Array<{
      fact_id: string
      subject: string
      predicate: string
      slot: string | null
      valid_from_ms: number | null
      recorded_at_ms: number | null
      source_turn_ids: string | null
    }>
    for (const r of rows) {
      let sourceTurnIds: string[] = []
      if (r.source_turn_ids !== null) {
        try {
          const parsed = JSON.parse(r.source_turn_ids) as unknown
          if (Array.isArray(parsed)) sourceTurnIds = parsed.filter((x): x is string => typeof x === 'string')
        } catch { /* 投影损坏时按无来源处理，不阻断阅读阶段 */ }
      }
      out.set(r.fact_id, {
        subject: r.subject, predicate: r.predicate, slot: r.slot,
        validFromMs: r.valid_from_ms, recordedAtMs: r.recorded_at_ms, sourceTurnIds,
      })
    }
    return out
  }

  /**
   * turn 命中的实体提及（`mem_mentions` × `mem_entities`）。
   * 阅读阶段拿它做主题卡聚合键；`mentionCount` 供消费方过滤枢纽实体。
   *
   * **SQL 抽成常量是为了让它可被计划测试钉住**：`e.scope = ?` 写成 JOIN 条件时，
   * SQLite 会选「先扫 scope='prts' 的全部实体、再逐个回查 mentions」——基准库上
   * 单次 646ms；`CROSS JOIN` 强制先按 turn_id 筛（1.0ms）。这条差异只能靠
   * `EXPLAIN QUERY PLAN` 断言，所以查询文本必须能被测试拿到。
   * 见 `test/memory/turn-entities-plan.test.ts`。
   */
  turnEntities(turnIds: readonly string[]): Map<string, TurnEntityMention[]> {
    const out = new Map<string, TurnEntityMention[]>()
    if (turnIds.length === 0) return out
    const rows = this.db.prepare(turnEntitiesSql(turnIds.length)).all(...turnIds, SCOPE) as Array<{
      turn_id: string
      entity_key: string
      name: string
      mention_count: number
    }>
    for (const r of rows) {
      const list = out.get(r.turn_id) ?? []
      list.push({ key: r.entity_key, name: r.name, mentionCount: r.mention_count })
      out.set(r.turn_id, list)
    }
    return out
  }

  /** 当前库里的 fact 条数（含已删除）。 */
  countFacts(): number {
    return (this.db.prepare('SELECT count(*) c FROM mem_facts WHERE scope = ?').get(SCOPE) as { c: number }).c
  }

  private factCursor(): number {
    const row = this.db.prepare(
      'SELECT fact_cursor_turn_rowid AS c FROM mem_consolidation WHERE scope = ?',
    ).get(SCOPE) as { c: number } | undefined
    return row?.c ?? 0
  }

  private setFactCursor(rowid: number): void {
    this.db.prepare(
      `INSERT INTO mem_consolidation
         (scope, cursor_turn_rowid, cursor_event_seq, updated_at_ms, budget_spent, fact_cursor_turn_rowid)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(scope) DO UPDATE SET
         fact_cursor_turn_rowid = excluded.fact_cursor_turn_rowid,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(SCOPE, 0, 0, Date.now(), 0, rowid)
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
    if (input.occurredAtMs !== undefined && !Number.isFinite(input.occurredAtMs)) {
      throw new Error('recordTurn: occurredAtMs 必须是有限数')
    }
    const occurredAtMs = input.occurredAtMs ?? (input.occurredRaw === undefined ? null : parseTime(input.occurredRaw))
    const occurredRaw = input.occurredRaw ?? (input.occurredAtMs === undefined ? null : new Date(input.occurredAtMs).toISOString())

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

    const cap = limit * 4
    const originSlots = origins.map(() => '?').join(',')
    // 分路的依据是 tokenizer 能力，不是查询语言（2026-11-01 实测）：
    // `trigram` 对 >=3 字符有效（英文子串、中文 3 字以上），对中文 2 字"镜头"恒为 0；
    // `unicode61` / `porter` 连中文 3 字都是 0，所以不用它们。
    const longTokens = tokens.filter((t) => [...t].length >= 3)
    const shortTokens = tokens.filter((t) => [...t].length < 3)

    // 两路的分数尺度不可比（bm25 越小越好 vs 命中词数越大越好），所以只比名次：
    // RRF（Reciprocal Rank Fusion）。§6.5 否决「三路分流」的理由是计分口径不可比，
    // 排名融合是这个顾虑的正面解法，而不是绕开它。
    const RRF_K = 60
    const fused = new Map<string, { hit: MemoryHit; rrf: number }>()
    const rank = (hits: MemoryHit[], path: RecallPath, weight = 1): void => {
      hits.forEach((h, i) => {
        const add = weight / (RRF_K + i + 1)
        const prev = fused.get(h.id)
        if (prev === undefined) fused.set(h.id, { hit: { ...h, recallPath: path, recallPaths: [path] }, rrf: add })
        else {
          prev.rrf += add
          // 多路召回时记全来源：只留首次标签会让「向量是否真的立功」无法回答，
          // 而这正是本轮改动要回答的问题。
          const paths = prev.hit.recallPaths ?? [prev.hit.recallPath]
          if (!paths.includes(path)) {
            paths.push(path)
            prev.hit.recallPaths = paths
          }
        }
      })
    }

    const ftsMatch = longTokens.length === 0
      ? null
      : longTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')

    // ---- 阶段一：session 级粗筛（v2.12）----
    // turn 级从 491 个候选里选 8 个，噪声淹信号（any@8 38.8%）；先定位 session
    // （每题中位 48 选 10）能把搜索空间压到约 100 turn，实测 all@10 80.8%。
    // 注意不能复用 turn 级索引聚合（实测只到 55.8%，低 25pp）——必须是真的 session 索引。
    // 默认关闭（0）：两阶段的**阶段一算法**还没选对。实测把它打开后 any@8 从
    // 38.8% 掉到 34.0%——因为阶段一用 FTS5 bm25 做长文档粗筛，any@3 只有 14.7%，
    // 而离线用「token 重叠 / sqrt(词数)」能到 85.6%（差 5.8 倍）。bm25 的打分被
    // session 聚合文本的长度稀释了。修法是阶段一改成显式长度归一化（FTS5 只做召回、
    // JS 里重排），在修好之前不开启，避免用变差的配置冒充改进。
    const sessionLimit = q.sessionLimit ?? 0
    let allowedSessions: string[] | null = null
    if (sessionLimit > 0 && ftsMatch !== null) {
      const sessRows = this.db.prepare(
        `SELECT s.session_id AS sid
           FROM mem_fts_sessions
           JOIN mem_sessions s ON s.rowid = mem_fts_sessions.rowid
          WHERE mem_fts_sessions MATCH ?
            AND s.scope = ? AND s.origin IN (${originSlots})
          ORDER BY bm25(mem_fts_sessions)
          LIMIT ?`,
      ).all(ftsMatch, scope, ...origins, sessionLimit) as Array<{ sid: string }>
      // 阶段一颗粒无收时退回全库，避免「session 索引缺失 → 永远查不到」的静默失效
      if (sessRows.length > 0) allowedSessions = sessRows.map((r) => r.sid)
    }
    const sessionFilter = allowedSessions === null
      ? ''
      : ` AND t.session_id IN (${allowedSessions.map(() => '?').join(',')})`
    const sessionArgs = allowedSessions ?? []

    // ---- 路 1：FTS5 trigram（按 bm25 升序，越小越相关）----
    const ftsFacts: MemoryHit[] = ftsMatch === null ? [] : (
      this.db.prepare(
        `SELECT f.fact_id, f.provenance, f.origin, f.importance, f.recorded_at_ms, f.access_count, b.body
           FROM mem_fts_facts
           JOIN mem_facts f ON f.rowid = mem_fts_facts.rowid
           LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
          WHERE mem_fts_facts MATCH ?
            AND f.scope = ? AND f.deleted_at_ms IS NULL ${q.includeRetired ? '' : 'AND f.retired_at_ms IS NULL'}
            AND f.origin IN (${originSlots})
          ORDER BY bm25(mem_fts_facts)
          LIMIT ?`,
      ).all(ftsMatch, scope, ...origins, cap) as Array<{
        fact_id: string
        provenance: 'stated' | 'inferred'
        origin: Origin
        importance: number
        recorded_at_ms: number
        body: string | null
      }>
    ).map((r) => ({
      kind: 'fact' as const,
      id: r.fact_id,
      // importance 是写入时的强度，这里是**折算后的有效强度**（Wave 5）：
      // 衰减是纯函数而不是写回，理由见 lifecycle.ts 头部。
      score: (1 + RECENCY_WEIGHT * recency(r.recorded_at_ms, nowMs))
        * (0.5 + rowImportance(r, nowMs)),
      provenance: r.provenance,
      origin: r.origin,
      text: r.body ?? '',
      recallPath: 'fts-trigram' as RecallPath,
    }))

    const ftsTurns: MemoryHit[] = ftsMatch === null ? [] : (
      this.db.prepare(
        `SELECT t.turn_id, t.session_id, t.turn_index, t.external_id, t.origin,
                t.occurred_at_ms, t.occurred_raw, b.body
           FROM mem_fts_turns
           JOIN mem_turns t ON t.rowid = mem_fts_turns.rowid
           LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
          WHERE mem_fts_turns MATCH ?
            AND t.scope = ? AND t.deleted_at_ms IS NULL
            AND t.origin IN (${originSlots})${sessionFilter}
          ORDER BY bm25(mem_fts_turns)
          LIMIT ?`,
      ).all(ftsMatch, scope, ...origins, ...sessionArgs, cap) as unknown as Array<{
        turn_id: string
        session_id: string
        turn_index: number
        external_id: string | null
        origin: Origin
        occurred_at_ms: number | null
        occurred_raw: string | null
        body: string | null
      }>
    ).map((r) => ({
      kind: 'turn' as const,
      id: r.turn_id,
      score: 1 + RECENCY_WEIGHT * (r.occurred_at_ms === null ? 0.5 : recency(r.occurred_at_ms, nowMs)),
      origin: r.origin,
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      ...(r.external_id === null ? {} : { externalId: r.external_id }),
      occurredAtMs: r.occurred_at_ms,
      ...(r.occurred_raw === null ? {} : { occurredRaw: r.occurred_raw }),
      text: r.body ?? '',
      recallPath: 'fts-trigram' as RecallPath,
    }))

    // ---- 画像路（v2.15 闸门）：独立表 + 独立 FTS + 独立名额 ----
    // Wave 0 实测：画像与普通 fact 混池时，37–43 条画像里无关的靠字面匹配挤进 top-8。
    // 身份独立是前提，名额独立是保证——两者缺一，画像永远选不中。
    const profileQuota = q.profileQuota ?? 0
    const profileHits: MemoryHit[] = profileQuota <= 0 || ftsMatch === null ? [] : (
      this.db.prepare(
        `SELECT p.profile_id, p.subject, p.aspect, p.profile_body, p.confidence
           FROM mem_fts_profiles
           JOIN mem_profiles p ON p.rowid = mem_fts_profiles.rowid
          WHERE mem_fts_profiles MATCH ?
            AND p.scope = ? AND p.deleted_at_ms IS NULL
            AND p.origin IN (${originSlots})
          ORDER BY bm25(mem_fts_profiles)
          LIMIT ?`,
      ).all(ftsMatch, scope, ...origins, profileQuota * 4) as Array<{
        profile_id: string
        subject: string
        aspect: string
        profile_body: string
        confidence: number
      }>
    ).map((r) => ({
      kind: 'profile' as const,
      // id 必须带命名空间前缀：`fused` 是按 id 合并的 Map，若 profile 与某条 fact
      // 同 id，后者的 kind 会被吞掉——实测就是「12 条画像命中、最终 0 条进结果」。
      id: `profile-${r.profile_id}`,
      // 画像没有时间衰减——它是归纳产物，不随原对话变旧
      score: 0.5 + r.confidence,
      origin: origins[0] ?? 'live',
      text: r.profile_body,
      recallPath: 'profile' as RecallPath,
    }))

    // ---- 摘要路（Wave B）：情景大意 ----
    // 与画像路同构：独立表、独立 FTS、独立名额。默认 0，保证不开摘要路时基线一字不变。
    const summaryQuota = q.summaryQuota ?? 0
    const summaryHits: MemoryHit[] = summaryQuota <= 0 || ftsMatch === null ? [] : (
      this.db.prepare(
        `SELECT s.summary_id, b.body
           FROM mem_fts_summaries
           JOIN mem_summaries s ON s.rowid = mem_fts_summaries.rowid
           LEFT JOIN mem_bodies b ON b.body_ref = s.body_ref
          WHERE mem_fts_summaries MATCH ?
            AND s.scope = ? AND s.deleted_at_ms IS NULL
            AND s.origin IN (${originSlots})
          ORDER BY bm25(mem_fts_summaries)
          LIMIT ?`,
      ).all(ftsMatch, scope, ...origins, summaryQuota * 4) as unknown as Array<{ summary_id: string; body: string | null }>
    ).map((r) => ({
      kind: 'summary' as const,
      // 命名空间前缀：fused 是按 id 合并的 Map，与 fact 同 id 时 kind 会被吞
      id: `summary-${r.summary_id}`,
      score: 1 + RECENCY_WEIGHT * 0.5,
      origin: origins[0] ?? 'live',
      text: r.body ?? '',
      recallPath: 'fts-trigram' as RecallPath,
    }))

    rank(ftsFacts, 'fts-trigram')
    rank(ftsTurns, 'fts-trigram')
    rank(profileHits, 'profile')
    rank(summaryHits, 'fts-trigram')

    // ---- 路 3：向量语义近邻（v2.17）----
    // 只覆盖派生项（fact / profile）：turn 是 24.6 万级，全量余弦不划算，且 turn 的
    // 瓶颈在粒度不在语义（v2.11：session@3 85.6% vs turn@8 38.8%）。
    // 依据：120 条归纳画像 × 3 道 preference 题，bm25 把目标画像排到 16 / 未命中 / 未命中，
    // 同一批数据换余弦后是 4 / 1 / 14，top-8 可答性 0/3 → 2/3。
    const semanticTopK = q.semanticTopK ?? 0
    const qv = q.queryVector
    if (semanticTopK > 0 && qv !== undefined && qv.length > 0) {
      const minSim = q.semanticMinSim ?? 0
      // 索引就绪 → 内存全量余弦（覆盖全部 24.6 万条 turn 向量）；未就绪 → 降级 SQL 路径。
      const indexed = this.vecIndex.query(qv, semanticTopK, minSim)
      let top: Array<{ ownerKind: string; ownerId: string; sim: number }>
      if (indexed !== null) {
        top = indexed
      } else {
        const sims = this.scanVectorsSql(qv, minSim)
        sims.sort((a, b) => b.sim - a.sim)
        top = sims.slice(0, semanticTopK)
      }

      // 回表取正文：按 top 的顺序重建，rank() 用数组下标当名次，顺序即名次。
      const factIds = top.filter((t) => t.ownerKind === 'fact').map((t) => t.ownerId)
      const profIds = top.filter((t) => t.ownerKind === 'profile').map((t) => t.ownerId)

      const factById = new Map<string, {
        fact_id: string
        provenance: 'stated' | 'inferred'
        origin: Origin
        importance: number
        recorded_at_ms: number
        body: string | null
      }>()
      if (factIds.length > 0) {
        const rows = this.db.prepare(
          `SELECT f.fact_id, f.provenance, f.origin, f.importance, f.recorded_at_ms, f.access_count, b.body
             FROM mem_facts f
             LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
            WHERE f.fact_id IN (${factIds.map(() => '?').join(',')})
              AND f.scope = ? AND f.deleted_at_ms IS NULL ${q.includeRetired ? '' : 'AND f.retired_at_ms IS NULL'}
              AND f.origin IN (${originSlots})`,
        ).all(...factIds, scope, ...origins) as unknown as Array<{
          fact_id: string
          provenance: 'stated' | 'inferred'
          origin: Origin
          importance: number
          recorded_at_ms: number
          body: string | null
        }>
        for (const r of rows) factById.set(r.fact_id, r)
      }

      const profById = new Map<string, { profile_id: string; profile_body: string; confidence: number }>()
      if (profIds.length > 0) {
        const rows = this.db.prepare(
          `SELECT profile_id, profile_body, confidence FROM mem_profiles
            WHERE profile_id IN (${profIds.map(() => '?').join(',')})
              AND scope = ? AND deleted_at_ms IS NULL
              AND origin IN (${originSlots})`,
        ).all(...profIds, scope, ...origins) as unknown as Array<{
          profile_id: string
          profile_body: string
          confidence: number
        }>
        for (const r of rows) profById.set(r.profile_id, r)
      }

      // turn 回表（2026-11-02）：此前只处理 fact/profile，turn 命中被静默丢弃——
      // 症状与「库里没有向量」完全一样，是最隐蔽的一处断点。
      // id 用裸 turn_id：与 FTS 路同 id，同一个 turn 被两路命中时才能在 `fused` 里合并名次。
      const turnIds = top.filter((t) => t.ownerKind === 'turn').map((t) => t.ownerId)
      const turnById = new Map<string, {
        turn_id: string
        session_id: string
        turn_index: number
        external_id: string | null
        origin: Origin
        occurred_at_ms: number | null
        occurred_raw: string | null
        body: string | null
      }>()
      if (turnIds.length > 0) {
        const rows = this.db.prepare(
          `SELECT t.turn_id, t.session_id, t.turn_index, t.external_id, t.origin,
                  t.occurred_at_ms, t.occurred_raw, b.body
             FROM mem_turns t
             LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
            WHERE t.turn_id IN (${turnIds.map(() => '?').join(',')})
              AND t.scope = ? AND t.deleted_at_ms IS NULL
              AND t.origin IN (${originSlots})`,
        ).all(...turnIds, scope, ...origins) as unknown as Array<{
          turn_id: string
          session_id: string
          turn_index: number
          external_id: string | null
          origin: Origin
          occurred_at_ms: number | null
          occurred_raw: string | null
          body: string | null
        }>
        for (const r of rows) turnById.set(r.turn_id, r)
      }

      const semanticHits: MemoryHit[] = []
      for (const t of top) {
        if (t.ownerKind === 'fact') {
          const r = factById.get(t.ownerId)
          if (r === undefined) continue
          semanticHits.push({
            kind: 'fact',
            id: r.fact_id,
            score: (1 + RECENCY_WEIGHT * recency(r.recorded_at_ms, nowMs))
              * (0.5 + rowImportance(r, nowMs)),
            provenance: r.provenance,
            origin: r.origin,
            text: r.body ?? '',
            recallPath: 'semantic',
          })
        } else if (t.ownerKind === 'profile') {
          const r = profById.get(t.ownerId)
          if (r === undefined) continue
          semanticHits.push({
            kind: 'profile',
            // 同样的命名空间前缀：`fused` 按 id 合并，与 fact 同 id 时 kind 会被吞
            id: `profile-${r.profile_id}`,
            score: 0.5 + r.confidence,
            origin: origins[0] ?? 'live',
            text: r.profile_body,
            recallPath: 'semantic',
          })
        } else if (t.ownerKind === 'turn') {
          const r = turnById.get(t.ownerId)
          if (r === undefined) continue
          semanticHits.push({
            kind: 'turn',
            id: r.turn_id,
            score: 1 + RECENCY_WEIGHT * (r.occurred_at_ms === null ? 0.5 : recency(r.occurred_at_ms, nowMs)),
            origin: r.origin,
            sessionId: r.session_id,
            turnIndex: r.turn_index,
            ...(r.external_id === null ? {} : { externalId: r.external_id }),
            occurredAtMs: r.occurred_at_ms,
            ...(r.occurred_raw === null ? {} : { occurredRaw: r.occurred_raw }),
            text: r.body ?? '',
            recallPath: 'semantic',
          })
        }
      }
      // 权重默认 0.5：等权 RRF 在 benchmark 的 temporal 题上 −11.8pp（roadmap 实测）。
      rank(semanticHits, 'semantic', q.semanticWeight ?? 0.5)
    }

    // ---- 路 2：LIKE 兜底（中文 2 字等短 token；FTS 颗粒无收时用全部 token 再兜一次）----
    // LIKE 兜底的存在理由只有一个：trigram 对中文 2 字恒为 0（设计意图见
    // test/memory/hybrid-search.test.ts 文件头）。判据必须按这个理由写，不能按
    // 「字符数 < 3」——实测（2026-11-05，24.6 万行基准库）：`up` / `am` / `5k` / `gm`
    // 这类英文短词会触发一次全表 LIKE，单条 886–948ms、命中 4.5k–12.2 万行，
    // 而召回价值为零（`up` 命中 87,837 行）。它们把 single-session-assistant 的
    // 996ms/题、preference 的 902ms/题 拖成纯 FTS 题型的 3–5 倍。
    // 英文短词只在 FTS 颗粒无收时兜底：`AI` / `5k` 这类缩写 trigram 同样搜不到。
    const cjkShort = shortTokens.filter((t) => /[\u4e00-\u9fff]/.test(t))
    const likeTokens = cjkShort.length > 0
      ? cjkShort
      : (fused.size === 0 && tokens.length > 0 ? tokens : [])
    if (likeTokens.length > 0) {
      const pats = likeTokens.map((t) => `%${escapeLike(t)}%`)
      // fact 的可检索口径 = subject + predicate + body + slot（与 FTS 建索引的
      // 文本一致）。slot 不能漏：「咖啡/相机」这类 2 字主题名走的就是这条
      // LIKE 兜底（trigram 要 ≥3 字符），漏掉等于 2 字 slot 名不可检索。
      const factConds = likeTokens
        .map(() => "(b.body LIKE ? ESCAPE '\\' OR f.subject LIKE ? ESCAPE '\\' OR f.predicate LIKE ? ESCAPE '\\' OR f.slot LIKE ? ESCAPE '\\')")
        .join(' OR ')
      const turnConds = likeTokens.map(() => "b.body LIKE ? ESCAPE '\\'").join(' OR ')
      const factHitExpr = likeTokens
        .map(() => `(CASE WHEN b.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
                       + CASE WHEN f.subject LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
                       + CASE WHEN f.predicate LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END
                       + CASE WHEN f.slot LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
        .join(' + ')
      const turnHitExpr = likeTokens
        .map(() => `(CASE WHEN b.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`)
        .join(' + ')

      const likeFacts = (this.db.prepare(
        `SELECT f.fact_id, f.provenance, f.origin, f.importance, f.recorded_at_ms, f.access_count, b.body,
                (${factHitExpr}) AS hit_count
           FROM mem_facts f
           LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
          WHERE f.scope = ? AND f.deleted_at_ms IS NULL ${q.includeRetired ? '' : 'AND f.retired_at_ms IS NULL'}
            AND f.origin IN (${originSlots}) AND (${factConds})
          ORDER BY hit_count DESC, f.recorded_at_ms DESC
          LIMIT ?`,
      ).all(
        ...pats.flatMap((p) => [p, p, p, p]), scope, ...origins,
        ...pats.flatMap((p) => [p, p, p, p]), cap,
      ) as Array<{
        fact_id: string
        provenance: 'stated' | 'inferred'
        origin: Origin
        importance: number
        recorded_at_ms: number
        body: string | null
      }>).map((r) => ({
        kind: 'fact' as const,
        id: r.fact_id,
        score: (1 + RECENCY_WEIGHT * recency(r.recorded_at_ms, nowMs))
          * (0.5 + rowImportance(r, nowMs))
          * (1 + countHits(r.body, likeTokens)),
        provenance: r.provenance,
        origin: r.origin,
        text: r.body ?? '',
        recallPath: 'like' as RecallPath,
      }))

      const likeTurns = (this.db.prepare(
        `SELECT t.turn_id, t.session_id, t.turn_index, t.external_id, t.origin,
                t.occurred_at_ms, t.occurred_raw, b.body,
                (${turnHitExpr}) AS hit_count
           FROM mem_turns t
           LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
          WHERE t.scope = ? AND t.deleted_at_ms IS NULL
            AND t.origin IN (${originSlots}) AND (${turnConds})${sessionFilter}
          ORDER BY hit_count DESC, t.occurred_at_ms IS NULL, t.occurred_at_ms DESC
          LIMIT ?`,
      ).all(
        ...pats, scope, ...origins, ...pats, ...sessionArgs, cap,
      ) as unknown as Array<{
        turn_id: string
        session_id: string
        turn_index: number
        external_id: string | null
        origin: Origin
        occurred_at_ms: number | null
        occurred_raw: string | null
        body: string | null
      }>).map((r) => ({
        kind: 'turn' as const,
        id: r.turn_id,
        score: (1 + RECENCY_WEIGHT * (r.occurred_at_ms === null ? 0.5 : recency(r.occurred_at_ms, nowMs))) * (1 + countHits(r.body, likeTokens)),
        origin: r.origin,
        sessionId: r.session_id,
        turnIndex: r.turn_index,
        ...(r.external_id === null ? {} : { externalId: r.external_id }),
        occurredAtMs: r.occurred_at_ms,
        ...(r.occurred_raw === null ? {} : { occurredRaw: r.occurred_raw }),
        text: r.body ?? '',
        recallPath: 'like' as RecallPath,
      }))

      rank(likeFacts, 'like')
      rank(likeTurns, 'like')
    }

    // ---- 路 4：扩散激活（Wave 4）----
    // 从直接命中的 turn 抽实体当种子 → 沿 mem_links 取 1 跳邻居 → 邻居经
    // mem_mentions 翻译成候选 turn。**不递归**：2 跳在 108 万条边上会爆炸，
    // 且「朋友的朋友」与查询的相关性没有任何证据支持。
    // 放在所有直接路之后：种子必须是已经算过分的命中，否则无从扩散。
    const spreadHops = q.spreadHops ?? 0
    if (spreadHops > 0 && fused.size > 0) {
      const spreadMinWeight = q.spreadMinWeight ?? 2
      const spreadLimit = q.spreadLimit ?? 8
      const spreadSeeds = q.spreadSeeds ?? 5

      const seedTurns = [...fused.values()]
        .filter((x) => x.hit.kind === 'turn')
        .sort((a, b) => b.rrf - a.rrf)
        .slice(0, spreadSeeds)

      const seedKeys = new Set<string>()
      for (const s of seedTurns) {
        for (const e of extractEntities(s.hit.text)) seedKeys.add(e.key)
      }

      const keys = [...seedKeys]
      if (keys.length > 0) {
        const inClause = keys.map(() => '?').join(',')
        const neighbors = new Set<string>()
        // 边是无向的但只存一份（规范化 from_key < to_key），所以两个方向都要查
        for (const r of this.db.prepare(
          `SELECT to_key AS k FROM mem_links
            WHERE from_key IN (${inClause}) AND kind = 'cooccur' AND weight >= ?`,
        ).all(...keys, spreadMinWeight) as unknown as Array<{ k: string }>) neighbors.add(r.k)
        for (const r of this.db.prepare(
          `SELECT from_key AS k FROM mem_links
            WHERE to_key IN (${inClause}) AND kind = 'cooccur' AND weight >= ?`,
        ).all(...keys, spreadMinWeight) as unknown as Array<{ k: string }>) neighbors.add(r.k)
        // 把种子自己剔掉，否则只是把它们再召回一次、白白占名额
        for (const k of keys) neighbors.delete(k)

        const nb = [...neighbors]
        if (nb.length > 0) {
          const nbClause = nb.map(() => '?').join(',')
          // 命中邻居越多的 turn 越可能是扩散目标；*4 是给「已被直接命中」的重复留余量
          const cand = this.db.prepare(
            `SELECT m.turn_id AS turnId, COUNT(*) AS overlap
               FROM mem_mentions m
              WHERE m.entity_key IN (${nbClause})
              GROUP BY m.turn_id
              ORDER BY overlap DESC, m.turn_id
              LIMIT ?`,
          ).all(...nb, spreadLimit * 4) as unknown as Array<{ turnId: string; overlap: number }>

          const want = cand.filter((c) => !fused.has(c.turnId)).slice(0, spreadLimit)
          if (want.length > 0) {
            const rows = this.db.prepare(
              `SELECT t.turn_id, t.session_id, t.turn_index, t.external_id, t.origin,
                      t.occurred_at_ms, t.occurred_raw, b.body
                 FROM mem_turns t
                 LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
                WHERE t.turn_id IN (${want.map(() => '?').join(',')})
                  AND t.scope = ? AND t.deleted_at_ms IS NULL
                  AND t.origin IN (${originSlots})`,
            ).all(...want.map((w) => w.turnId), scope, ...origins) as unknown as Array<{
              turn_id: string
              session_id: string
              turn_index: number
              external_id: string | null
              origin: Origin
              occurred_at_ms: number | null
              occurred_raw: string | null
              body: string | null
            }>
            const byId = new Map(rows.map((r) => [r.turn_id, r]))
            const spreadHits: MemoryHit[] = []
            // 按 overlap 顺序重建——rank() 用数组下标当名次
            for (const w of want) {
              const r = byId.get(w.turnId)
              if (r === undefined) continue
              spreadHits.push({
                kind: 'turn',
                id: r.turn_id,
                // 扩散候选没有字面/语义分，用一个随命中邻居数递增的底分，
                // 让「命中 3 个邻居」比「命中 1 个邻居」排得前
                score: (1 + RECENCY_WEIGHT * (r.occurred_at_ms === null ? 0.5 : recency(r.occurred_at_ms, nowMs)))
                  * (1 + 0.1 * w.overlap),
                origin: r.origin,
                sessionId: r.session_id,
                turnIndex: r.turn_index,
                ...(r.external_id === null ? {} : { externalId: r.external_id }),
                occurredAtMs: r.occurred_at_ms,
                ...(r.occurred_raw === null ? {} : { occurredRaw: r.occurred_raw }),
                text: r.body ?? '',
                recallPath: 'spread',
              })
            }
            // 折扣而不是同权：实测同权时扩散把 any@8 从 32.8% 砸到 1.6%，
            // 而 any@32 只掉 2.8pp——候选没丢，是排序被扩散顶掉了。
            // 扩散是关联证据，不是匹配证据，不该与直接命中平起平坐。
            rank(spreadHits, 'spread', SPREAD_RRF_WEIGHT)
          }
        }
      }
    }

    // 分组名额：fact 与 turn 分开取，避免一方挤满（见 MemoryQuery.factQuota 的注释）。
    // 名额是上限不是固定值——fact 不足时缺口给 turn，fact 为空时行为与不带配额完全一致。
    const scored = [...fused.values()]
      .map(({ hit, rrf }) => ({ ...hit, score: rrf * hit.score }))
      .sort((a, b) => b.score - a.score)
    const profiles = scored.filter((h) => h.kind === 'profile').slice(0, profileQuota)
    // 摘要也要独立名额：与 turn 同池竞争时，短文本的命中密度更高，不分名额会把 turn 挤掉
    const summaries = scored.filter((h) => h.kind === 'summary').slice(0, summaryQuota)
    const reserved = profiles.length + summaries.length
    const factQuota = q.factQuota ?? Math.ceil((limit - reserved) / 2)
    const facts = scored.filter((h) => h.kind === 'fact').slice(0, factQuota)
    const rest = scored.filter((h) => h.kind !== 'fact' && h.kind !== 'profile' && h.kind !== 'summary')
      .slice(0, Math.max(0, limit - reserved - facts.length))
    // 分组配额决定「谁入选」，组内已按 score 排好；合并后总量已 <= limit，
    // 不能再全局重排后截断——那会把配额保证的小组整体挤掉（实测 profile 被 fact 挤出）。
    return [...profiles, ...summaries, ...facts, ...rest].slice(0, limit)
  }

  /**
   * 批量写入向量（v2.17）。同一 `(owner_kind, owner_id)` 覆盖。
   *
   * 必须在一个事务里写完：分批提交会留下「一半 fact 是新模型向量、一半是旧模型」的
   * 中间态，而检索会静默跳过维度不符的那一半——症状只是「变差」，不报错。
   */
  putVectors(
    entries: Array<{ ownerKind: VectorOwnerKind; ownerId: string; vector: ArrayLike<number> }>,
    model: string,
  ): number {
    if (entries.length === 0) return 0
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const stmt = this.db.prepare(
        `INSERT INTO mem_vectors (owner_kind, owner_id, model, dim, vector, updated_at_ms)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(owner_kind, owner_id) DO UPDATE SET
           model = excluded.model, dim = excluded.dim,
           vector = excluded.vector, updated_at_ms = excluded.updated_at_ms`,
      )
      for (const e of entries) {
        stmt.run(e.ownerKind, e.ownerId, model, e.vector.length, encodeVector(e.vector), now)
      }
      this.db.exec('COMMIT')
      // 索引已就绪时增量并入：调度器会持续补向量，每批都重载 5 秒不划算。
      // 未就绪或维度不符时 upsert 自行降级（语义检索退回 SQL 路径），不抛错。
      this.vecIndex.upsert(entries)
      return entries.length
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 给还没有向量的派生项补生成向量。
   *
   * 文本口径**必须与 FTS 索引一致**（fact = subject + predicate + body）。否则 bm25 与
   * 向量比较的其实是两段不同文本，融合结果就无法归因——本会话反复踩的就是这个坑
   * （v2.10 假上界、v2.12 离线/实现不一致、v2.16 探针自写排序）。
   *
   * 失败只影响单批：已成功的批次照常入库，不推进的部分下次重跑会自然被选中。
   */
  async embedPending(opts: {
    embedder: Embedder
    limit?: number
    kinds?: VectorOwnerKind[]
  }): Promise<{ embedded: number; failed: number }> {
    const limit = opts.limit ?? 200
    const kinds = opts.kinds ?? ['fact', 'profile']
    const pending: Array<{ ownerKind: VectorOwnerKind; ownerId: string; text: string }> = []

    if (kinds.includes('fact')) {
      const rows = this.db.prepare(
        `SELECT f.fact_id AS id, f.subject || ' ' || f.predicate || ' ' || COALESCE(b.body,'') AS text
           FROM mem_facts f
           LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
           LEFT JOIN mem_vectors v ON v.owner_kind = 'fact' AND v.owner_id = f.fact_id
          WHERE f.deleted_at_ms IS NULL AND f.retired_at_ms IS NULL
            AND (v.owner_id IS NULL OR v.model != ?)
          ORDER BY f.fact_id
          LIMIT ?`,
      ).all(opts.embedder.model, limit) as unknown as Array<{ id: string; text: string }>
      for (const r of rows) pending.push({ ownerKind: 'fact', ownerId: r.id, text: r.text })
    }

    const room = limit - pending.length
    if (kinds.includes('profile') && room > 0) {
      const rows = this.db.prepare(
        `SELECT p.profile_id AS id, p.profile_body AS text
           FROM mem_profiles p
           LEFT JOIN mem_vectors v ON v.owner_kind = 'profile' AND v.owner_id = p.profile_id
          WHERE p.deleted_at_ms IS NULL AND (v.owner_id IS NULL OR v.model != ?)
          ORDER BY p.profile_id
          LIMIT ?`,
      ).all(opts.embedder.model, room) as unknown as Array<{ id: string; text: string }>
      for (const r of rows) pending.push({ ownerKind: 'profile', ownerId: r.id, text: r.text })
    }

    // turn（2026-11-02 新增）：24.6 万级主检索对象。默认不含：全量向量化约 44 分钟，
    // 不能因为类型允许就让例行补齐突然跑满一小时。要 turn 必须显式传 `kinds: ['turn']`。
    // 文本口径 = body，与 `mem_fts_turns` 索引的列完全一致（fold.ts:150 写的也是 body）——
    // 口径不一致会让 bm25 与向量比较两段不同文本，融合结果无法归因（裁过三次）。
    // 排序用 rowid：24.6 万条时走主键顺序，且与批量向量化脚本的断点续跑顺序一致。
    const roomTurn = limit - pending.length
    if (kinds.includes('turn') && roomTurn > 0) {
      const rows = this.db.prepare(
        `SELECT t.turn_id AS id, b.body AS text
           FROM mem_turns t
           LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
           LEFT JOIN mem_vectors v ON v.owner_kind = 'turn' AND v.owner_id = t.turn_id
          WHERE t.deleted_at_ms IS NULL AND b.body IS NOT NULL
            AND (v.owner_id IS NULL OR v.model != ?)
          ORDER BY t.rowid
          LIMIT ?`,
      ).all(opts.embedder.model, roomTurn) as unknown as Array<{ id: string; text: string }>
      for (const r of rows) pending.push({ ownerKind: 'turn', ownerId: r.id, text: r.text })
    }

    if (pending.length === 0) return { embedded: 0, failed: 0 }

    let embedded = 0
    let failed = 0
    // 单批 32 条：本机 bge-m3 单条约 20ms，32 条仍在一次请求的合理区间内
    const BATCH = 32
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH)
      let vecs: number[][]
      try {
        vecs = await opts.embedder.embed(batch.map((b) => b.text))
      } catch {
        failed += batch.length
        continue
      }
      const entries = batch.map((b, j) => ({ ownerKind: b.ownerKind, ownerId: b.ownerId, vector: vecs[j] }))
      const usable = entries.filter((e) => e.vector !== undefined && e.vector.length > 0)
      embedded += this.putVectors(usable, opts.embedder.model)
      failed += entries.length - usable.length
    }
    return { embedded, failed }
  }

  /** 向量覆盖情况——排查「为什么向量路没效果」时第一个要看的东西。 */
  // ---- V1-14 前瞻记忆：意图 ----

  /**
   * 建一条前瞻意图。时间校验是硬闸门（见 `validateFireAt`）——
   * 中文时间解析走「模型给绝对时刻 + 本地校验」（`docs/design-intent-memory-v1-14.md` 决策 1），
   * 模型的时间算术不可全信，越界一律拒绝而不是静默接受。
   */
  createIntent(input: CreateIntentInput): string {
    const now = Date.now()
    validateFireAt(input.fireAtMs, now)
    const conditionRaw = input.conditionRaw.trim()
    const action = input.action.trim()
    if (conditionRaw === '') throw new Error('intent: condition_raw 不能为空')
    if (action === '') throw new Error('intent: action 不能为空')
    const intentId = `int-${randomUUID()}`
    this.appendEvent({
      kind: 'intent.created',
      actor: input.actor,
      recordedAtMs: now,
      payload: {
        intent_id: intentId,
        condition_raw: conditionRaw,
        action,
        fire_at_ms: input.fireAtMs,
        created_at_ms: now,
        source_turn_id: input.sourceTurnId ?? null,
      },
    })
    return intentId
  }

  /**
   * 取消未触发的意图。
   *
   * 终态纪律：已 fired 的拒绝（状态不可倒退）；已 cancelled 的**幂等无操作**，
   * 且不改写首次记录的 `cancelled_at_ms`——重复取消不该让历史时刻漂移。
   */
  cancelIntent(input: { actor: ActorKind; intentId: string }): void {
    const row = this.getIntent(input.intentId)
    if (row === undefined) throw new Error(`intent: 不存在 ${input.intentId}`)
    if (row.status === 'fired') throw new Error('intent: 已触发的意图不能取消（状态不可倒退）')
    if (row.status === 'cancelled') return
    this.appendEvent({
      kind: 'intent.cancelled',
      actor: input.actor,
      recordedAtMs: Date.now(),
      payload: { intent_id: input.intentId, cancelled_at_ms: Date.now() },
    })
  }

  /**
   * 记一次**投递**。`firedAtMs` 是实际触发时刻，可能与计划时刻差很远
   * （方案 B：进程不在时下次启动补发）。非 pending 状态视为无操作——补触发可能重放。
   *
   * `sessionId` 是这条提醒被念给的那个会话。留痕只能由「真的进了本轮的 messages」
   * 触发（`intent-trigger.ts` 的 `markDelivered`），所以这个参数不是装饰：
   * 没有它，事后无法回答「这条提醒到底有没有说出口、说给了谁」。
   */
  markFired(input: { actor: ActorKind; intentId: string; firedAtMs: number; sessionId?: string }): void {
    const row = this.getIntent(input.intentId)
    if (row === undefined) throw new Error(`intent: 不存在 ${input.intentId}`)
    if (row.status !== 'pending') return
    this.appendEvent({
      kind: 'intent.fired',
      actor: input.actor,
      recordedAtMs: Date.now(),
      payload: {
        intent_id: input.intentId,
        fired_at_ms: input.firedAtMs,
        session_id: input.sessionId ?? null,
      },
    })
  }

  getIntent(intentId: string): IntentRow | undefined {
    const row = this.db.prepare(
      `SELECT intent_id, condition_raw, action, fire_at_ms, status, created_at_ms,
              fired_at_ms, cancelled_at_ms, source_turn_id, session_id
         FROM mem_intents WHERE intent_id = ?`,
    ).get(intentId) as unknown as RawIntentRow | undefined
    return row === undefined ? undefined : toIntentRow(row)
  }

  listIntents(opts: { status?: IntentStatus } = {}): IntentRow[] {
    const base = `SELECT intent_id, condition_raw, action, fire_at_ms, status, created_at_ms,
                         fired_at_ms, cancelled_at_ms, source_turn_id, session_id
                    FROM mem_intents`
    const rows = (opts.status === undefined
      ? this.db.prepare(`${base} ORDER BY created_at_ms DESC`).all()
      : this.db.prepare(`${base} WHERE status = ? ORDER BY created_at_ms DESC`).all(opts.status)) as unknown as RawIntentRow[]
    return rows.map(toIntentRow)
  }

  /**
   * 已到点、仍 pending 的意图，按计划时刻升序。
   * W3 的调度器在启动时用它做补触发，运行中用同一个查询判断是否到点。
   */
  dueIntents(nowMs: number): IntentRow[] {
    const rows = this.db.prepare(
      `SELECT intent_id, condition_raw, action, fire_at_ms, status, created_at_ms,
              fired_at_ms, cancelled_at_ms, source_turn_id, session_id
         FROM mem_intents
        WHERE status = 'pending' AND fire_at_ms <= ?
        ORDER BY fire_at_ms ASC`,
    ).all(nowMs) as unknown as RawIntentRow[]
    return rows.map(toIntentRow)
  }

  vectorStats(): Array<{ ownerKind: string; model: string; count: number }> {
    return this.db.prepare(
      `SELECT owner_kind AS ownerKind, model, COUNT(*) AS count
         FROM mem_vectors GROUP BY owner_kind, model ORDER BY owner_kind, model`,
    ).all() as unknown as Array<{ ownerKind: string; model: string; count: number }>
  }

  /**
   * 写入一条归纳画像（Wave 3）。
   *
   * 为什么单独一张表而不是塞进 mem_facts：`gold` 是画像不是事实——实测同一批 10 题，
   * fact 组 1/10、画像组 4/10，差别只在产物形态。混进 fact 池还会被字面匹配挤掉
   * （v2.15 的画像闸门就是为此而加）。
   *
   * 传 `profileId` 时是幂等覆盖，便于巩固管线重跑同一批 turn。
   */
  putProfile(input: {
    subject: string
    aspect: string
    profileText: string
    evidenceFactIds?: string[]
    confidence?: number
    origin?: Origin
    profileId?: string
  }): string {
    // 实现抽到 write.ts：巩固管线只拿得到 DatabaseSync、拿不到 store 实例，
    // 两处各写一份 SQL 迟早漂移（FTS 少同步一行就静默查不到）。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const id = writeProfile(this.db, input)
      this.db.exec('COMMIT')
      return id
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 写入一条情景摘要（Wave B）。
   *
   * 在此之前 `mem_summaries` 是**零写入**：表建了、`rebuildProjections` 里会清它，
   * 但全仓没有一处往里写。正文走 `mem_bodies`（与 fact/turn 同一条外置路线），
   * FTS 在同一事务里同步——不同步的话摘要条目永远检索不到。
   */
  putSummary(input: {
    subjectKind: string
    subjectId: string
    text: string
    sourceTurnIds?: string[]
    origin?: Origin
    summaryId?: string
  }): string {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const id = writeSummary(this.db, input)
      this.db.exec('COMMIT')
      return id
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }


  /**
   * 按会话取 turn（含正文），供摘要生成使用。
   *
   * 正文走 `mem_bodies`（与 `readBodyForForget` 同一条外置路线），所以这里 LEFT JOIN。
   * 顺序按 `turn_index` 升序——摘要要顺着对话推进读，倒序会把结论放在最前面。
   */
  turnsForSession(sessionId: string, opts: { limit?: number } = {}): Array<{
    turnId: string
    speaker: string
    text: string
    occurredAtMs: number | null
  }> {
    const rows = this.db.prepare(
      `SELECT t.turn_id AS turnId, t.speaker AS speaker, t.occurred_at_ms AS occurredAtMs, b.body AS body
         FROM mem_turns t LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE t.scope = ? AND t.session_id = ? AND t.deleted_at_ms IS NULL
        ORDER BY t.turn_index ASC LIMIT ?`,
    ).all(SCOPE, sessionId, opts.limit ?? 40) as Array<{
      turnId: string
      speaker: string
      occurredAtMs: number | null
      body: string | null
    }>
    return rows.map((r) => ({
      turnId: r.turnId,
      speaker: r.speaker,
      text: r.body ?? '',
      occurredAtMs: r.occurredAtMs,
    }))
  }

  /**
   * 列出现有会话（按最近活动倒序），每个带轮数与首条消息。
   *
   * 供 `prts_session_recall` 使用：模型此前完全不知道历史上有哪些会话，
   * 只能靠语义检索碰运气。有了这个才能「先看目录、再读某一章」。
   */
  sessionsWithTurns(limit = 20): Array<{
    sessionId: string
    turnCount: number
    lastAtMs: number | null
    firstText: string
  }> {
    const rows = this.db.prepare(
      `SELECT t.session_id AS sessionId,
              COUNT(*) AS turnCount,
              MAX(t.occurred_at_ms) AS lastAtMs,
              (SELECT b2.body FROM mem_turns t2
                 LEFT JOIN mem_bodies b2 ON b2.body_ref = t2.body_ref
                WHERE t2.scope = t.scope AND t2.session_id = t.session_id
                  AND t2.deleted_at_ms IS NULL
                ORDER BY t2.turn_index ASC LIMIT 1) AS firstText
         FROM mem_turns t
        WHERE t.scope = ? AND t.deleted_at_ms IS NULL
        GROUP BY t.session_id
        ORDER BY lastAtMs DESC
        LIMIT ?`,
    ).all(SCOPE, limit) as Array<{
      sessionId: string
      turnCount: number
      lastAtMs: number | null
      firstText: string | null
    }>
    return rows.map((r) => ({
      sessionId: r.sessionId,
      turnCount: r.turnCount,
      lastAtMs: r.lastAtMs,
      firstText: r.firstText ?? '',
    }))
  }

  /** 取一条摘要的来源轮次 id（`source_turn_ids` 存的是 JSON 数组串）。 */
  summarySourceTurns(summaryId: string): string[] {    const row = this.db.prepare(
      'SELECT source_turn_ids AS s FROM mem_summaries WHERE summary_id = ?',
    ).get(summaryId) as { s: string | null } | undefined
    if (row?.s == null || row.s === '') return []
    try {
      const parsed: unknown = JSON.parse(row.s)
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }

  /** 统计摘要数量。 */
  countSummaries(opts: { origin?: Origin } = {}): number {
    const row = (opts.origin === undefined
      ? this.db.prepare('SELECT COUNT(*) AS c FROM mem_summaries WHERE scope = ? AND deleted_at_ms IS NULL').get(SCOPE)
      : this.db.prepare('SELECT COUNT(*) AS c FROM mem_summaries WHERE scope = ? AND deleted_at_ms IS NULL AND origin = ?').get(SCOPE, opts.origin)) as { c: number }
    return row.c
  }

  /** 统计画像数量——排查「画像路为什么没结果」时先看这个。 */
  countProfiles(opts: { origin?: Origin } = {}): number {
    const sql = opts.origin === undefined
      ? 'SELECT COUNT(*) AS c FROM mem_profiles WHERE scope = ? AND deleted_at_ms IS NULL'
      : 'SELECT COUNT(*) AS c FROM mem_profiles WHERE scope = ? AND deleted_at_ms IS NULL AND origin = ?'
    const row = (opts.origin === undefined
      ? this.db.prepare(sql).get(SCOPE)
      : this.db.prepare(sql).get(SCOPE, opts.origin)) as { c: number }
    return row.c
  }

  /**
   * 跑一批巩固（Wave 2，规则部分）：实体抽取 + 共现边 + 主题计数 + 水位线。
   *
   * 不调模型，零 API 成本。达到 `maxTurns` 而仍有剩余时 `stopped === 'budget'`，
   * 调用方循环调用即可接着跑；取消（`signal`）只在批边界生效，不会留下半成品。
   */
  consolidateRules(opts: ConsolidateOptions = {}): ConsolidateResult {
    return runConsolidation(this.db, opts)
  }

  /** 巩固水位线与产出规模。 */
  consolidationStats(scope?: string): ReturnType<typeof readConsolidationStats> {
    return readConsolidationStats(this.db, scope)
  }

  /** 当前巩固游标（最后一条已处理 turn 的 rowid）。 */
  consolidationCursor(scope?: string): number {
    return readConsolidationCursor(this.db, scope)
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

  // ------------------------------------------------------------ P0-2a：所有者删除与纠正

  /** id → 归属表。profile/summary 的 id 形如 profile-<uuid>/summary-<uuid>（与 search 命中同形）。 */
  private resolveForgetTarget(id: string): { kind: 'turn' | 'fact' | 'profile' | 'summary'; row: { deleted: boolean } } | undefined {
    const checks: Array<[string, string, 'turn' | 'fact' | 'profile' | 'summary']> = [
      ['turn_id', 'mem_turns', 'turn'],
      ['fact_id', 'mem_facts', 'fact'],
      ['profile_id', 'mem_profiles', 'profile'],
      ['summary_id', 'mem_summaries', 'summary'],
    ]
    for (const [col, table, kind] of checks) {
      if (id.startsWith(kind + '-')) {
        const row = this.db.prepare(`SELECT deleted_at_ms AS d FROM ${table} WHERE ${col} = ?`).get(id) as { d: number | null } | undefined
        if (row === undefined) return undefined
        return { kind, row: { deleted: row.d !== null } }
      }
    }
    return undefined
  }

  /** planForget 与 forget 共用：只读，事务内重算以兜住 plan→forget 间的写入。 */
  private buildForgetPlan(ids: string[]): ForgetPlan {
    const plan: ForgetPlan = { turns: [], facts: [], profiles: [], summaries: [], vectors: 0, mentions: 0, orphanEntities: 0, sessionsToRebuild: [], notFound: [], causeOf: {} }
    const turnSet = new Set<string>(); const factSet = new Set<string>()
    const profSet = new Set<string>(); const sumSet = new Set<string>()
    const tops = new Set<string>()
    for (const id of ids) {
      const t = this.resolveForgetTarget(id)
      if (t === undefined || t.row.deleted) { plan.notFound.push(id); continue }
      tops.add(id)
      if (t.kind === 'turn') turnSet.add(id)
      else if (t.kind === 'fact') factSet.add(id)
      else if (t.kind === 'profile') profSet.add(id)
      else sumSet.add(id)
    }
    // turn 级联：facts/summaries 的 source_turn_ids（JSON 数组文本）含该 turn_id。
    // 每个级联项记 causeOf=触发它的顶层 turn；同时是顶层输入的项不记（仍按顶层处理）。
    for (const turnId of turnSet) {
      const like = `%"${turnId}"%`
      for (const r of this.db.prepare(`SELECT fact_id FROM mem_facts WHERE source_turn_ids LIKE ? AND deleted_at_ms IS NULL`).all(like) as { fact_id: string }[]) {
        if (!tops.has(r.fact_id) && !factSet.has(r.fact_id)) plan.causeOf[r.fact_id] = turnId
        if (!tops.has(r.fact_id)) factSet.add(r.fact_id)
      }
      for (const r of this.db.prepare(`SELECT summary_id FROM mem_summaries WHERE source_turn_ids LIKE ? AND deleted_at_ms IS NULL`).all(like) as { summary_id: string }[]) {
        if (!tops.has(r.summary_id) && !sumSet.has(r.summary_id)) plan.causeOf[r.summary_id] = turnId
        if (!tops.has(r.summary_id)) sumSet.add(r.summary_id)
      }
    }
    // fact 级联：profiles 的 evidence_fact_ids 含该 fact_id。
    // 链式级联 turn→fact→profile：profile 的 cause 回溯到那个顶层 turn。
    for (const factId of factSet) {
      const cause = plan.causeOf[factId] ?? factId
      const like = `%"${factId}"%`
      for (const r of this.db.prepare(`SELECT profile_id FROM mem_profiles WHERE evidence_fact_ids LIKE ? AND deleted_at_ms IS NULL`).all(like) as { profile_id: string }[]) {
        if (!tops.has(r.profile_id) && !profSet.has(r.profile_id)) plan.causeOf[r.profile_id] = cause
        if (!tops.has(r.profile_id)) profSet.add(r.profile_id)
      }
    }
    plan.turns = [...turnSet]; plan.facts = [...factSet]
    plan.profiles = [...profSet]; plan.summaries = [...sumSet]
    if (turnSet.size > 0) {
      const slots = [...turnSet].map(() => '?').join(',')
      plan.mentions = (this.db.prepare(`SELECT count(*) AS c FROM mem_mentions WHERE turn_id IN (${slots})`).get(...turnSet) as { c: number }).c
      plan.orphanEntities = (this.db.prepare(
        `SELECT count(*) AS c FROM mem_mentions m WHERE m.turn_id IN (${slots})
           AND NOT EXISTS (SELECT 1 FROM mem_mentions m2 WHERE m2.entity_key = m.entity_key AND m2.turn_id NOT IN (${slots}))`,
      ).get(...turnSet, ...turnSet) as { c: number }).c
      plan.sessionsToRebuild = (this.db.prepare(`SELECT DISTINCT session_id AS s FROM mem_turns WHERE turn_id IN (${slots})`).all(...turnSet) as { s: string }[]).map(r => r.s)
    }
    // vectors：所有被删 owner（turn/fact/profile）各算一行
    const owners: Array<[string, string]> = [
      ...plan.turns.map((i): [string, string] => ['turn', i]),
      ...plan.facts.map((i): [string, string] => ['fact', i]),
      ...plan.profiles.map((i): [string, string] => ['profile', i]),
    ]
    for (const [k, i] of owners) {
      plan.vectors += (this.db.prepare('SELECT count(*) AS c FROM mem_vectors WHERE owner_kind = ? AND owner_id = ?').get(k, i) as { c: number }).c
    }
    return plan
  }

  /** 只读删除计划：级联见 docs/design-memory-forget.md §1。不存在/已删 → notFound，不报错。 */
  planForget(ids: string[]): ForgetPlan { return this.buildForgetPlan(ids) }

  /** 供 forgetFlow 的会话日志扫描读正文——只在删除执行前有效。 */
  readBodyForForget(kind: 'turn' | 'fact' | 'summary' | 'profile', id: string): string | null {
    if (kind === 'profile') {
      return (this.db.prepare('SELECT profile_body AS b FROM mem_profiles WHERE profile_id = ?').get(id) as { b: string | null } | undefined)?.b ?? null
    }
    const table = kind === 'turn' ? 'mem_turns' : kind === 'fact' ? 'mem_facts' : 'mem_summaries'
    const col = kind === 'turn' ? 'turn_id' : kind === 'fact' ? 'fact_id' : 'summary_id'
    return (this.db.prepare(
      `SELECT b.body AS b FROM ${table} t LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref WHERE t.${col} = ?`,
    ).get(id) as { b: string | null } | undefined)?.b ?? null
  }

  /**
   * 所有者删除：事务内重算 plan 后执行——plan→forget 间的写入（巩固、新 turn）
   * 会被重新级联进来，不会漏删。
   * 存活实体的 mention_count / 边权不回调：那是统计量不是正文。
   */
  forget(ids: string[], actor: ActorKind = 'owner'): ForgetResult {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    let plan: ForgetPlan
    try {
      plan = this.buildForgetPlan(ids)
      if (plan.turns.length === 0 && plan.facts.length === 0 && plan.profiles.length === 0 && plan.summaries.length === 0) {
        this.db.exec('ROLLBACK')
        return { ok: false, reason: 'plan 为空：全部 id 不存在或已删除' }
      }
      // memory.deleted 只认 turn/fact——链外派生项在下面直接 SQL 清。
      // cascade_of 取 plan.causeOf（只记级联项）；derived_purged 只挂顶层目标、
      // 且只含由该顶层目标引起的派生项——不把整份 plan 摊到每条事件上。
      const tops2 = new Set(ids.filter(i => !plan.notFound.includes(i)))
      const vectorsOf = (ownerPairs: Array<[string, string]>): number => {
        let n = 0
        for (const [k, i] of ownerPairs) n += (this.db.prepare('SELECT count(*) AS c FROM mem_vectors WHERE owner_kind = ? AND owner_id = ?').get(k, i) as { c: number }).c
        return n
      }
      // 孤儿实体归属：归到第一个（plan.turns 顺序）提及它的被删 turn。
      const orphanOwner = new Map<string, string>()
      if (plan.turns.length > 0) {
        const slots = plan.turns.map(() => '?').join(',')
        const rows = this.db.prepare(
          `SELECT m.entity_key AS k, m.turn_id AS t FROM mem_mentions m WHERE m.turn_id IN (${slots})`,
        ).all(...plan.turns) as { k: string; t: string }[]
        const hasOutside = (k: string) => (this.db.prepare(
          `SELECT count(*) AS c FROM mem_mentions WHERE entity_key = ? AND turn_id NOT IN (${slots})`,
        ).get(k, ...plan.turns) as { c: number }).c > 0
        for (const t of plan.turns) {
          for (const r of rows.filter(x => x.t === t)) {
            if (!orphanOwner.has(r.k) && !hasOutside(r.k)) orphanOwner.set(r.k, t)
          }
        }
      }
      const derivedOf = (topId: string): Record<string, unknown> => {
        const factsOf = plan.facts.filter(f => plan.causeOf[f] === topId)
        const profilesOf = plan.profiles.filter(p => plan.causeOf[p] === topId)
        const sumsOf = plan.summaries.filter(x => plan.causeOf[x] === topId)
        const ownerPairs: Array<[string, string]> = [
          [topId.startsWith('turn-') ? 'turn' : topId.startsWith('fact-') ? 'fact' : topId.startsWith('profile-') ? 'profile' : 'summary', topId],
          ...factsOf.map((i): [string, string] => ['fact', i]),
          ...profilesOf.map((i): [string, string] => ['profile', i]),
        ]
        return {
          profiles: profilesOf, summaries: sumsOf,
          vectors: vectorsOf(ownerPairs),
          mentions: topId.startsWith('turn-')
            ? (this.db.prepare('SELECT count(*) AS c FROM mem_mentions WHERE turn_id = ?').get(topId) as { c: number }).c : 0,
          orphan_entities: [...orphanOwner.values()].filter(v => v === topId).length,
        }
      }
      for (const [kind, list] of [['turn', plan.turns], ['fact', plan.facts]] as const) {
        for (const id of list) {
          const deletionId = `del-${randomUUID()}`
          this.appendEvent({
            kind: 'memory.deleted', actor, recordedAtMs: now,
            payload: {
              deletion_id: deletionId, target_kind: kind, target_id: id,
              derivatives: ['body', 'projection', 'derived'],
              ...(id in plan.causeOf ? { cascade_of: plan.causeOf[id] } : {}),
              ...(tops2.has(id) ? { derived_purged: derivedOf(id) } : {}),
            },
          })
          this.appendEvent({ kind: 'deletion.derivative-done', actor, recordedAtMs: now, payload: { deletion_id: deletionId } })
        }
      }
      // profiles：删行 + FTS
      for (const id of plan.profiles) {
        const rid = (this.db.prepare('SELECT rowid AS r FROM mem_profiles WHERE profile_id = ?').get(id) as { r: number } | undefined)?.r
        if (rid !== undefined) this.db.prepare('DELETE FROM mem_fts_profiles WHERE rowid = ?').run(rid)
        this.db.prepare('DELETE FROM mem_profiles WHERE profile_id = ?').run(id)
      }
      // summaries：删行 + FTS + 清正文（summaries 的 body 在 mem_bodies）
      for (const id of plan.summaries) {
        const row = this.db.prepare('SELECT rowid AS r, body_ref FROM mem_summaries WHERE summary_id = ?').get(id) as { r: number; body_ref: string | null } | undefined
        if (row?.body_ref) this.db.prepare('UPDATE mem_bodies SET body = NULL WHERE body_ref = ?').run(row.body_ref)
        if (row) this.db.prepare('DELETE FROM mem_fts_summaries WHERE rowid = ?').run(row.r)
        this.db.prepare('UPDATE mem_summaries SET body_ref = NULL, deleted_at_ms = ? WHERE summary_id = ?').run(now, id)
      }
      // vectors / mentions / 孤儿实体
      for (const [k, i] of [
        ...plan.turns.map((x): [string, string] => ['turn', x]),
        ...plan.facts.map((x): [string, string] => ['fact', x]),
        ...plan.profiles.map((x): [string, string] => ['profile', x]),
      ]) this.db.prepare('DELETE FROM mem_vectors WHERE owner_kind = ? AND owner_id = ?').run(k, i)
      // 删除是所有者低频操作（forget 流程），重建索引比维护删除墓碑简单且不会漏。
      // 重建后 `search` 会先走 SQL 降级路径，直到下一次 `warmVectorIndex()`。
      this.vecIndex.reset()
      for (const t of plan.turns) this.db.prepare('DELETE FROM mem_mentions WHERE turn_id = ?').run(t)
      const orphans = this.db.prepare(
        `SELECT entity_key FROM mem_entities e
          WHERE NOT EXISTS (SELECT 1 FROM mem_mentions m WHERE m.entity_key = e.entity_key)`,
      ).all() as { entity_key: string }[]
      for (const o of orphans) {
        this.db.prepare('DELETE FROM mem_links WHERE from_key = ? OR to_key = ?').run(o.entity_key, o.entity_key)
        // topic 主键就是 entity_key（consolidate.ts 的 upsertTopic 按同一 key 写）——
        // 它是实体名的规范化形态，属于内容，必须随实体删。
        this.db.prepare('DELETE FROM mem_topics WHERE topic = ?').run(o.entity_key)
        this.db.prepare('DELETE FROM mem_entities WHERE entity_key = ?').run(o.entity_key)
      }
      // sessions：剩余 turn 重算 body；无剩余则删行
      for (const sid of plan.sessionsToRebuild) {
        const sess = this.db.prepare(
          `SELECT group_concat(b2.body, ' ') AS body, count(*) AS n
             FROM mem_turns t2 JOIN mem_bodies b2 ON b2.body_ref = t2.body_ref
            WHERE t2.session_id = ? AND b2.body IS NOT NULL AND t2.deleted_at_ms IS NULL`,
        ).get(sid) as { body: string | null; n: number } | undefined
        const rid = (this.db.prepare('SELECT rowid AS r FROM mem_sessions WHERE session_id = ?').get(sid) as { r: number } | undefined)?.r
        if (sess !== undefined && sess.body !== null && sess.body !== '') {
          this.db.prepare('UPDATE mem_sessions SET body = ?, turn_count = ?, updated_at_ms = ? WHERE session_id = ?').run(sess.body, sess.n, now, sid)
          if (rid !== undefined) {
            this.db.prepare('DELETE FROM mem_fts_sessions WHERE rowid = ?').run(rid)
            this.db.prepare('INSERT INTO mem_fts_sessions(rowid, body) VALUES (?,?)').run(rid, sess.body)
          }
        } else {
          if (rid !== undefined) this.db.prepare('DELETE FROM mem_fts_sessions WHERE rowid = ?').run(rid)
          this.db.prepare('DELETE FROM mem_sessions WHERE session_id = ?').run(sid)
        }
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    // 提交后做物理层收口：FTS 段合并（旧 token 仍在段里）+ WAL 截断（旧页还在文件里）。
    for (const t of ['mem_fts_turns', 'mem_fts_facts', 'mem_fts_sessions', 'mem_fts_profiles', 'mem_fts_summaries']) {
      this.db.exec(`INSERT INTO ${t}(${t}) VALUES('optimize')`)
    }
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { ok: true, plan }
  }

  /** 所有者纠正：新 fact 顶替旧值；旧行退役且记 superseded_by（可逆）。turn 只能删不能改。 */
  correctFact(input: { factId: string; object: string; actor?: ActorKind }): string {
    const actor = input.actor ?? 'owner'
    if (input.factId.startsWith('turn-')) {
      throw new Error('对话原文（turn）只能删除，不能纠正——内容已发生，修改等于改写历史')
    }
    const old = this.db.prepare(
      'SELECT fact_id, subject, predicate, identity_key, origin, retention_class, importance, deleted_at_ms, retired_at_ms, superseded_by, valid_from_ms, applicable_when, confidence, slot FROM mem_facts WHERE fact_id = ?',
    ).get(input.factId) as {
      fact_id: string; subject: string; predicate: string; identity_key: string; origin: string
      retention_class: string; importance: number; deleted_at_ms: number | null; retired_at_ms: number | null
      superseded_by: string | null; valid_from_ms: number | null; applicable_when: string | null; confidence: number | null
      slot: string | null
    } | undefined
    if (old === undefined || old.deleted_at_ms !== null) throw new Error(`correctFact：${input.factId} 不存在或已删除`)
    if (old.superseded_by !== null) throw new Error(`correctFact：${input.factId} 已被 ${old.superseded_by} 取代，改它没意义——纠正新行`)
    const now = Date.now()
    const newFactId = `fact-${randomUUID()}`
    const bodyRef = `body-${randomUUID()}`
    const bodySha = sha256hex(input.object)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        `INSERT INTO mem_bodies (body_ref, sha256, body, byte_length, written_at_ms) VALUES (?,?,?,?,?)`,
      ).run(bodyRef, bodySha, input.object, Buffer.byteLength(input.object, 'utf8'), now)
      this.appendEvent({
        kind: 'fact.corrected', actor, recordedAtMs: now,
        payload: {
          fact_id: input.factId, new_fact_id: newFactId,
          subject: old.subject, predicate: old.predicate,
          identity_key: `${old.subject.trim().toLowerCase()}|${old.predicate.trim().toLowerCase()}|${bodySha}`,
          body_ref: bodyRef, body_sha256: bodySha,
          provenance: 'stated', confirmation_basis: 'owner-stated',
          origin: old.origin, retention_class: old.retention_class,
          importance: Math.max(old.importance, 0.8), source_turn_ids: [],
          valid_from_ms: old.valid_from_ms, applicable_when: old.applicable_when, confidence: old.confidence,
          // 继承旧行的 slot：纠正后的新值留在同一主题槽里，
          // 之后的模型更正才能继续在同一槽位上取代。
          slot: old.slot,
        },
      })
      this.db.exec('COMMIT')
      return newFactId
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  rebuildProjections(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 全文索引也是投影：重建时先清空，再由 applyMemoryEvent 逐条重建。
      this.db.exec('DELETE FROM mem_fts_sessions; DELETE FROM mem_sessions; DELETE FROM mem_fts_turns; DELETE FROM mem_fts_facts; DELETE FROM mem_turns; DELETE FROM mem_facts; DELETE FROM mem_deletions')
      // mem_topics / mem_profiles / mem_summaries 都不在清理范围内：它们由巩固管线写入，
      // 与 mem_profiles 同类，是**链外派生项**而不是事件序列的纯函数（巩固依赖 turn 正文，
      // 而正文外置在 mem_bodies）。这里删掉它们会造成难查的丢失：游标不跟着重置，
      // 巩固不会重算已跳过的 turn，派生项于是永久消失且无任何报错。
      const rows = this.db.prepare('SELECT * FROM memory_events ORDER BY seq')
        .all() as unknown as MemoryEventRow[]
      for (const r of rows) applyMemoryEvent(this.db, r)
      // 重放时逐 turn 重算 session 会退化成 O(n²)；这里一次性补齐。
      this.db.exec('DELETE FROM mem_fts_sessions; DELETE FROM mem_sessions;')
      ensureSessionsBuilt(this.db, true)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 记录一次记忆注入的清单（工作区装配 ⑧ 的第一刀，`docs/context-assembly-status.md` 三-S2）。
   *
   * **只观测，不决策**：写一条事件，不改任何投影行（`fold.ts` 里是显式 no-op）。
   * 不记录正文——这条链只追加不可改，正文写进去就删不掉；要内容按 `hit_ids` 回投影取。
   *
   * 代价（评审时称量过，不是没想过）：
   * - `memory_events` 每轮多一条，与 `turn.recorded` 同量级，不是数量级变化；
   * - 链断即记忆面 fail-closed 的暴露面不会因多一种 kind 扩大——同一写入路径、同一哈希链；
   * - `rebuildProjections` 重放要多扫过这些行，所以它们必须能被 fold 安全跳过（已接住）。
   *
   * 收益：将来标定注入预算时有真实分布可用（`usedChars`），而不是拍一个常量。
   */
  recordInjection(input: RecordInjectionInput): void {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.appendEvent({
        kind: 'injection.recorded',
        // actor 固定 system：这是宿主自己的观测，不是主人或模型的发言。
        actor: 'system',
        recordedAtMs: now,
        payload: {
          session_id: input.sessionId,
          turn: input.turn,
          step: input.step,
          injected: input.injected,
          hit_ids: [...input.hitIds],
          kinds: { ...input.kinds },
          used_chars: input.usedChars,
          limit: input.limit,
          outcome: input.outcome,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          ...(input.chain === undefined ? {} : { chain: input.chain }),
          ...(input.chains === undefined ? {} : { chains: [...input.chains] }),
          ...(input.droppedChains === undefined ? {} : { dropped_chains: [...input.droppedChains] }),
        },
      })
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /**
   * 读回注入清单，用于事后解释「她当时为什么这么说」与将来的预算标定。
   *
   * 走 `json_extract` 而不是新表：清单的**唯一事实来源是事件链**，投影只由 `fold.ts` 更新，
   * 而这里明确不为它建投影——另建一张表就等于把同一事实存两份。
   */
  injectionRecords(opts: { sessionId?: string; outcome?: 'injected' | 'skipped'; limit?: number } = {}): InjectionRecord[] {
    const limit = opts.limit ?? 100
    const clauses: string[] = []
    const params: string[] = []
    if (opts.sessionId !== undefined) {
      clauses.push(`json_extract(payload_json, '$.session_id') = ?`)
      params.push(opts.sessionId)
    }
    if (opts.outcome === 'skipped') {
      clauses.push(`json_extract(payload_json, '$.outcome') = 'skipped'`)
    } else if (opts.outcome === 'injected') {
      // 2026-11-04 之前的事件没有 outcome 字段——那时只记成功路径，缺失即注入。
      // 不做数据迁移：链是只追加的，改写历史比读时兼容危险得多。
      clauses.push(`(json_extract(payload_json, '$.outcome') IS NULL OR json_extract(payload_json, '$.outcome') = 'injected')`)
    }
    const where = clauses.length === 0 ? '' : ` AND ${clauses.join(' AND ')}`
    const rows = this.db.prepare(
      `SELECT payload_json AS p, recorded_at_ms AS t FROM memory_events
        WHERE kind = 'injection.recorded'${where} ORDER BY seq DESC LIMIT ?`,
    ).all(...params, limit) as unknown as Array<{ p: string; t: number }>
    return rows.map((row) => {
      const p = JSON.parse(row.p) as {
        session_id: string
        turn: number
        step: number
        injected: number
        hit_ids: string[]
        kinds: Record<string, number>
        used_chars: number
        limit: number
        outcome?: 'injected' | 'skipped'
        reason?: string
        chain?: string
        chains?: string[]
        dropped_chains?: string[]
      }
      return {
        sessionId: p.session_id,
        turn: p.turn,
        step: p.step,
        injected: p.injected,
        hitIds: p.hit_ids,
        kinds: p.kinds,
        usedChars: p.used_chars,
        limit: p.limit,
        outcome: p.outcome === 'skipped' ? 'skipped' : 'injected',
        ...(p.reason === undefined ? {} : { reason: p.reason }),
        ...(p.chain === undefined ? {} : { chain: p.chain }),
        ...(p.chains === undefined ? {} : { chains: p.chains }),
        ...(p.dropped_chains === undefined ? {} : { droppedChains: p.dropped_chains }),
        recordedAtMs: row.t,
      }
    })
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
