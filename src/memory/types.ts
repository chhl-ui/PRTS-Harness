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
export type RecallPath = 'like' | 'fts-trigram' | 'fts-unicode61' | 'profile' | 'semantic' | 'spread'

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

export interface ImportStats {  sessions: number
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
  /**
   * 画像（归纳层）的独立名额，默认 0（关闭）。
   *
   * Wave 0 实测：单题生成 37–43 条画像全塞进 fact 池，而 top-8 里 fact 只有 4 个名额，
   * 无关画像（"已婚"、"社区剧院"）靠字面匹配挤掉相关画像。闸门两条：身份独立
   * （`mem_profiles` 独立表 + 独立 FTS）+ 名额独立（本字段）。
   * 默认 0 保证不开画像路时现有基线一字不变。
   */
  profileQuota?: number
  /**
   * 阶段一（v2.12）：先按 session 级索引取多少个会话，默认 10。
   *
   * 依据：turn 级 any@8 = 38.8%，而 session 级 any@3 = 85.6%、all@10 = 80.8%
   * （同一批 500 题、同一朴素方法）。搜索空间从每题中位 491 turn 降到约 10 个
   * session（约 100 turn）。
   *
   * 设为 0 表示关闭两阶段、退回纯 turn 级检索（对照用）。
   */
  sessionLimit?: number
  /**
   * 查询向量（v2.17）。**只有给了才走向量路**。
   *
   * 为什么不在 `search()` 内部算：`search()` 是同步的，而向量化是异步的。
   * 把向量化提到调用方，一举两得——现有全部调用方签名零改动；没有 Ollama 的
   * 环境传不进向量，自动退化为纯 bm25，而不是抛错或静默返回零向量。
   *
   * 依据见 `docs/memory-vector-retrieval-2026-11-02.md`：同一批 120 条画像 × 3 题，
   * bm25 的目标排名 16/未命中/未命中，向量余弦为 4/1/14。
   */
  queryVector?: ArrayLike<number>
  /** 向量路取前多少名进融合，默认 0（关闭）。 */
  semanticTopK?: number
  /** 余弦下限，默认 0（不设阈值，先靠排名融合吸收噪声）。 */
  semanticMinSim?: number
  /**
   * 扩散激活跳数（Wave 4）。默认 0（关闭），只支持 0 或 1。
   *
   * 做法：从直接命中的 turn 里抽实体当种子 → 沿 `mem_links` 取 1 跳邻居 →
   * 邻居经 `mem_mentions` 翻译成候选 turn。**不递归**：2 跳会在 108 万条边上
   * 爆炸，且「朋友的朋友」与查询的相关性没有证据支持。
   *
   * 默认关闭的理由：扩散是唯一「凭空增加候选」的路，放大噪声的风险最高。
   * 计划要求它单独分组、单独报数——`recallPaths` 会记 'spread'，
   * 因此可以只统计这一步的边际效果。
   */
  spreadHops?: 0 | 1
  /** 扩散候选上限，默认 8。 */
  spreadLimit?: number
  /**
   * 边权重下限，默认 2：只共现过一次的配对标为「偶然同句」，扩散它等于放大噪声。
   */
  spreadMinWeight?: number
  /** 用作种子的直接命中条数，默认 5。抽实体是正则，种太多会拖慢每次查询。 */
  spreadSeeds?: number
  /**
   * 摘要（情景大意）的独立名额，默认 0（关闭）。
   *
   * 与 profileQuota 同理：摘要与 turn 在同一个 RRF 池里竞争时，摘要文本短、
   * 字面命中密度高，不分名额会把 turn 挤掉。默认 0 保证不开摘要路时基线一字不变。
   */
  summaryQuota?: number
}

export interface MemoryHit {
  kind: 'turn' | 'fact' | 'summary' | 'profile'
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
  /** 走了哪条召回路径——V1-15 的 abstention 判定要用（设计稿 §6.5）。
   *  **首次命中的路径**，保留给旧调用方；多路召回时看 `recallPaths`。 */
  recallPath: RecallPath
  /**
   * 全部召回来源（v2.17）。一个候选可能同时被 bm25 和向量命中，只留一个标签就永远
   * 说不清「谁立了功」——本项目三次翻车（v2.10 假上界 / v2.12 离线与实现不一致 /
   * v2.16 自写排序）根子都是分不清检索改进还是抽取改进。
   *
   * 顺序为路径首次命中的先后，去重。单路召回时不填（省空间，读方用 `?? [recallPath]`）。
   */
  recallPaths?: RecallPath[]
}

/**
 * 事件种类。
 *
 * `fact.retired` / `fact.restored` 是生命周期（Wave 5）的状态跃迁：退役默认不进检索，
 * 两者都可逆（`retired_at_ms` 置位 / 清空）。**衰减本身不是事件**——它是纯函数，
 * 见 `lifecycle.ts` 的头部说明。
 */
export type MemoryEventKind =
  | 'fact.asserted'
  | 'fact.corrected'
  | 'fact.retired'
  | 'fact.restored'
  | 'fact.reinforced'
  | 'turn.recorded'
  | 'summary.generated'
  | 'memory.deleted'
  | 'deletion.derivative-done'

/**
 * 可持有向量的记忆种类。
 *
 * `turn` 在 2026-11-02 之前是**禁止**的：`putVectors` 的类型只写 `'fact' | 'profile'`，
 * schema 注释也明写「只对派生项建，不对 turn 建」，理由是「turn 的瓶颈在粒度不在语义」。
 * 该判断被 turn 级三路召回实测推翻（bm25 31.8% / 向量 30.5% / 混合 34.7%，见
 * `docs/memory-recall-2026-11-02.md`），所以 turn 纳入。
 *
 * 但默认值仍**不含** turn：它是 24.6 万级，全量向量化约 44 分钟，不能因为「类型允许了」
 * 就让既有调用方在某次例行补齐里突然跑满一小时。要 turn 必须显式传 `kinds: ['turn']`。
 */
export type VectorOwnerKind = 'fact' | 'profile' | 'turn'

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
