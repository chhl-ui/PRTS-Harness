/**
 * V1-05 的系统侧生产者：轮次失败 → 自动写一条负面情绪。
 *
 * ## 为什么需要它
 *
 * `src/emotion/` 的机制完整（写入者只认 owner 与带 component 的 system、读时衰减、
 * 每轮注入、与事实层物理隔离），但 `applyEmotionEvent` 在 `src/` 里**零调用**——
 * 没有任何代码在真实使用中写它。结果 `renderMood()` 永远返回空串，情感状态是个摆设。
 *
 * ## 为什么挂在 agent/error 上
 *
 * 「轮次失败」是系统能观测到的最干净的受挫信号：模型调用挂了、工具链断了，
 * 这些不需要理解语义就知道「不顺利」。而 `tool.denied`（守卫拒绝）更频繁，
 * 一次越界操作就低落会过度反应——那条留给将来的细化。
 *
 * ## 三条硬约束
 *
 * 1. **节流**：连续失败不该把情绪压到底。默认 10 分钟内只写一次。
 * 2. **不拖垮上报**：情绪写入失败一律吞掉——错误上报是诊断生命线，不能因为
 *    情绪库磁盘满了就让用户看不到错误。
 * 3. **只走 system 通道**：模型不能自设情绪（库里 `requireWriter` 守着），
 *    这里固定 `{ kind: 'system', component: 'error-report' }`。
 */
import type { EmotionStore, EmotionActor } from '../emotion/index.ts'
import type { AgentErrorEntry } from './error-report.ts'

export interface EmotionOnErrorDeps {
  store: EmotionStore
  /** 覆盖当前时刻（测试用）。 */
  now?: () => number
  /** 节流窗口，默认 10 分钟。 */
  throttleMs?: number
}

/** 受挫的固定形态：不快（负效价）+ 激活（高唤醒），与「低落」（低唤醒）区分。 */
const FRUSTRATION = { valence: -0.35, arousal: 0.6, label: '受挫' } as const

const ACTOR: EmotionActor = { kind: 'system', component: 'error-report' }

/**
 * 返回一个可直接接进 `attachErrorReporter({ onReport })` 的回调。
 * 每个实例有自己的节流窗口（不同会话互不影响）。
 */
export function createEmotionOnError(deps: EmotionOnErrorDeps): (entry: AgentErrorEntry) => void {
  const now = deps.now ?? Date.now
  const throttle = deps.throttleMs ?? 10 * 60_000
  let lastAt = Number.NEGATIVE_INFINITY

  return (entry) => {
    const at = now()
    if (at - lastAt < throttle) return
    lastAt = at
    const what = entry.code === undefined ? entry.name : `${entry.name}/${entry.code}`
    try {
      deps.store.update(ACTOR, {
        ...FRUSTRATION,
        reason: `轮次失败：${what}`,
      })
    } catch {
      // 情绪写失败不能影响错误上报——见文件头「三条硬约束」第 2 条。
    }
  }
}
