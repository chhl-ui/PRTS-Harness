/**
 * 情感事件源：turn 正常收尾、博士验收 / 否定。
 *
 * ## 为什么需要它
 *
 * 架构需求 §5.1 写的是四类事件驱动情绪：「对话内容、任务成败、长时间未见、
 * 博士的反馈」。而 `emotion-trigger.ts` 之前只接了一类（`agent/error`）。
 * 生产库 `emotion_events = 0` 就是缺口的直接证据——机制通，没人喂。
 *
 * 这里补三类，第四类（长时间未见）要时钟，属于另一个组件，不在此处：
 *
 * | 事件 | 情绪 | 依据 |
 * |---|---|---|
 * | `agent/turn-stopping`（DSH 语义：turn 即将正常关闭） | 顺利 | 这一轮没出事 |
 * | `/accept`（博士验收任务） | 被认可 | §5.1「博士的反馈」 |
 * | `/reject`（博士否定） | 受挫 | 同上，负反馈 |
 *
 * ## 失败轮不许写正向
 *
 * `agent/error` 是 emit，turn-stopping 是 serial 且之后仍可能触发。如果不记住
 * 「哪些 turn 失败过」，一次失败的回合会被后到的「顺利」覆盖——情绪与实际相反，
 * 而且是静默的。所以本模块自己维护 `failedTurns`，收尾时先消费再判断。
 *
 * ## 为什么 turn 收尾也要节流
 *
 * 连聊十轮会写十条「顺利」。默认 5 分钟窗口：情绪的合适尺度是「一段时间的状态」，
 * 不是「每一轮的消息条数」。博士反馈（accept/reject）不节流——那是明确的单次事件。
 */
import type { EmotionActor, EmotionStore } from '../emotion/index.ts'
import { createEmotionOnError } from './emotion-trigger.ts'
import type { AgentErrorEntry } from './error-report.ts'

interface Mood {
  valence: number
  arousal: number
  label: string
}

/** 顺利收尾：轻微正向、低唤醒——「事情办完了」不是「大成功」。 */
const RELIEF: Mood = { valence: 0.12, arousal: 0.2, label: '顺利' }
/** 博士验收：比顺利强，但不到兴奋。 */
const ACCEPTED: Mood = { valence: 0.35, arousal: 0.35, label: '被认可' }
/** 博士否定：负效价 + 中等唤醒——挫败感比低落更「动」。 */
const REJECTED: Mood = { valence: -0.3, arousal: 0.45, label: '受挫' }

const TURN_END_ACTOR: EmotionActor = { kind: 'system', component: 'turn-end' }
const FEEDBACK_ACTOR: EmotionActor = { kind: 'system', component: 'owner-feedback' }

export interface EmotionSignalDeps {
  store: EmotionStore
  now?: () => number
  /** turn 收尾的节流窗口，默认 5 分钟。 */
  turnEndThrottleMs?: number
  /** 失败情绪的节流窗口，沿用 `emotion-trigger` 的默认（10 分钟）。 */
  errorThrottleMs?: number
}

export interface EmotionSignals {
  /** 接 `attachErrorReporter({ onReport })`：既写受挫，也记下失败 turn。 */
  onError(entry: AgentErrorEntry): void
  /** 接 `agent/turn-stopping`：正常收尾写「顺利」；失败 turn 跳过。 */
  onTurnStopping(payload: { turn: number }): void
  /** 博士验收任务（`/accept`）。理由进事件，事后能追「为什么心情好」。 */
  onOwnerAccept(reason: string): void
  /** 博士否定任务（`/reject`）。 */
  onOwnerReject(reason: string): void
}

export function createEmotionSignals(deps: EmotionSignalDeps): EmotionSignals {
  const now = deps.now ?? Date.now
  // 复用既有 producer：10 分钟节流、只走 system 通道、写失败吞掉，行为一点不改。
  const onErrorRaw = createEmotionOnError({
    store: deps.store,
    now,
    ...(deps.errorThrottleMs === undefined ? {} : { throttleMs: deps.errorThrottleMs }),
  })
  const failedTurns = new Set<number>()
  const turnThrottle = deps.turnEndThrottleMs ?? 5 * 60_000
  let lastTurnEndAt = Number.NEGATIVE_INFINITY

  const write = (actor: EmotionActor, mood: Mood, reason: string): void => {
    try {
      deps.store.update(actor, { ...mood, reason, atMs: now() })
    } catch {
      // 情绪是增强，不是闸门：写失败不能拖垮错误上报或对话。
    }
  }

  return {
    onError(entry) {
      // 先记账再写情绪：即使节流让这次没落库，「这个 turn 失败过」的事实仍要记住。
      failedTurns.add(entry.turn)
      onErrorRaw(entry)
    },
    onTurnStopping(payload) {
      const turn = payload.turn
      // 失败 turn：error 已写过受挫，这里吞掉，不让后到的「顺利」覆盖它。
      if (failedTurns.delete(turn)) return
      const at = now()
      if (at - lastTurnEndAt < turnThrottle) return
      lastTurnEndAt = at
      write(TURN_END_ACTOR, RELIEF, 'turn 正常收尾')
    },
    onOwnerAccept(reason) {
      write(FEEDBACK_ACTOR, ACCEPTED, `博士验收：${reason}`)
    },
    onOwnerReject(reason) {
      write(FEEDBACK_ACTOR, REJECTED, `博士否定：${reason}`)
    },
  }
}
