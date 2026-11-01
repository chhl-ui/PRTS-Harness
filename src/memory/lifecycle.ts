/**
 * 记忆模块：生命周期（Wave 5）。
 *
 * 三档遗忘对照 `docs/memory-landscape.md` 第 46 行的结论：**降权 / 退役（默认不检索）
 * / 清除正文**，前两档可逆。删除已由 `memory.deleted` 覆盖（不可逆，正文清空），
 * 本文件补前两档：重要性衰减（降权）与退役（`retired_at_ms`）。
 *
 * ## 为什么衰减不写回 `mem_facts.importance`
 *
 * 计划原文是「重要性衰减写回」。落码时改成**查询期折算**，理由是本仓的硬不变量：
 * 投影必须是事件序列的纯函数（设计稿 §八 不变量 1/2，`rebuildProjections` 会
 * 删表重放）。写回有两条路，都不成立：
 *
 * 1. 直接 UPDATE 投影 → 重建后丢失，投影与事件链不一致，守卫测试会红。
 * 2. 每次衰减追加一条事件 → 每个 fact 每个衰减周期一条，事件链随时钟线性膨胀；
 *    而衰减是连续量，不是状态跃迁，链上记它等于把「作业跑了几次」烤进不可逆点。
 *
 * 因此：`importance` 列保持**写入时的强度**，检索时用 `decayedImportance()` 折算成
 * 有效强度。衰减是纯函数（初始强度 + 写入时间 + 当前时间），任何时刻算出的值都一样，
 * 不需要迁移、不需要事件、重建后自动一致。
 *
 * **只有状态跃迁（退役 / 恢复）落事件**——这是事件溯源里的常规切分，也是
 * `retireFacts()` / `restoreFacts()` 存在的理由。
 */

const DAY_MS = 86_400_000

/**
 * 重要性半衰期。
 *
 * 与 `store.ts` 的 `recency()`（半衰期 30 天）不是一回事，不能合并：
 * - `recency` 回答「这条内容最近还被提到吗」——话题热度，衰减快。
 * - `importance` 回答「这条事实本身有多重」——身份性/偏好性事实即使一年没复述，
 *   仍然成立。180 天意味着两年后剩约 6%，三年后剩约 3%。
 */
export const IMPORTANCE_HALF_LIFE_DAYS = 180

/**
 * 退役阈值：衰减后的 importance 低于它即视为「已淡忘」。
 *
 * 默认 importance = 0.5，落到 0.05 需要 log2(10) ≈ 3.32 个半衰期 ≈ 598 天。
 * 这个数量级是刻意的：退役是**不可见于默认检索**，误杀的代价高于晚杀。
 */
export const RETIRE_IMPORTANCE_FLOOR = 0.05

/**
 * 最短保留期：写入不足这么多天的事实永不退役。
 *
 * 存在的理由：`importance` 允许调用方显式传小值（例如模型推断的低置信事实
 * 传 0.01），若只看阈值，刚写入的条目会立刻可被退役——那不是「淡忘」，
 * 是「从未记住」。年龄门槛与阈值是两个独立条件，缺一都会误杀。
 */
export const RETIRE_MIN_AGE_DAYS = 90

/** 衰减后的有效重要性。`importance` 非法（NULL / NaN）时按 0 处理，不当作「很重要」。 */
export function decayedImportance(
  importance: number,
  recordedAtMs: number,
  nowMs: number,
  halfLifeDays: number = IMPORTANCE_HALF_LIFE_DAYS,
): number {
  if (!Number.isFinite(importance)) return 0
  const halfLife = Number.isFinite(halfLifeDays) && halfLifeDays > 0
    ? halfLifeDays
    : IMPORTANCE_HALF_LIFE_DAYS
  const ageDays = Math.max(0, (nowMs - recordedAtMs) / DAY_MS)
  return importance * Math.pow(2, -ageDays / halfLife)
}

export interface RetireCandidate {
  factId: string
  importance: number
  recordedAtMs: number
  /** 折算后的有效重要性，判定依据。 */
  effective: number
  ageDays: number
}

/**
 * 一条事实是否该退役。
 *
 * `permanent` 永不退役——那是身份性事实（姓名、角色设定），淡忘它等于人格漂移。
 * `clearable` 与 `retirable` 都可退役：两档的差别在**清除**阶段（可不可硬删），
 * 不在退役阶段。这是 `retention_class` 三档语义的本意，与 `docs/memory-landscape.md`
 * 第 46 行的两档划分对齐。
 */
export function shouldRetire(
  input: { factId: string; importance: number; recordedAtMs: number; retentionClass: string },
  nowMs: number,
  opts: { floor?: number; minAgeDays?: number; halfLifeDays?: number } = {},
): RetireCandidate | null {
  if (input.retentionClass === 'permanent') return null
  const floor = opts.floor ?? RETIRE_IMPORTANCE_FLOOR
  const minAgeDays = opts.minAgeDays ?? RETIRE_MIN_AGE_DAYS
  const ageDays = Math.max(0, (nowMs - input.recordedAtMs) / DAY_MS)
  if (ageDays < minAgeDays) return null
  const effective = decayedImportance(input.importance, input.recordedAtMs, nowMs, opts.halfLifeDays)
  if (effective >= floor) return null
  return { factId: input.factId, importance: input.importance, recordedAtMs: input.recordedAtMs, effective, ageDays }
}
