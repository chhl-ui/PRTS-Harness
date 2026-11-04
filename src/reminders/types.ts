/**
 * W3 任务提醒：留痕库的数据契约。
 *
 * 原文（`docs/design-superagent-fusion.md` §三 ③）：「任务 `blocked` 超过 N 小时、
 * 或 `claimDone` 后无人验收超过 N 小时，主动提醒一次。」
 *
 * ## 为什么留痕必须落库，而不是进程内一个 Set
 *
 * 「提醒一次」的语义**跨进程**成立。进程内集合重启即忘，博士每重启一次 PRTS
 * 就会把同一批停滞任务重新提醒一遍——提醒变噪音，最后被无视，等于没做。
 * 所以「已提醒」这个事实必须和任务账本一样活过进程。
 *
 * ## 为什么是独立库而不是塞进 `src/ledger` 或 `src/memory`
 *
 * 提醒是**行为日志**（我提醒过什么），不是**事实来源**（任务处于什么状态）。
 * 它不进任何哈希链，也不该受 `fold.ts` 投影规则约束——塞进账本会让
 * 「提醒记账失败」牵连任务状态写入，而提醒本身只是增强，不是闸门
 * （同 `src/proactive/types.ts` 的判断）。
 *
 * ## 为什么只追加
 *
 * 同一个 `taskId + kind` 被记录两次（比如任务回到 blocked 又停了一次）是
 * **两段独立的停滞历史**，不是重复行。覆盖写会把「停过两次」压成一条，
 * 事后无法判断提醒频率是否失控。
 */

/** 一条提醒留痕：某个任务在某个阶段被提醒过一次。 */
export interface ReminderRow {
  /** 自增主键，同时是「第几次提醒」的先后序（只追加，不复用）。 */
  id: number
  /** 被提醒的任务 id（`TaskSnapshot.id`）。 */
  taskId: string
  /**
   * 提醒时任务所处阶段。目前只有 `blocked`（等外部输入）与 `verifying`（等验收）。
   * 用 `TaskPhase` 的字符串而非枚举：万一账本以后加了新停滞阶段，
   * 留痕列不该因为一个窄类型而拒收。
   */
  kind: string
  /** 提醒时刻（Unix ms）。 */
  notifiedAtMs: number
  /**
   * 提醒投递到的会话（多会话下用于区分「念给谁听」）。
   * 旧行没有这个字段（2026-11-04 之前），读取侧按 `undefined` 处理。
   */
  sessionId?: string
}

/** 写一条留痕的入参。`id` 由库生成，调用方不给。 */
export interface ReminderRecordInput {
  taskId: string
  kind: string
  notifiedAtMs: number
  /** 投递到的会话；省略 = 未知（旧行为）。 */
  sessionId?: string
}

/** 读留痕的过滤条件。 */
export interface ReminderListQuery {
  /** 最多几条。给了就取**最近的** N 条（仍按 id 升序返回）；0 = 空数组。 */
  limit?: number
}

/**
 * 任务提醒留痕库。
 *
 * 纯同步接口：`node:sqlite` 是同步 API，调用点在 `agent/pre-step` 的注入段里
 * （追加消息之前），异步化只会把「记一条日志」变成可重入的竞态面。
 */
export interface ReminderStore {
  /**
   * 这个任务的这个阶段是否已经提醒过。
   * 「提醒一次」的判定点就是它——所以它必须查库，不能查进程内缓存。
   */
  wasNotified(taskId: string, kind: string): boolean
  /**
   * 该任务该阶段最近一次提醒的时刻；从未提醒过返回 `undefined`。
   *
   * 与 `wasNotified` 的区别是「是否针对**这一次**停滞」：任务 unblock 后再次 blocked，
   * `updatedAt` 会前进，旧留痕不该再把新停滞压住——调用方用
   * `lastNotifiedAt >= task.updatedAt` 判断「本轮停滞已提醒过」。
   */
  lastNotifiedAt(taskId: string, kind: string): number | undefined
  /** 只追加一条留痕。只追加：同一任务同一阶段记两次就是两行。 */
  record(input: ReminderRecordInput): void
  /** 按 id 升序读留痕（写入先后）。 */
  list(opts?: ReminderListQuery): ReminderRow[]
  /** 关闭库句柄。可重复调用。 */
  close(): void
}
