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
export type RecallPath = 'like' | 'fts-trigram' | 'fts-unicode61' | 'profile' | 'semantic' | 'spread' | 'correction'

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
  /**
   * 事实主题的稳定规范名（如「咖啡」「实验室」），同槽取代的匹配键。
   *
   * 不用 `subject|predicate` 当槽位：真机抽取证实谓词匹配双向失败——
   * 泛谓词（偏好/使用/拥有）把不同主题事实连在一起，新值一到全部误退役；
   * 措辞漂移（拥有→住在）又使同主题旧值漏退役。slot 由抽取模型产出语义主题名。
   * 空串/缺省视为「无槽」，永不参与取代匹配。
   */
  slot?: string
  /**
   * 同槽取代开关（默认 false）。为 true 且本事实带非空 `slot` 时，写入后把
   * 同 `subject|slot` 的在役旧事实退役并记 `superseded_by` 指向本行。
   *
   * 为什么默认关：同槽不同取值可能是**并存**而非取代（两台相机、两个项目），
   * 字符串层分不出来——fold.ts `fact.asserted` 的注释早已写明「不能自动推断」。
   * 调用方只能在有**显式更正证据**时开它：当前唯一的开启方是 `consolidateFacts`
   * 检测到来源 turn 带更正标记（`correction.ts`）时。
   *
   * 保留的安全闸：model-inferred 的新事实**不许**取代 owner-stated / verifier
   * 的旧事实——模型抽错一句话就把主人明说的事实顶掉，是不可接受的失败形态。
   * 无 slot 时**不退回谓词匹配**：那正是拿铁误杀 polars 的事故形态。
   */
  supersedeSameSlot?: boolean
  /**
   * 派生来源任务 id（DESIGN-08 记忆↔学习）。经验事实由任务验收结局派生时带上，
   * 进 fact.asserted **载荷**——fold 不读它（投影无 taskId 列），故重建不变。
   * 跨模块契约 §4：任务↔记忆的关联由记忆侧建立（derived_from = taskId）。
   */
  derivedFromTaskId?: string
  /** 派生来源的账本结局事件 seq（DESIGN-08）。同 derivedFromTaskId，载荷-only、重建不变。 */
  outcomeSeq?: number
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
  /**
   * 发生时刻（Unix ms）。传入时 `occurred_raw` 缺省落 ISO 串；
   * 与 `occurredRaw` 同传时以本值为准、raw 原样保留。非有限数直接 throw。
   */
  occurredAtMs?: number
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

/**
 * 一条「近期情景」切片（`MemoryStore.recentTurns`，⑦ 跨会话连续 S4）。
 *
 * 与 `MemoryHit` 的区别：那个是**相关性**检索结果（带 score / recallPath），
 * 这个是**纯时间**切片——「上次聊到哪里」问的是先后，不是相关度；没有查询词时
 * 把最近对话塞给 BM25，只会得到按字面重叠排序的结果。
 *
 * `occurredAtMs` 为 null 表示原始时间串缺失或解析失败：这类行排序时排最后，
 * 但仍会被返回——时间说不准的旧内容，比没有内容有用。
 */
export interface RecentTurn {
  turnId: string
  sessionId: string
  turnIndex: number
  speaker: string
  text: string
  occurredAtMs: number | null
}

export interface MemoryQuery {
  text: string
  limit?: number
  nowMs?: number
  /** 默认 `['live']`——基准数据不进验收路径。 */
  includeOrigin?: Origin[]
  /** 所有者视图：退役行也参与检索（找回「淡忘的东西」用）。默认 false。 */
  includeRetired?: boolean
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
   * 向量路在 RRF 融合里的权重，默认 0.5。依据 memory-roadmap 实测：
   * 等权（1.0）融合在 temporal 题上比单 bm25 掉 11.8pp，1:0.5 是
   * 数据支持的起始配比；调回 1.0 需谨慎，先过 temporal 回归。
   */
  semanticWeight?: number
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
 *
 * `injection.recorded` 是**纯观测**：记录本轮注入装配了什么（条数、命中 id、用量），
 * 不产生任何投影行（`fold.ts` 里是显式 no-op）。它进这条链的理由是语义——它描述的确实
 * 是记忆域的一次动作（库被读了哪些条目），而不是上下文装配的全部（system prompt 与
 * 工具 schema 不在此列，见 `docs/context-assembly-status.md` 三-S1/S2）。
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
  | 'intent.created'
  | 'intent.fired'
  | 'intent.cancelled'
  | 'injection.recorded'

/**
 * 记忆注入清单：一轮里实际装进上下文的是什么。
 *
 * 判据口径（别改，改了历史数据就不可比）：
 * - `usedChars` 是 `renderInjection` 产出的**完整正文长度，含自报来源的 header**——
 *   将来要拿它标定预算，预算必须与同一口径比较。
 * - `hitIds` 只含**真正进正文**的命中；被过滤或被丢弃的不得混入（否则事后解释会指错）。
 * - 不含正文：这条记录落在哈希链上，写进去就删不掉。
 */
export interface InjectionRecord {
  sessionId: string
  turn: number
  step: number
  injected: number
  hitIds: string[]
  /** 命中种类分布（`turn` / `fact` / `summary` / `profile`）。 */
  kinds: Record<string, number>
  usedChars: number
  /** 本轮生效的条数上限（`PRTS_MEMORY_INJECT_LIMIT`），事后解释「为什么只有这几条」要看它。 */
  limit: number
  /**
   * 这一轮装配的结果。`skipped` 是「真的要装配但没装成」，
   * 由 `reason` 说明是哪一种（`query-too-short` / `no-hit`）。
   *
   * 历史事件没有这个字段（2026-11-04 之前的注入记录），读取侧按 `'injected'` 处理——
   * 那时候只记成功路径，所以缺失等价于注入成功。不做数据迁移。
   */
  outcome: 'injected' | 'skipped'
  reason?: string
  /**
   * 装配来源：`memory` / `skill` / `intent` / `emotion` / `session-recall` /
   * `task-reminder` / `proactive`，或装配器自己的总账 `assembly`。
   * 历史事件没有这个字段，读取侧按 `undefined` 处理（不代表任何链）。
   */
  chain?: string
  /** 仅装配器总账使用：这一轮实际装入的链标识（去重）。 */
  chains?: readonly string[]
  /** 仅装配器总账使用：因超预算被整链裁掉的链标识。 */
  droppedChains?: readonly string[]
  recordedAtMs: number
}

/**
 * 写一次注入清单的入参。`hitIds` 收 readonly：调用方传的是命中投影的 id 快照，
 * 这里只读不改，没必要逼调用方先复制一份。
 */
export interface RecordInjectionInput {
  sessionId: string
  turn: number
  step: number
  injected: number
  hitIds: readonly string[]
  kinds: Record<string, number>
  usedChars: number
  limit: number
  /** `injected` = 真的装进了上下文；`skipped` = 该装但没装成，配 `reason`。 */
  outcome: 'injected' | 'skipped'
  reason?: string
  /** 装配来源链；装配器总账写 `'assembly'`。 */
  chain?: string
  /** 仅装配器总账：这一轮实际装入的链标识。 */
  chains?: readonly string[]
  /** 仅装配器总账：因超预算被整链裁掉的链标识。 */
  droppedChains?: readonly string[]
  /**
   * 仅压缩决策（`chain: 'compaction'`）：本会话已用 token。
   *
   * 为什么借用本清单而不另开一张表：§5.3 第⑧条要的是「事后解释她当时为什么这么说」，
   * 压缩和注入一样是装配决策——两者放同一条时间线上才解释得通。`fold.ts` 对它
   * 是显式 no-op（纯观测、无投影行），所以加字段不影响任何重建结果。
   */
  usedTokens?: number
  /** 仅压缩决策：模型真实窗口（adapter 提供，不是 `DSH_CONTEXT_WINDOW`）。 */
  contextWindow?: number
}

/** V1-14 前瞻记忆：意图状态。`fired` 与 `cancelled` 是终态，不可互转。 */
export type IntentStatus = 'pending' | 'fired' | 'cancelled'

/** `mem_intents` 投影的一行。`fireAtMs` 是计划时刻，`firedAtMs` 是实际时刻。 */
export interface IntentRow {
  intentId: string
  /** 用户原话片段，原样保留——模型时间解析错时，回显它才能让用户看出来。 */
  conditionRaw: string
  action: string
  fireAtMs: number
  status: IntentStatus
  createdAtMs: number
  firedAtMs: number | null
  cancelledAtMs: number | null
  sourceTurnId: string | null
  /**
   * 投递留痕：这条提醒念给了哪个会话。`null` 表示没有会话可归（旧数据，
   * 或手工 `runOnce` 手动触发）。投递失败时整行仍是 `pending`，此列也为 `null`。
   */
  sessionId: string | null
}

export interface CreateIntentInput {
  actor: ActorKind
  conditionRaw: string
  fireAtMs: number
  action: string
  sourceTurnId?: string
}

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

/** `planForget` 的只读计划：`turns/facts/profiles/summaries` 为 id 列表，其余为计数。不含正文。 */
export interface ForgetPlan {
  turns: string[]
  facts: string[]
  profiles: string[]
  summaries: string[]
  vectors: number
  mentions: number
  orphanEntities: number
  sessionsToRebuild: string[]
  notFound: string[]
  /** 级联得到的 fact/profile/summary id → 触发它的顶层 id（链式级联时也指向最顶层）。 */
  causeOf: Record<string, string>
}
export interface ForgetResult {
  ok: boolean
  reason?: string
  /** 事务内实际执行的计划（可与预览不同——间隔内的写入会被重新级联进来）。 */
  plan?: ForgetPlan
}

/**
 * 阅读阶段（reading.ts，roadmap P1）的事实元数据。
 *
 * 不挂在 `MemoryHit` 上：`search()` 的投影面已经横跨四张表，而
 * subject/slot/sourceTurnIds 只有注入与召回这两个「组织上下文」的消费方才用——
 * 由 `store.factMeta()` 按需二阶补查，检索主路径不背这份成本。
 */
export interface FactMeta {
  subject: string
  predicate: string
  /** 已规范化（写入时过过 normalizeSlotKey）；null = 无槽，不参与主题卡聚合。 */
  slot: string | null
  validFromMs: number | null
  recordedAtMs: number | null
  /** 产出本事实的来源 turn——更正 turn 与由它抽出的新事实天然同卡。 */
  sourceTurnIds: string[]
}

/** turn 上的实体提及（`mem_mentions` × `mem_entities` 联查）。 */
export interface TurnEntityMention {
  /** `normalizeKey` 规范化后的实体键，与 slot 的规范化口径兼容。 */
  key: string
  /** 展示用原始写法（保留大小写）。 */
  name: string
  /** 全库提及数。枢纽实体（"Python" 之类）会把无关命中连成大卡，消费方据此跳过。 */
  mentionCount: number
}
