/**
 * V1-09 进化（技能与经验）：对外类型。
 *
 * 这一格在 `docs/memory-landscape.md:129` 已对账过：Letta / Generative Agents /
 * Graphiti / hindsight / mempalace 都没有「候选与启用分开、经评估采用」的形态，
 * 结论是**自建**。设计要点抄自那一行的原文——「做事方法、教训、反例与失效条件」，
 * 所以四个正文字段不是随便取的：`steps` 是方法，`pitfalls` 是反例，
 * `trigger` 是「什么时候该想起它」（没有触发条件的经验等于没记）。
 */

export type SkillId = string & { readonly __brand: 'SkillId' }

/**
 * 相位。与账本的 diff 是：这里多一个 `rejected`——提案被否掉要留痕，
 * 否则同一个坏经验会被反复提出。
 */
export type SkillPhase = 'candidate' | 'active' | 'retired' | 'rejected'

/**
 * 谁能做哪件事：2026-11-09 两次放开后，全生命周期对 owner 与 model 开放
 * （依据与前提见 `store.ts` 头注释）。放开的前提是技能不授予权限——它只是
 * 注入上下文的建议文本，真正拦得住模型的是 K2a 守卫。一旦技能携带工具、
 * 数据源或授权路径，`requireWriter` 必须改回 owner-only：到那时
 * 「越用越熟练」才真成了「模型自己给自己加能力」。
 */
export type SkillActor = { kind: 'owner' } | { kind: 'model'; sessionId: string }

/** 评估结论。`needs-work` 与 `reject` 的区别：前者还可以改，后者是这条路不通。 */
export type SkillVerdict = 'adopt' | 'reject' | 'needs-work'

export interface SkillProposal {
  /** 一句话说清这条经验是什么。 */
  title: string
  /** 什么时候该想起它。空触发条件的经验永远不会被用上。 */
  trigger: string
  /** 做法，有序。 */
  steps: string[]
  /** 反例 / 失效条件。可选但强烈建议——它是「别再用」的那一半。 */
  pitfalls?: string[]
  /** 来源：任务 id、turn id、commit sha 或自由文本，方便事后追溯。 */
  sourceRefs?: string[]
}

export interface SkillEvaluation {
  verdict: SkillVerdict
  /** 评估依据。**不允许为空**——没有理由的采用不可追溯。 */
  basis: string
  by: SkillActor
  atMs: number
}

export interface SkillSnapshot extends SkillProposal {
  id: SkillId
  /** 乐观并发：每次成功变更 +1，调用方须带对的 revision。 */
  revision: number
  phase: SkillPhase
  proposedBy: SkillActor
  createdAt: number
  updatedAt: number
  evaluations: SkillEvaluation[]
  retireReason?: string
}

export type SkillEventKind =
  | 'skill.proposed'
  | 'skill.evaluated'
  | 'skill.adopted'
  | 'skill.rejected'
  | 'skill.retired'
  | 'skill.restored'
  /**
   * 使用信号：这条 active 技能被注入到某次上下文里（`skill-inject`）。
   *
   * 不是状态变更——`fold.ts` 里是 no-op，相位与 revision 都不动。存在的理由是
   * 「采用之后有没有被用起来」此前完全不可观测，而观测它不需要新增表。
   * DESIGN-04 起载荷携带 `{sessionId, taskId?}`：taskId 是效果归因的连接键，
   * 提供时从账本 `taskForSession` 读来；旧事件没有这两个字段，读通道从 actor 兜底。
   */
  | 'skill.offered'

/** 事件行。`payload` 是每种事件自己的载荷，由 `fold.ts` 解释。 */
export interface SkillEventRow {
  seq: number
  skill_id: string
  revision: number
  kind: string
  actor: SkillActor
  payload: unknown
  ts: number
  prev_hash: string
  hash: string
}

export interface SkillRef {
  id: SkillId
  revision: number
}

/**
 * 提供记录的读通道形态（`SkillStore.offers`，DESIGN-04）。
 *
 * `taskId` 缺席有两种合法情形：提供时该会话没绑任务；事件是 DESIGN-04 之前
 * 记的旧格式。两者都计入提供次数，但都不参与归因——没有连接键就不主张关联。
 */
export interface OfferRecord {
  skillId: SkillId
  sessionId?: string
  taskId?: string
  ts: number
}
