/**
 * §G2 ① 时钟（自主唤醒）—— 调度器。
 *
 * ## 它解决的问题
 *
 * 在此之前所有「到期检查」都挂在 `agent/pre-step`（`intent-trigger.ts:163`、
 * `task-reminder.ts:204`、`proactive-recall.ts:213`）：必须有人先开口，提醒才有
 * 机会被检查。V1-14 的「准点提醒」因此名不副实——实际是「下次开口时补发」。
 * 时钟把「时间」变成一个独立的触发源。
 *
 * ## 为什么是这个形状（方案 B：离屏自主）
 *
 * 计划已批准走 B：时钟不依赖任何活跃会话，自己起一个离屏会话把话说出来。
 * 因此组件的依赖里**没有** `activeAgent`，只有一个 `deliver` 回调——
 * 「怎么起会话」是装配层的事，调度器只管「什么时候该说」。
 *
 * 这条边界是刻意的：把 `agents.create/followup/whenIdle/dispose` 放进本文件，
 * 单测就必须起真实 runtime 才能验「节流对不对」，那是另一层的事。
 *
 * ## 为什么一次只投递一条
 *
 * 5 条到期拼成一堵墙，读的人得先在墙里找最要紧的那条；而一条消息里塞多条
 * 理由，模型也很难只回一句话。多条到期留给下一次 tick 消化（minGap 会拉开）。
 *
 * ## 失败为什么不放大
 *
 * 投递失败（模型不可用、agents 服务缺、会话创建撞名）一律只计数 + 打日志：
 * 时钟是后台事，绝不能把异常冒泡到任何对话链路。连续失败到 `maxFailures` 就
 * 自停并留一次痕，**不自动恢复**——自动恢复等于把「一直失败」变成「一直重试」，
 * 那比停着更糟（费用与日志都会滚雪球）。
 */
/** 一条「该说点什么」的原因。 */
export interface WakeReason {
  /**
   * `intent` / `stale-task` 看时间（到期、停滞）；`fact` 看重要性（惦记着、久未提起）。
   * 后者是唯一一条**不看时间截止**的理由——它让同一个定时器不再只说"到点了"。
   */
  kind: 'intent' | 'stale-task' | 'fact'
  /** 要说出去的正文（不含指令前缀，前缀由装配层统一加）。 */
  text: string
  /** 源对象 id（intent id / task id），供留痕与去重。 */
  refId: string
}

export interface WakeClockDeps {
  /**
   * 取当前到期的原因。**同步**：它只读 SQLite，异步化会让调度器引入
   * 第二个并发面（tick 重入）。抛错视为一次失败，不当成「没有到期」。
   */
  collectDue(nowMs: number): WakeReason[]
  /**
   * 把一条原因说出去：起离屏会话 → followup → 等收敛 → dispose。
   * **返回即代表回合已结束**（或已确定无法结束），返回值是本次离屏会话的 id
   * （没有会话时返回 undefined）——审计要靠它把人指到具体那次回合。
   * 抛错视为投递失败。
   */
  deliver(reason: WakeReason, nowMs: number): Promise<string | void>
  /** 投递成功后的留痕（标记已提醒 / 写 K4 审计）。抛错不影响投递结论。 */
  onFired(reason: WakeReason, nowMs: number, sessionId?: string): void
  /** 每次失败（含 collectDue 抛错）。`consecutive` 是已连续失败次数。 */
  onFailure?(error: unknown, consecutive: number): void
  /** 连续失败到阈值而自停时调用一次。 */
  onStopped?(why: string, consecutive: number): void
  /**
   * 每次 tick 的系统侧检查（§G2 ④ 情感事件源挂这里）。在守卫之后、
   * **说话闸门（minGap/dailyCap）之前**调用——情绪不是说话，不该被说话的
   * 节流挡住。抛错只 log，不计投递失败、不触自停：检查是增强不是闸门。
   * closed / inTick / 自停时不跑（守卫提前 return）。
   */
  onTick?(nowMs: number): void
  log?(msg: string): void
  now?(): number
  /** 轮询间隔，默认 60 秒。 */
  intervalMs?: number
  /** 两次主动开口之间的最小间隔，默认 30 分钟。 */
  minGapMs?: number
  /** 每个自然日最多主动开口几次，默认 8。 */
  dailyCap?: number
  /** 连续失败到这个次数就自停，默认 3。 */
  maxFailures?: number
  /**
   * 博士最后一次真实发言的时刻（`MemoryStore.lastOwnerTurnAtMs` 同一口径：
   * 已排除 `prts-clock-*` / `subtask-*` 合成会话）。`undefined` = 从没说过话。
   * 不提供则应答闸门不工作（无法判断有没有被接住，就不该猜）。
   */
  lastOwnerTurnAtMs?(): number | undefined
  /**
   * 应答闸门阈值：连续几次开口无人回应后，只保留到期的意图（博士自己定的
   * 时间承诺），其余提醒闭嘴。默认 `DEFAULT_SILENT_LIMIT`（2）；`0` 关闭闸门。
   */
  silentLimit?: number
}

export interface WakeClockStats {
  ticks: number
  fired: number
  skipped: number
  failures: number
  stopped: boolean
  lastFiredAtMs: number | null
  lastReason: WakeReason | null
  /**
   * 连续几次开口没被接住（DESIGN-09）。只在「准备开口」时判断：投递成功后
   * 保持不清零，只有博士在最后一次开口之后说过话才归零。
   */
  unanswered: number
}

export interface WakeClock {
  /** 开定时器，并立刻 kick 一次（启动积压不用等第一个周期）。 */
  start(): void
  stop(): void
  /**
   * 手动跑一次（测试 / 运维入口）。返回本次真正投递出去的原因。
   * `start()` 之后也会由定时器调用它。
   */
  tick(): Promise<WakeReason[]>
  stats(): WakeClockStats
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_MIN_GAP_MS = 30 * 60_000
const DEFAULT_DAILY_CAP = 8
const DEFAULT_MAX_FAILURES = 3
/** 应答闸门默认阈值：连续两次无人回应就只留 intent。 */
export const DEFAULT_SILENT_LIMIT = 2

/**
 * 解析应答闸门阈值（`PRTS_CLOCK_SILENT_LIMIT`）。
 *
 * 为什么单独一个函数、为什么不复用 `start.ts` 的 `envNum`：`envNum` 要求
 * `> 0`，而 `0` 在这里是**有意义的取值**（显式关掉闸门）。走 `envNum` 会让
 * 「关掉」被静默回落成「按默认开」——主人以为自己关了闸门，其实没关。
 * 空值 / 非法值（含负数、小数）才回落默认。
 */
export function parseSilentLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SILENT_LIMIT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_SILENT_LIMIT
}

export function attachWakeClock(deps: WakeClockDeps): WakeClock {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const minGapMs = deps.minGapMs ?? DEFAULT_MIN_GAP_MS
  const dailyCap = deps.dailyCap ?? DEFAULT_DAILY_CAP
  const maxFailures = deps.maxFailures ?? DEFAULT_MAX_FAILURES
  // `0` 是有意义的取值（关掉闸门），不能用 `||` 兜底。
  const silentLimit = deps.silentLimit ?? DEFAULT_SILENT_LIMIT
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((msg: string) => console.error(msg))

  const stats: WakeClockStats = {
    ticks: 0, fired: 0, skipped: 0, failures: 0, stopped: false,
    lastFiredAtMs: null, lastReason: null, unanswered: 0,
  }
  /** 自然日计数：跨日自动归零（用本地日期，博士看的是本地时间）。 */
  let dayKey = ''
  let dayCount = 0
  let running: ReturnType<typeof setInterval> | undefined
  let kickTimer: ReturnType<typeof setTimeout> | undefined
  let inTick = false
  /** `stop()` 是"完全停"：连手动 tick 也不再投递。与"因失败自停"区分开。 */
  let closed = false

  const todayKey = (ms: number): string => new Date(ms).toDateString()

  const fail = (error: unknown): void => {
    stats.failures += 1
    try { deps.onFailure?.(error, stats.failures) } catch { /* 留痕失败不影响计数 */ }
    try {
      log(`[clock] 投递失败（连续 ${stats.failures}/${maxFailures}）：${error instanceof Error ? error.message : String(error)}`)
    } catch { /* 日志失败也不能影响调度 */ }
    if (stats.failures >= maxFailures && !stats.stopped) {
      stats.stopped = true
      try { deps.onStopped?.(`连续失败 ${stats.failures} 次`, stats.failures) } catch { /* 同上 */ }
      try { log('[clock] 连续失败到阈值，已自停（不自动恢复，等下次进程启动）') } catch { /* 同上 */ }
      stopTimer()
    }
  }

  const stopTimer = (): void => {
    if (running !== undefined) { clearInterval(running); running = undefined }
    if (kickTimer !== undefined) { clearTimeout(kickTimer); kickTimer = undefined }
  }

  const tick = async (): Promise<WakeReason[]> => {
    // 重入保护：上一轮还在等模型收敛时又来一个 tick，直接跳过一次。
    // 不做队列——那会让「模型很慢」变成「消息堆积」。
    if (closed) return []
    if (inTick) { stats.skipped += 1; return [] }
    if (stats.stopped) return []

    stats.ticks += 1
    const at = now()

    const key = todayKey(at)
    if (key !== dayKey) { dayKey = key; dayCount = 0 }

    try { deps.onTick?.(at) } catch (error) {
      try {
        log(`[clock] onTick 检查失败（不计投递失败）：${error instanceof Error ? error.message : String(error)}`)
      } catch { /* 日志失败也不能影响调度 */ }
    }

    if (stats.lastFiredAtMs !== null && at - stats.lastFiredAtMs < minGapMs) {
      stats.skipped += 1
      return []
    }
    if (dayCount >= dailyCap) {
      stats.skipped += 1
      return []
    }

    let due: WakeReason[]
    try {
      due = deps.collectDue(at)
    } catch (error) {
      // 库故障不是「没有到期」——静默当成空会让人以为一切正常。
      fail(error)
      return []
    }
    if (due.length === 0) return []

    // —— 应答闸门（DESIGN-09）：她会看自己说的话有没有被接住。
    // 判断只在「准备开口」时做：没有到期项就不算开口，不累积 streak
    // （否则闲置一夜后第一次有到期项就被误挡）。
    const lastAt = stats.lastFiredAtMs
    const readOwnerAt = deps.lastOwnerTurnAtMs
    if (silentLimit > 0 && lastAt !== null && readOwnerAt !== undefined) {
      try {
        const ownerAt = readOwnerAt()
        // 只认**最后一次开口之后**说过的话：更早的发言代表不了这次被接住。
        if (ownerAt === undefined || ownerAt <= lastAt) stats.unanswered += 1
        else stats.unanswered = 0
      } catch (error) {
        // 读不到博士的发言时间 ≠ 没人接。故障时不判断（不累积也不清零），
        // 免得库偶发失败变成「她从此不提醒了」。
        try {
          log(`[clock] 应答检查失败（不计入 streak）：${error instanceof Error ? error.message : String(error)}`)
        } catch { /* 日志失败也不能影响调度 */ }
      }
    }
    // 无人回应到阈值 → 只留博士自己定的时间承诺：提醒是打扰，可以等博士回来；
    // 承诺是约定，迟到就是失约。
    const silentBlocked = silentLimit > 0 && stats.unanswered >= silentLimit
    const eligible = silentBlocked ? due.filter((r) => r.kind === 'intent') : due
    if (eligible.length === 0) { stats.skipped += 1; return [] }

    const first = eligible[0] as WakeReason
    inTick = true
    let clockSessionId: string | void
    try {
      clockSessionId = await deps.deliver(first, at)
    } catch (error) {
      inTick = false
      fail(error)
      return []
    }
    inTick = false

    stats.fired += 1
    stats.lastFiredAtMs = at
    stats.lastReason = first
    dayCount += 1
    stats.failures = 0

    try { deps.onFired(first, at, typeof clockSessionId === 'string' ? clockSessionId : undefined) } catch (error) {
      // 留痕失败不改投递结论：话说出去了，就不能再当成没说过（否则会重复说）。
      try { log(`[clock] 留痕失败（投递已成功）：${error instanceof Error ? error.message : String(error)}`) } catch { /* 同上 */ }
    }
    return [first]
  }

  return {
    start(): void {
      if (stats.stopped || running !== undefined) return
      // 启动 kick：上次关机积压的到期项不用等第一个完整周期。
      kickTimer = setTimeout(() => {
        kickTimer = undefined
        void tick()
      }, 0)
      kickTimer.unref?.()
      running = setInterval(() => { void tick() }, intervalMs)
      running.unref?.()
    },
    stop(): void {
      // 停就是停：调度器已经关掉，此时还能手动 tick 出一次投递，
      // 意味着 dispose 流程里仍会起离屏会话——那是真 bug，不是灵活性。
      closed = true
      stopTimer()
    },
    tick,
    stats: () => ({ ...stats }),
  }
}
