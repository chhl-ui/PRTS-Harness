/**
 * 压缩决策的策略层：把 DSH 的二值判断（压 / 不压）改成**三态**。
 *
 * 为什么需要这一层：DSH 的 `compactIfNeeded` 在 `requestHeader` / `routedTarget` 为空时
 * 静默 `return null`（`dsh-compaction-basic/lib/index.js:932-935`）——既不压缩也不报告。
 * PRTS 的取向相反，`token-budget.ts` 头注释那句「窗口未知不按无限处理」「宁可少装，
 * 不可把窗口撑爆」是本层的前提：**信息不足必须可见**，不能伪装成「不需要压」。
 *
 * 于是三种结论：
 *   compact      确定要压
 *   skip         确定不压，附带理由（`disabled` / `below-threshold`）
 *   undetermined 信息不足以判定，既不能压也不能装作没事，必须上报
 *                （`capacity-unknown` / `no-message-budget` / `config-invalid`）
 *
 * 判定顺序即优先级，每条为什么这样分写在对应分支上。纯函数：不读环境、不写日志、
 * 无模块级可变状态（与 `token-budget.ts` 同一纪律）。
 *
 * ## 与 `token-budget.ts` 的分工（两者方向不同，不是不一致）
 *
 * `token-budget.ts` 面对坏参数时回落**保守默认值**（8192 / 2048），理由写在它的头注释：
 * 那是装配层的算术，预算被坏参数压成 0 会让注入无声消失。它必须给出一个数。
 *
 * 本层不给出数——它是**决策层**，结论只有「压 / 不压 / 不知道」。在这里把一个坏配置
 * 悄悄换成某个数字，等于把「配置坏了」伪装成「算过了」：`skip` 会被读成「还有余量」，
 * 而这正是 DSH 那个静默 `return null` 造成的病。所以非法配置一律 `config-invalid`，
 * 由读配置的那一层去修，本层不替它猜。
 *
 * 三态的分界线：
 * - `capacity-unknown` / `no-message-budget` 管**容量**：窗口与消息预算算不出来；
 * - `config-invalid` 管**输入配置**：比例、预留、余量本身不是可用的数；
 * - `disabled` / `below-threshold` 管**策略**：开关明确关掉，或算出来确实没超线。
 * 三者语义互不借用，调用方从理由就能分辨「该去找模型窗口」「该去修配置」还是「确实不用压」。
 */

/** 确定不压的两种理由：关闭是明确表态，低于阈值是算得出来的结论。 */
export type CompactionSkipReason = 'disabled' | 'below-threshold'

/**
 * 信息不足的三种理由：
 * - `capacity-unknown`：窗口未知或不合法，算不出任何阈值；
 * - `no-message-budget`：窗口被输出预留与安全余量吃光，没有「消息」可用的预算；
 * - `config-invalid`：比例 / 输出预留 / 安全余量不是可用的数。
 *
 * 三者都不允许退化成 `skip`——`skip` 是「我算过，不用压」的断言，而这里恰恰是算不出来
 * 或配置不成立。
 */
export type CompactionUndeterminedReason =
  | 'capacity-unknown'
  | 'no-message-budget'
  | 'config-invalid'

/** 三态结论。`undetermined` 必须由调用方上报，不能当成 `skip` 吞掉。 */
export type CompactionDecision =
  | { action: 'compact' }
  | { action: 'skip'; reason: CompactionSkipReason }
  | { action: 'undetermined'; reason: CompactionUndeterminedReason }

/** 一次压缩判定的输入。窗口之外的四个数是调用方（装配层）的配置，本层不预设默认值。 */
export interface CompactionInput {
  /** 已用 token（系统提示 + 工具 + 对话）。负数 / `-Infinity` 按 0；NaN / 缺失按「未知」。 */
  usedTokens: number
  /** 模型窗口。undefined / null / 0 / 负数 / NaN / 非有限 → 「未知」，不按无限处理。 */
  contextWindow?: number | null
  /**
   * 阈值比例：窗口的多少比例算超限。0 是合法语义（任何占用都算超限），大于 1 等价于 1；
   * 不可用（NaN / 非有限 / 负数 / 缺失）→ `config-invalid`，不拿端点值顶替。
   */
  thresholdRatio: number
  /** 输出预留：给模型生成回答留的空间。非法值 → `config-invalid`。 */
  outputReserve: number
  /** 安全余量：token 估算会偏差，留一段缓冲。非法值 → `config-invalid`。 */
  safetyMargin: number
  /** 压缩开关。只有明确的 `false` 才算「关闭」；undefined / 其它交给后面的判定。 */
  enabled: boolean
}

/**
 * 规整一个「必须是非负数」的配置项：可用的有限非负数原样返回，其余返回 `undefined`
 * （由调用方翻译成 `config-invalid`）。
 *
 * 为什么不回落 0：0 在这里是一个**有语义的值**（「不留预留」「比例为零」），不是缺省。
 * 把一个坏配置换成 0，等于替配置方做了「不留预留」的决定，而预留正是为了防止生成阶段
 * 溢出窗口——放宽这一项会让压缩点推后，与「宁可少装，不可把窗口撑爆」反向。
 *
 * 为什么不回落 `token-budget.ts` 的 8192 / 2048：那两个数是那个文件自己的配置取舍，
 * 搬过来会在两个文件里各说一遍、迟早对不上。本层不持有默认值，只判定配置是否成立。
 */
function usableNonNegative(value: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 已用 token 规整。
 *
 * - NaN / 缺失 → `+Infinity`：已用「未知」时不能宣布「没超线」。与「窗口未知不按无限
 *   处理」是同一枚硬币的两面——窗口未知时保守地上报 `undetermined`；窗口已知而**已用**
 *   未知时保守地按「很可能超限」处理（压缩方向），因为 `skip` 需要一次真实的比较作依据。
 *   这一条不升级成 `config-invalid`：它不是配置，是运行时读数，没有「修配置」可言，
 *   而压缩一次是安全方向。
 * - 负数 / `-Infinity` → 0：真的没有占用。
 * - `+Infinity` > 0，原样通过：它本来就大于任何有限阈值。
 */
function usedTokensOr(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return Number.POSITIVE_INFINITY
  return value > 0 ? value : 0
}

/**
 * 算出这一轮该不该压缩。
 *
 * 规则（顺序即优先级）：
 * 1. `enabled === false` → `skip` / `disabled`。关闭是明确表态，不是信息不足：
 *    哪怕窗口也未知，结论仍然是「不压」，不需要上报 `undetermined`。放在最前，
 *    是因为后面的 `undetermined` 每次都要调用方去找窗口；已关掉的通道不该再要求它。
 * 2. 窗口未知 / 不合法 → `undetermined` / `capacity-unknown`。**为什么未知不能退化成
 *    skip**：`skip` 意味着「我算过，未超阈值」，而窗口未知时连阈值都算不出来；此时若报
 *    skip，调用方会以为上下文还有余量，继续把材料装进一个可能只有几千 token 的窗口，
 *    结果是请求被截断或报错——比多压一次坏得多。
 * 3. 比例 / 输出预留 / 安全余量不可用 → `undetermined` / `config-invalid`。它们不是
 *    「缺失时取个默认值是常识」，而是**配置方必须给对**的三个数：比例决定多早压，
 *    预留与余量决定留多少空间给生成。任一被悄悄替换，压缩点就会漂移，而漂移方向通常
 *    是「更晚压」，等于在防溢出的路上撤退。语义上也必须与 `capacity-unknown` 分开：
 *    窗口拿不到要去查模型能力，配置坏了要去改配置，调用方的动作不同。
 * 4. 消息预算 = `窗口 − 输出预留 − 安全余量 <= 0` → `undetermined` / `no-message-budget`。
 *    这不是「不需要压」而是「窗口连输出都装不下」，是配置/模型选型层面的矛盾，
 *    必须让调用方看见，不能静默按 0 预算继续跑。
 * 5. 阈值 = `min(窗口 × 比例, 消息预算)`：第二个 min 项是硬上限——消息再多也不能把
 *    预算本身当成「还有余量」，否则压缩永远追不上溢出。
 * 6. `已用 >= 阈值` → `compact`（等于即压：与「超限时压缩」同向）；否则
 *    `skip` / `below-threshold`。
 *
 * 阈值不做取整：与 `fitToBudget` 保留 `usedTokens` 原始精度同理，取整会引入一处
 * 与调用方对不上的边界（例如阈值 400.4 被 floor 成 400 后，401 的占用被判成超限）。
 */
export function decideCompaction(input: CompactionInput): CompactionDecision {
  // ① 关闭优先于一切：这是唯一一条不需要任何算术就能下的结论。
  if (input.enabled === false) return { action: 'skip', reason: 'disabled' }

  // ② 窗口：必须是有限正数，否则「未知」。0 / 负数 / NaN / ±Infinity 都不是能用来算阈值的窗口。
  const rawWindow = input.contextWindow
  const window = typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : null
  if (window === null) return { action: 'undetermined', reason: 'capacity-unknown' }

  // ③ 三项配置：比例、输出预留、安全余量。任一不可用即配置不成立，不替它猜。
  const ratio = usableNonNegative(input.thresholdRatio)
  const outputReserve = usableNonNegative(input.outputReserve)
  const safetyMargin = usableNonNegative(input.safetyMargin)
  if (ratio === undefined || outputReserve === undefined || safetyMargin === undefined) {
    return { action: 'undetermined', reason: 'config-invalid' }
  }

  // ④ 消息预算：窗口扣掉输出预留与安全余量后，还剩多少能装消息。
  const messageBudget = window - outputReserve - safetyMargin
  // `!(x > 0)` 而不是 `x <= 0`：NaN 不能作为可用预算，一并挡在这里。
  if (!(messageBudget > 0)) return { action: 'undetermined', reason: 'no-message-budget' }

  // ⑤ 阈值：窗口比例，再被消息预算封顶。比例大于 1 时不必单独夹——`window * ratio`
  //    必然大于 `window`，而消息预算不超过窗口，min 的第二项自然接管。
  const threshold = Math.min(window * ratio, messageBudget)

  // ⑥ 严格可比：等于阈值算超限。
  if (usedTokensOr(input.usedTokens) >= threshold) return { action: 'compact' }
  return { action: 'skip', reason: 'below-threshold' }
}
