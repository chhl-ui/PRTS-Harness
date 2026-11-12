/**
 * 上下文装配 ③ 的 token 预算层：算一个预算，按预算裁出保序前缀。
 *
 * 对应原文（`docs/context-assembly-status.md:17`，抄自架构需求 §5.3 第③条）：
 * 「**预算** = min(配置上限, 模型窗口 − 输出预留 − 安全余量)；未知窗口不按无限处理」。
 *
 * 这里只做这句话的算术，**不引入任何比例项或拍脑袋的常量**：
 * - 比例（如「窗口的 5%」）曾是候选实现的一部分，但它不在原文里，且会让
 *   「窗口 1001、预留 8192」这类配置矛盾时出现断崖（10239 → 511、10240 → 0）。
 *   删掉后预算对窗口单调：窗口刚好等于「预留 + 余量」时为 0，多 1 就多 1。
 * - 交接文档对 ③ 的顾虑是「8000 这类常量两端都不成立」（`HANDOFF-20261103-session-c.md`
 *   未做清单）。因此本文件不预设注入上限；上限由调用方（装配层）通过
 *   `configMaxTokens` 传入，等 `used_chars` 有真实分布再定默认值。
 *
 * 三条取舍：
 * 1. **窗口未知不按无限**：走 `unknownBudgetTokens`（默认 4000）这个保守上限。
 *    宁可少装，不可把窗口撑爆；保守上限是有界的，所以「未知」并没有被当成无限。
 * 2. **非法参数各自回落默认值**（NaN / 负数 / 非有限），绝不因为一个坏参数把预算
 *    变成 0（注入会无声消失）或无限（预算层会无声失效）。`configMaxTokens: 0`
 *    是唯一的「显式归零」——那是博士真的想关掉注入，不是没配。
 * 3. **负的已用按 0**：`Infinity` 同样按 0，不让一个坏值把预算压成 0。
 *
 * 纯函数：不读环境、不写日志、无模块级可变状态。接线（谁调用、成本怎么估）留给
 * 装配器，本文件只做算术。
 */

/**
 * 输出预留默认值：给模型生成回答留的空间。
 *
 * 导出是因为压缩决策（`compaction-policy.ts`）要用同一对数——两处各写一遍迟早对不上，
 * 而它们描述的是同一个物理量：窗口里留给生成的那部分。
 */
export const DEFAULT_OUTPUT_RESERVE = 8_192
/** 安全余量默认值：token 估算会偏差，留一段缓冲避免刚好卡在窗口边缘。 */
export const DEFAULT_SAFETY_MARGIN = 2_048
/** 窗口未知时的保守预算上限：与任何真实模型的窗口相比都小，撑不爆。 */
const DEFAULT_UNKNOWN_BUDGET_TOKENS = 4_000

export interface TokenBudgetInput {
  /** 模型窗口（token）。未知 / 0 / 负数 / NaN / 非有限 → 按「未知」处理，不按无限。 */
  contextWindow?: number | null
  /** 配置层上限。0 是合法语义（关掉注入）；NaN / 负数 / 非有限 → 视为没配。 */
  configMaxTokens?: number | null
  /** 已用（系统提示 + 工具 + 对话），默认 0；负数按 0。 */
  usedTokens?: number
  /** 输出预留，默认 8192；非法回落默认。 */
  outputReserve?: number
  /** 安全余量，默认 2048；非法回落默认。 */
  safetyMargin?: number
  /**
   * 窗口未知时的保守预算上限，默认 4000。
   * 注意它是**预算**不是窗口：不再减输出预留与安全余量（那是窗口才有的开销）。
   * 0 是合法语义（未知时干脆不注入），不是「没配」。
   */
  unknownBudgetTokens?: number
}

/**
 * 有限非负数原样返回，否则回落 `fallback`。
 *
 * 0 会原样通过：调用方写 0 是明确表态（关掉注入 / 不留输出），不是缺省；
 * 负数是没意义的输入，按缺省处理。
 */
function nonNegativeOr(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 算出这一轮装配可用的 token 预算（整数）。
 *
 * 已知窗口：`max(0, floor(min(配置上限 ?? ∞, 窗口 − 输出预留 − 安全余量 − 已用)))`
 * 未知窗口：`max(0, floor(min(配置上限 ?? ∞, unknownBudgetTokens) − 已用))`
 *
 * 窗口小于「输出预留 + 安全余量」时，原话公式自然给出负数 → 0：那说明这个窗口
 * 连系统提示与工具都装不下，注入本就该让路，不是需要特判的异常。
 */
export function resolveTokenBudget(input: TokenBudgetInput): number {
  const outputReserve = nonNegativeOr(input.outputReserve, DEFAULT_OUTPUT_RESERVE)
  const safetyMargin = nonNegativeOr(input.safetyMargin, DEFAULT_SAFETY_MARGIN)
  const unknownBudgetTokens = nonNegativeOr(input.unknownBudgetTokens, DEFAULT_UNKNOWN_BUDGET_TOKENS)
  // 负的已用按 0；NaN / Infinity 同样按 0——原话要求非法参数回落默认值，
  // 而不是让 Infinity 把预算压成 0。
  const usedTokens = nonNegativeOr(input.usedTokens, 0)
  // 非法 configMaxTokens（NaN / 负数 / 非有限）等于「没配」：用 ∞ 表示，
  // 这样后面只剩一次 min，不必为「配了 / 没配」写两条分支。
  const configuredMax = nonNegativeOr(input.configMaxTokens, Number.POSITIVE_INFINITY)

  const rawWindow = input.contextWindow
  const window = typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : null

  if (window === null) {
    return Math.max(0, Math.floor(Math.min(configuredMax, unknownBudgetTokens) - usedTokens))
  }

  const overhead = outputReserve + safetyMargin
  return Math.max(0, Math.floor(Math.min(configuredMax, window - overhead - usedTokens)))
}

export interface FitResult<T> {
  /** 按原顺序保留的前缀。 */
  kept: T[]
  /**
   * 实际占用：`kept` 各条 cost 之和（非法 cost 按 0）。
   *
   * 按原话「累加」保留原始精度，不在此取整——`costOf` 用「字符数 / 1.5」这类换算时
   * 会带浮点残留，取整会把 `usedTokens` 与 `kept` 的实际内容对不上。写进上下文清单
   * 前由调用方 `Math.floor`，那是唯一需要整数的地方。
   */
  usedTokens: number
  /** 因预算不足被整条丢弃的条数（含第一条就超限时的全部）。 */
  dropped: number
}

/**
 * 按预算裁出保序前缀。
 *
 * 规则：
 * 1. 顺序累加 `costOf(item)`，加上后会超过 `budgetTokens` 就停止，返回已保留的前缀。
 * 2. 单条自身就超预算（且它之前什么都没保留）→ 一条都不装。**整条跳过，不截断**：
 *    截断的注入正文会变成半句话，比不注入更坏。
 * 3. `budgetTokens <= 0`（以及 NaN，无法作为上限使用）→ 全丢。
 * 4. `costOf` 返回 NaN / 负数 / 非有限 → 该条按 0 计：一条坏数据不该连带把后面的
 *    材料一起丢掉。
 */
export function fitToBudget<T>(items: readonly T[], budgetTokens: number, costOf: (item: T) => number): FitResult<T> {
  // NaN 用 `!(budget > 0)` 一起挡掉：它与 0 一样不构成可用上限。
  // Infinity 会通过——那是调用方显式说的「不设上限」。
  if (!(budgetTokens > 0)) return { kept: [], usedTokens: 0, dropped: items.length }

  const kept: T[] = []
  let usedTokens = 0
  for (const item of items) {
    const raw = costOf(item)
    const cost = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0
    if (usedTokens + cost > budgetTokens) break
    kept.push(item)
    usedTokens += cost
  }
  return { kept, usedTokens, dropped: items.length - kept.length }
}
