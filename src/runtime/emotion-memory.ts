/**
 * M→E 记忆→情感（DESIGN-07）：「对话内容」事件源的两个生产者。
 *
 * - **想起**（memory-recall）：每轮记忆注入真的把旧事实带进上下文时，
 *   写一条轻微暖意。只取 fact 命中（turn 是原始对话不是旧事），
 *   同一条事实 7 天冷却——去重的事实来源是情绪链本身，零新状态。
 * - **顾虑**（failure-mention）：博士本轮提到「收尾连续失败 ≥2 次」的项目时，
 *   写一条前瞻性沉重。同一项目无新结局不重复写。
 *
 * 两条纪律（与既有注入器/情绪生产者同构）：
 * 1. 只写情绪不说话：不起会话、不注入消息、不占任何说话额度。
 * 2. 写失败吞掉只 log。**想起的回调尤其不能抛**——memory-inject 的 catch
 *    会丢掉整段注入（memory-inject.ts:310），情绪绝不能成为记忆的新失败面。
 */
import type { EmotionStore } from '../emotion/index.ts'
import type { MemoryHit } from '../memory/index.ts'
import { tokenize } from '../memory/tokenize.ts'

/** 想起：认出旧事的轻微暖意，比顺利（0.12/0.2）略弱（待验证假设）。 */
export const RECALL_MOOD = { valence: 0.1, arousal: 0.15, label: '想起' } as const
/** 顾虑：话题勾起的前瞻性沉重，比受挫（-0.3/0.45，急性否定）轻（待验证假设）。 */
export const CONCERN_MOOD = { valence: -0.2, arousal: 0.3, label: '顾虑' } as const
export const RECALL_COMPONENT = 'memory-recall'
export const CONCERN_COMPONENT = 'failure-mention'
/** 同一条事实的想起冷却，与主动回忆冷却同值（待验证假设）。 */
export const RECALL_COOLDOWN_MS = 7 * 86_400_000
/** 「反复」的门槛：收尾连续失败次数（Tianshu consecutiveFailures≥2 先例）。 */
export const FAILURE_STREAK_MIN = 2

/**
 * 收尾连续失败数：最后一条 success 之后的 failure 数。
 * 先拒后收 → 0；收后再败两次 → 2。入参按链序（outcomeEvents 的返回序）。
 */
export function trailingFailures(
  outcomes: ReadonlyArray<{ outcome: 'success' | 'failure' }>,
): number {
  let n = 0
  for (const o of outcomes) {
    if (o.outcome === 'success') n = 0
    else n += 1
  }
  return n
}

/** 想起冷却：恰好等于冷却期不写，超过才写（与 ④ 阈值同一边界语义）。 */
export function shouldWriteRecall(input: {
  nowMs: number
  lastRecallAtMs: number | undefined
  cooldownMs: number
}): boolean {
  if (input.lastRecallAtMs === undefined) return true
  return input.nowMs - input.lastRecallAtMs > input.cooldownMs
}

/** 顾虑判定：连败够数，且该项目自上次顾虑后有过新结局（链上对比，零新状态）。 */
export function shouldWriteConcern(input: {
  failures: number
  lastConcernAtMs: number | undefined
  lastOutcomeAtMs: number
}): boolean {
  if (input.failures < FAILURE_STREAK_MIN) return false
  return input.lastConcernAtMs === undefined || input.lastOutcomeAtMs > input.lastConcernAtMs
}

/** 归一化：去空白与常见标点、统一小写（与 memory-inject 的同名私有函数同规则）。 */
function normalize(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。？！；：、,.?!;:]/g, '').toLowerCase()
}

/**
 * 「提到」检测：共享 token ≥2，或归一化后全标题包含。
 * 全包含是短标题兜底——2 字标题最多共享 1 个 token，纯阈值会漏（DESIGN-07 事实 8）。
 */
export function mentionsTask(query: string, title: string): boolean {
  const q = normalize(query)
  const t = normalize(title)
  if (t !== '' && q.includes(t)) return true
  const queryTokens = new Set(tokenize(query))
  let shared = 0
  for (const tok of tokenize(title)) if (queryTokens.has(tok)) shared += 1
  return shared >= 2
}

/** 压成一行并截断：reason 里的事实正文不该带换行假段落。 */
function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------- 想起 ----------

export interface MemoryRecallDeps {
  emotion: EmotionStore
  cooldownMs?: number
  log?: (msg: string) => void
}

/**
 * 接 memory-inject 的 onHits：注入成功后调用。
 * 每次注入最多写一条（第一条 fact 命中）；自吞异常是契约（见文件头）。
 */
export function createMemoryRecallSignal(
  deps: MemoryRecallDeps,
): (hits: readonly MemoryHit[], ctx: { sessionId: string; nowMs: number }) => void {
  const cooldownMs = deps.cooldownMs ?? RECALL_COOLDOWN_MS
  const log = deps.log ?? ((msg: string) => console.error(msg))
  return (hits, ctx) => {
    try {
      const fact = hits.find((h) => h.kind === 'fact' && h.text.trim() !== '')
      if (fact === undefined) return
      const lastRecallAtMs = deps.emotion.lastEventAtMs(RECALL_COMPONENT, fact.id)
      if (!shouldWriteRecall({ nowMs: ctx.nowMs, lastRecallAtMs, cooldownMs })) return
      deps.emotion.update(
        { kind: 'system', component: RECALL_COMPONENT },
        {
          ...RECALL_MOOD,
          reason: `想起旧事：${clip(fact.text, 60)}`,
          refId: fact.id,
          atMs: ctx.nowMs,
        },
      )
    } catch (error) {
      try { log(`[prts] 想起情绪写入失败（不影响注入）：${message(error)}`) } catch { /* 日志失败也不能影响注入 */ }
    }
  }
}

// ---------- 顾虑 ----------

/** 只用到 list/outcomeEvents 两个窄读法——不把整个 Ledger 拖进依赖。 */
export interface FailureMentionLedger {
  list(): Array<{ id: string; title: string }>
  outcomeEvents(): Array<{ taskId: string; outcome: 'success' | 'failure'; ts: number }>
}

export interface FailureMentionDeps {
  emotion: EmotionStore
  ledger: FailureMentionLedger
  /** 短于这么多字符的消息不算「提到」，默认 4（与各注入器同值）。 */
  minQueryChars?: number
  log?: (msg: string) => void
}

export interface FailureMention {
  dispose(): void
}

/** 只用到 `on`——与 memory-inject / skill-inject 同构。 */
export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

interface PreStepPayload {
  messages?: unknown[]
}

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

function textOf(msg: unknown): string {
  const content = (msg as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    ))
    .join(' ')
    .trim()
}

/**
 * 接 `agent/pre-step`，注册在 memory-inject **之前**（外层）：waterfall 的
 * next() 后副作用逆注册序执行（cordis waterfall outermost-first），外层后写——
 * 同轮想起 + 顾虑两写时顾虑覆盖想起（更具体者胜）。
 * 一轮最多写一条（list 序第一个命中的项目）。
 */
export function attachFailureMention(hookCtx: HookContext, deps: FailureMentionDeps): FailureMention {
  const minQueryChars = deps.minQueryChars ?? 4
  const log = deps.log ?? ((msg: string) => console.error(msg))

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // next() 在 try 外：它自己的失败是真故障，不能被这里的兜底吞掉。
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision
      const messages = (payload as PreStepPayload).messages ?? []
      if (messages.length === 0) return decision
      const query = textOf(messages[messages.length - 1])
      if (query.length < minQueryChars) return decision

      const byTask = new Map<string, Array<{ outcome: 'success' | 'failure'; ts: number }>>()
      for (const o of deps.ledger.outcomeEvents()) {
        const arr = byTask.get(o.taskId)
        if (arr === undefined) byTask.set(o.taskId, [{ outcome: o.outcome, ts: o.ts }])
        else arr.push({ outcome: o.outcome, ts: o.ts })
      }

      for (const task of deps.ledger.list()) {
        const outcomes = byTask.get(task.id)
        if (outcomes === undefined) continue
        const failures = trailingFailures(outcomes)
        if (failures < FAILURE_STREAK_MIN) continue
        if (!mentionsTask(query, task.title)) continue
        const lastConcernAtMs = deps.emotion.lastEventAtMs(CONCERN_COMPONENT, task.id)
        const lastOutcomeAtMs = outcomes[outcomes.length - 1]?.ts ?? 0
        if (!shouldWriteConcern({ failures, lastConcernAtMs, lastOutcomeAtMs })) continue
        deps.emotion.update(
          { kind: 'system', component: CONCERN_COMPONENT },
          {
            ...CONCERN_MOOD,
            reason: `又提到反复失败的项目：${task.title}（连续失败 ${failures} 次）`,
            refId: task.id,
          },
        )
        break // 一轮最多一条：多个项目被提到时按 list 序取第一个
      }
    } catch (error) {
      try { log(`[prts] 顾虑情绪检查失败（不影响对话）：${message(error)}`) } catch { /* 日志失败也不能影响对话 */ }
    }
    return decision
  })

  return { dispose: off }
}