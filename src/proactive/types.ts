/**
 * V1-07 主动回忆：数据契约。
 *
 * 架构需求 §7 V1-07：「7 天试用中出现自然提起过去的情况，博士认为恰当的占比
 * 至少 70%；**可以关闭**」。
 *
 * 70% 是人工评价指标，机器只能钉住它的**前提**：每次主动提起都如实留痕。
 * 没有这份留痕，事后无法抽样评价「恰当」，V1-07 就成了不可验收的愿望。
 * 所以这里的表结构只服务两件事——**留痕**与**冷却**，不承载任何推荐逻辑。
 *
 * 为什么不复用 `src/memory` 的事件链：主动回忆是**行为日志**（我做了什么），
 * 不是**事实来源**（世界是什么）。它不进 `memory_events` 哈希链，也就不受
 * 「投影只能由 fold 更新」的约束；独立库、单表、只追加，代价与失败面都最小。
 * 两者唯一的耦合是 `memoryId` 指向命中的事实 id。
 */

/** 允许被主动提起的记忆种类。`turn` 是原始对话，不是「可以自然提起的旧事」，永不入列。 */
export type ProactiveKind = 'fact'

/** 一条留痕：某一轮，我在某个会话里提起了哪条记忆。 */
export interface ProactiveMention {
  /** 自增主键，同时是「第几次提起」的先后序（只追加，不复用）。 */
  id: number
  sessionId: string
  /** 提起时处于该会话的第几轮；间隔控制（minTurnsBetween）用它算距离。 */
  turn: number
  /** 被提起的记忆 id（`MemoryHit.id`）。 */
  memoryId: string
  kind: ProactiveKind | string
  /** 当时的检索得分，留作事后分析「提得对不对」。 */
  score: number
  /** 提起时刻（Unix ms）。冷却窗口从这一列算。 */
  mentionedAtMs: number
}

/** 写一条留痕的入参。id 由库生成，调用方不给。 */
export interface ProactiveRecordInput {
  sessionId: string
  turn: number
  memoryId: string
  kind: ProactiveKind | string
  score: number
  mentionedAtMs: number
}

/** 读留痕的过滤条件。两者都不给时返回全部（按写入顺序）。 */
export interface ProactiveListQuery {
  /** 只看某个会话。空串/缺省 = 不限。 */
  sessionId?: string
  /** 最多几条。给了就取**最近的** N 条（仍按时间正序返回）；0 = 空数组。 */
  limit?: number
}

/**
 * 主动回忆留痕库。
 *
 * 纯同步接口：`node:sqlite` 是同步 API，且调用点在 pre-step 的同步段里
 * （追加消息之前），异步化只会把「记一条日志」变成可重入的竞态面。
 */
export interface ProactiveStore {
  /** 只追加一条留痕，返回新行 id。只追加：同一条记忆被提起两次就是两行。 */
  record(input: ProactiveRecordInput): number
  /** 按写入顺序读留痕。 */
  list(query?: ProactiveListQuery): ProactiveMention[]
  /** 某会话已提起过几次（每会话上限用它）。未知会话返回 0。 */
  countBySession(sessionId: string): number
  /**
   * 这条记忆是否仍在冷却期。
   * `nowMs` 缺省取 `Date.now()`；`windowMs` 缺省 7 天，给 0 表示不设冷却。
   */
  isCoolingDown(memoryId: string, nowMs?: number, windowMs?: number): boolean
  /** 关闭库句柄。可重复调用。 */
  close(): void
}
