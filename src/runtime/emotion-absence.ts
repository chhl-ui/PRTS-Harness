/**
 * 长时间未见 → 情感（TODO §G2 ④，DESIGN-06）。
 *
 * §5.1 四类情感事件源的最后一类。前三类（turn 收尾 / 博士反馈 / 报错）都是
 * 「发生了什么」驱动；这一类是「什么都没发生」驱动——博士超过阈值时长没有
 * 真实发言，写一条「想念」。
 *
 * 两条语义边界：
 * - **没见过 ≠ 离别**：库里没有任何博士真实发言时不写（新库不想念）。
 * - **一次离别一条**：去重的事实来源是情绪链——链上最近一次
 *   long-absence 事件晚于博士最后发言，说明这次离别已经写过，不重复。
 *   零新状态：重启、重建投影都不改变判定。
 *
 * 「博士真实发言」的口径在 `MemoryStore.lastOwnerTurnAtMs`：排除时钟
 * （`prts-clock-*`）与子任务（`subtask-*`）的合成 user 消息——它们也落
 * mem_turns，不排除的话时钟自己说话会把「未见时长」清零。
 */
import type { EmotionStore } from '../emotion/index.ts'

/** 想念：牵挂带轻微低落，比受挫（-0.3）轻；不是负反馈。数值是待验证假设（DESIGN-06 D4）。 */
export const MISS_MOOD = { valence: -0.15, arousal: 0.25, label: '想念' } as const

export const ABSENCE_COMPONENT = 'long-absence'

export interface AbsenceJudgeInput {
  nowMs: number
  /** 博士最后真实发言时刻；undefined = 从未见过。 */
  lastOwnerTurnAtMs: number | undefined
  /** 链上最近一次 long-absence 事件时刻；undefined = 从没写过。 */
  lastMissAtMs: number | undefined
  /** 阈值：超过这么久没见才写。 */
  afterMs: number
}

export function shouldWriteMiss(input: AbsenceJudgeInput): boolean {
  const { nowMs, lastOwnerTurnAtMs, lastMissAtMs, afterMs } = input
  if (lastOwnerTurnAtMs === undefined) return false
  if (nowMs - lastOwnerTurnAtMs <= afterMs) return false
  if (lastMissAtMs !== undefined && lastMissAtMs >= lastOwnerTurnAtMs) return false
  return true
}

/** 时长措辞沿用 clock 规则：小于 1 小时用分钟（start.ts 的 stale-task 同款）。 */
export function absenceReason(nowMs: number, lastOwnerTurnAtMs: number): string {
  const elapsed = nowMs - lastOwnerTurnAtMs
  const age = elapsed < 3_600_000
    ? `${Math.max(1, Math.round(elapsed / 60_000))} 分钟`
    : `${Math.round(elapsed / 3_600_000)} 小时`
  return `博士已经 ${age}没出现`
}

export interface AbsenceSignalDeps {
  emotion: EmotionStore
  lastOwnerTurnAtMs: () => number | undefined
  afterMs: number
  log?: (msg: string) => void
}

/**
 * 时钟 onTick 的检查体。读写失败一律吞掉只 log——情绪是增强不是闸门，
 * 绝不能让记忆库/情绪库的故障计入时钟的投递失败（那会触发时钟自停）。
 */
export function createAbsenceSignal(deps: AbsenceSignalDeps): (nowMs: number) => void {
  const log = deps.log ?? ((msg: string) => console.error(msg))
  return (nowMs: number): void => {
    try {
      const lastOwnerTurnAtMs = deps.lastOwnerTurnAtMs()
      if (lastOwnerTurnAtMs === undefined) return
      const lastMissAtMs = deps.emotion.lastEventAtMs(ABSENCE_COMPONENT)
      if (!shouldWriteMiss({ nowMs, lastOwnerTurnAtMs, lastMissAtMs, afterMs: deps.afterMs })) return
      deps.emotion.update(
        { kind: 'system', component: ABSENCE_COMPONENT },
        { ...MISS_MOOD, reason: absenceReason(nowMs, lastOwnerTurnAtMs), atMs: nowMs },
      )
    } catch (error) {
      try {
        log(`[prts] 想念情绪写入失败（不影响时钟）：${error instanceof Error ? error.message : String(error)}`)
      } catch { /* 日志失败也不能影响时钟 */ }
    }
  }
}