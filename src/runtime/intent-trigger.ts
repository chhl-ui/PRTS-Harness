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
 *
 * ## 留痕观测点在**装配之后**，不在本 handler 里
 *
 * 本 handler 只负责「挑出到期意图 + 渲染正文」，把候选记进进程内 `pending`。
 * 真正的 `markFired` 由 `markDelivered(sessionId)` 执行，调用者是装配器
 * （`assembly.ts` 的 `onDelivered`）——它在本轮装配**最终保留**了 intent 链时才回调。
 *
 * 为什么不能在本 handler 里直接 markFired：handler 返回的 decision 还要经过下游
 * 装配器的整链裁剪与上游插件的 reject。本 handler 认为「注入成功」的那一刻，
 * 消息可能根本进不了模型上下文——那时留痕就把一条**没送到的提醒**永久记成已提醒，
 * 用户再也收不到它。反过来（不投递不记账）最坏只是下次再来一遍。
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
  /**
   * 一次最多展开几条到期提醒，默认 3。
   *
   * 全部展开会把 5 条到期拼成一堵墙，读的人得先在墙里找到最要紧的那条。
   * 折叠**只改显示**：被折叠的同样进入 `pending`，投递成功后一并 markFired，
   * 不会下次再来一遍。
   */
  maxVisible?: number
}

export interface IntentTrigger {
  /**
   * 手动跑一次（测试/运维入口，绕开 hook 管道）：渲染后**立即按已投递留痕**。
   * 没有会话可归，`session_id` 记 null——它说的是「有人手动催了一次」，不是「念给了某会话」。
   */
  runOnce(): string[]
  /**
   * 确认投递：把本轮渲染过、且属于该会话的候选落成 `intent.fired`（带 `session_id`）。
   *
   * 由装配器在**最终保留 intent 链**时调用；被裁掉 / 被 reject 时不调用，
   * 意图因此仍是 `pending`，下次交互继续提醒。
   */
  markDelivered(sessionId: string): void
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
  const rawMax = deps.maxVisible ?? 3
  const maxVisible = Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 3
  const now = deps.now ?? Date.now
  /** 已确认投递的意图：同进程内不再重复挑（重启后由库里的 pending 状态接管）。 */
  const delivered = new Set<string>()
  /**
   * 已渲染、**尚未确认投递**的候选：intentId → { firedAtMs, sessionId }。
   *
   * 它不是缓存而是账：装配器裁掉 intent 链 / 上游 reject 时它原样保留，
   * 下一次交互重新渲染同一条提醒（正文缓存见 `pendingBody`），
   * 直到某一次真的进了 messages 才换成 `delivered`。
   */
  const pending = new Map<string, { firedAtMs: number; sessionId: string }>()
  /** 上一轮渲染出的正文 + 它属于哪个会话：同一会话的 step 重放直接复用，不重复渲染。 */
  let pendingBody: string | undefined
  let pendingSession: string | undefined

  /**
   * 选出到期意图并渲染正文，**不写任何留痕**。
   * 返回 `undefined` 表示本次没有可提醒的内容。
   */
  const render = (sessionId: string): string | undefined => {
    // step 重放（waterfall 重试）走这里：上一轮还没投递完，正文原样复用，
    // 既不重复查库，也不会把同一批意图渲染出两份不同措辞。
    if (pendingBody !== undefined && pendingSession === sessionId) return pendingBody

    const at = now()
    const due = deps.store.dueIntents(at).filter((r) => !delivered.has(r.intentId))
    if (due.length === 0) {
      pending.clear()
      pendingBody = undefined
      pendingSession = undefined
      return undefined
    }
    // 折叠只影响**显示**：lines 用 visible，pending 用全部 due。
    // 反过来（只记 visible）会让被折叠的提醒下次再来一遍，用户看到重复。
    const visible = due.slice(0, maxVisible)
    const lines = visible.map((r) => {
      const planned = new Date(r.fireAtMs).toISOString()
      const late = at - r.fireAtMs
      const head = late > lateThreshold
        ? `[提醒·补发] 你原定 ${planned} 的提醒（晚了 ${fmtDelay(late)}）`
        : `[提醒] ${planned}`
      return `${head}：${r.action}（你当时说的是「${r.conditionRaw}」）`
    })
    const hidden = due.length - visible.length
    if (hidden > 0) {
      lines.push(`另有 ${hidden} 条到期提醒未展开（用 /intent 查看）`)
    }
    pending.clear()
    for (const r of due) pending.set(r.intentId, { firedAtMs: at, sessionId })
    pendingBody = `[prts-intent] ${lines.join('\n')}`
    pendingSession = sessionId
    return pendingBody
  }

  const markDelivered = (sessionId: string): void => {
    if (pending.size === 0) return
    for (const [intentId, entry] of pending) {
      // 只认同一会话：别的会话渲染的候选不能被这一轮的投递记成已送达。
      if (entry.sessionId !== sessionId) continue
      try {
        deps.store.markFired({ actor: 'system', intentId, firedAtMs: entry.firedAtMs, sessionId })
        delivered.add(intentId)
      } catch (error) {
        // 留痕失败只记日志：提醒已经发出去了，不能因为记账失败把它再发一遍。
        // 但也不进 `delivered`——交给下一轮重试（旧行为，宁可重复不可丢失）。
        console.error(`[prts] intent markFired failed (${intentId}): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 本轮候选已被处理（成功的进 delivered、失败的交给下一轮重新渲染）。
    pending.clear()
    pendingBody = undefined
    pendingSession = undefined
  }

  /** 手动跑一次：渲染即投递（旧语义），`session_id` 记 null。 */
  const runOnce = (): string[] => {
    const body = render('')
    if (body === undefined) return []
    markDelivered('')
    return [body]
  }

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision
      const p = payload as { agent?: { session?: { id?: string } } }
      const sessionId = p.agent?.session?.id ?? ''
      const body = render(sessionId)
      if (body === undefined) return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `intent-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: body }],
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
    markDelivered,
    dispose: () => {
      off()
      delivered.clear()
      pending.clear()
      pendingBody = undefined
      pendingSession = undefined
    },
  }
}
