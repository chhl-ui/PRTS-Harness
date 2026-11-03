/**
 * V1-14 前瞻记忆 · W3：触发注入。
 *
 * 语义定案为**方案 B**（`docs/design-intent-memory-v1-14.md` 决策 2）：
 * 到期时进程在 → 准点提醒；进程不在 → 下次交互补发，且**必须如实告知延迟**。
 *
 * 为什么挂在 `agent/pre-step` 而不是起一个 setTimeout：提醒必须有会话可投递。
 * 定时器到点时若没有正在进行的对话，注入无处可去——那正是「补发」要解决的问题。
 * 挂钩子还有一种自然的覆盖：进程重启后第一次交互就会扫描到过期意图，
 * 「重启不丢失」因此不靠额外机制。
 *
 * 与记忆注入的关系：两者都追加 user 消息，但各自独立注册 handler——
 * 合并会让两条链的失败互相牵连（记忆注入挂了不该拖累提醒，反之亦然）。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryStore } from '../memory/index.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

export interface IntentTriggerDeps {
  store: MemoryStore
  /** 覆盖当前时刻（测试用，默认 `Date.now`）。 */
  now?: () => number
  /**
   * 超过这个延迟就按「补发」措辞提醒。默认 60 秒——比这更晚的触发，
   * 用户需要知道它不是准点发生的，否则会误以为系统一直在盯着表。
   */
  lateThresholdMs?: number
}

export interface IntentTrigger {
  /** 手动跑一次（测试用，避免依赖 hook 管道）。返回本次触发的意图 id。 */
  runOnce(): string[]
  dispose(): void
}

const fmtDelay = (ms: number): string => {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} 分钟`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时`
  return `${Math.round(hour / 24)} 天`
}

export function attachIntentTrigger(
  hookCtx: { on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void },
  deps: IntentTriggerDeps,
): IntentTrigger {
  const lateThreshold = deps.lateThresholdMs ?? 60_000
  const now = deps.now ?? Date.now
  /** 防同一 step 重放重复注入（waterfall 重试会对同一步触发多次）。 */
  const fired = new Set<string>()

  const runOnce = (): string[] => {
    const at = now()
    const due = deps.store.dueIntents(at).filter((r) => !fired.has(r.intentId))
    if (due.length === 0) return []
    const lines = due.map((r) => {
      const planned = new Date(r.fireAtMs).toISOString()
      const late = at - r.fireAtMs
      const head = late > lateThreshold
        ? `[提醒·补发] 你原定 ${planned} 的提醒（晚了 ${fmtDelay(late)}）`
        : `[提醒] ${planned}`
      return `${head}：${r.action}（你当时说的是「${r.conditionRaw}」）`
    })
    // 先标记再注入：重复提醒比漏提醒更烦人，而漏提醒用户可以再问一次。
    // 状态写入失败只记日志——提醒本身不能因为记账失败而发不出去。
    for (const r of due) {
      try {
        deps.store.markFired({ actor: 'system', intentId: r.intentId, firedAtMs: at })
        fired.add(r.intentId)
      } catch (error) {
        console.error(`[prts] intent markFired failed (${r.intentId}): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return [`[prts-intent] ${lines.join('\n')}`]
  }

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision
      const bodies = runOnce()
      if (bodies.length === 0) return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `intent-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: bodies[0] }],
            source: { kind: 'user' },
          },
        ],
      }
    } catch (error) {
      // 提醒失败绝不能阻断对话——它是增强，不是闸门。
      console.error(`[prts] intent trigger failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    runOnce,
    dispose: () => { off(); fired.clear() },
  }
}
