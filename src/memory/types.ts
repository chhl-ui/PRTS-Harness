/** 记忆模块：对外类型。对应 `docs/design-memory-v1.md` §6.2 / §6.4 / §6.5。 */

/** 谁说的。**与 confirmationBasis 是两条不同关系**，不合并（设计稿 §八 第 14 条）。 */
export type Provenance = 'stated' | 'inferred'

/** 谁确认的。组合受 CHECK 白名单约束：`(stated, model-inferred)` 非法。 */
export type ConfirmationBasis = 'owner-stated' | 'model-inferred' | 'verifier'

/** 来自真实对话，还是基准导入。**验收路径默认只可见 live**（设计稿 §6.4）。 */
export type Origin = 'live' | 'benchmark'

export type RetentionClass = 'permanent' | 'retirable' | 'clearable'

export type ActorKind = 'owner' | 'model' | 'system'

/**
 * 走了哪条召回路径。设计稿 §6.5 早已列出这三个值，实现时只写了 `'like'`——
 * 2026-11-01 换成混合检索后补齐。`'fts-unicode61'` 暂未启用（它对中文恒为 0）。
 */
export type RecallPath = 'like' | 'fts-trigram' | 'fts-unicode61'

export interface AssertFactInput {
  actor: ActorKind
  subject: string
  predicate: string
  object: string
  provenance: Provenance
  confirmationBasis: ConfirmationBasis
  /** 默认 `'live'`。基准导入必须显式传 `'benchmark'`。 */
  origin?: Origin
  importance?: number
  validFromMs?: number
  validToMs?: number
  sourceTurnIds?: string[]
  retentionClass?: RetentionClass
}

export interface RecordTurnInput {
  actor: ActorKind
  sessionId: string
  turnIndex: number
  /** 外部 id，如 LoCoMo 的 `dia_id`（`D1:1`）。 */
  externalId?: string
  speaker: string
  text: string
  /** 原始时间串，如 `"1:56 pm on 8 May, 2023"`。解析失败也保留。 */
  occurredRaw?: string
  origin?: Origin
  /** LongMemEval 的 `has_answer`。 */
  isEvidence?: boolean
  /**
   * 幂等键。给了就用 `sha256(dedupeKey)` 作为 turn_id，重复导入同一
   * sample/session/turnIndex 不会写出第二条（设计稿 §6.7）。
   */
  dedupeKey?: string
}

export interface ImportStats {
  sessions: number
  turns: number
  /** 标了证据的 turn 数（LongMemEval 的 `has_answer`）。LOCOMO 无此概念，恒 0。 */
  evidence: number
  /** 时间串解析失败的会话数——**不阻断导入**，但要如实报出来。 */
  unparsedTime: number
}

export interface MemoryQuery {
  text: string
  limit?: number
  nowMs?: number
  /** 默认 `['live']`——基准数据不进验收路径。 */
  includeOrigin?: Origin[]
  /** 第一版恒为 `'prts'`；暴露出来是为了让多 scope 守卫测试能查到它。 */
  scope?: string
  /**
   * fact 的名额上限（v2.9）。**上限不是固定值**：fact 不够时缺口由 turn 补足，
   * fact 为空时全部名额给 turn。默认 `ceil(limit/2)`。
   *
   * 存在的理由：fact 独享 `(0.5+importance)` 乘子而 turn 没有，同一个 RRF 池里
   * fact 会系统性挤掉 turn。抽取上线后若不分名额，分数变化就分不清是「抽取质量」
   * 还是「挤出效应」——归因彻底失效。
   */
  factQuota?: number
}

export interface MemoryHit {
  kind: 'turn' | 'fact' | 'summary'
  id: string
  score: number
  /** 仅 fact 有。 */
  provenance?: Provenance
  origin: Origin
  /** 仅 turn/summary 有。 */
  sessionId?: string
  turnIndex?: number
  externalId?: string
  /**
   * 事件发生时间（仅 turn/summary 有）。**检索结果必须携带它**——
   * 只给正文不给时间，任何「多少天后 / 谁先谁后」的问题都无从推理：
   * 2026-11-01 实测，temporal-reasoning（133/500 题）因缺这一列 4/4 拒答。
   * 解析失败时为 null，此时退回 `occurredRaw`。
   */
  occurredAtMs?: number | null
  /** 原始时间串，`occurredAtMs` 解析失败或精度丢失时的兜底。 */
  occurredRaw?: string
  text: string
  /** 走了哪条召回路径——V1-15 的 abstention 判定要用（设计稿 §6.5）。 */
  recallPath: RecallPath
}

/** 事件种类。第一版只实现 fact.asserted，其余为后续扩展预留。 */
export type MemoryEventKind =
  | 'fact.asserted'
  | 'fact.corrected'
  | 'turn.recorded'
  | 'summary.generated'
  | 'memory.deleted'
  | 'deletion.derivative-done'

export interface MemoryEventRow {
  seq: number
  event_id: string
  kind: MemoryEventKind
  occurred_at_ms: number | null
  occurred_raw: string | null
  recorded_at_ms: number
  actor_kind: ActorKind
  scope: string
  payload_json: string
  prev_hash: string
  hash: string
}
