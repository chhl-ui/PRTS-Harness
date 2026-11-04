/**
 * Wave 1 装配器：在最外层观测七条 `agent/pre-step` 注入链，统一计费、按优先级整链裁剪，
 * 并写一条装配总账。
 *
 * ## 为什么必须最先注册
 *
 * Cordis 的 waterfall 是「先注册 = 最外层」
 * （`node_modules/@deepseek-ai/cordis/src/events.ts:234-243`：`next()` 用 `cbs.shift()`
 * 推进到下一个注册的 handler）。只有最外层的 `await next()` 才在其余七条链全部追加完
 * 之后返回，也只有它能看到完整的 `decision.messages`。注册点见 `src/runtime/start.ts`
 * 七条注入器之前。
 *
 * ## 为什么不用 `fitToBudget`
 *
 * 它是「保序前缀 + break」语义（`src/runtime/token-budget.ts:126-134`）：一条胖注入
 * 超预算就会连带丢掉后面所有链的候选。这里按**链**裁剪——从最低优先级整链移除，
 * 直到总量落进预算；memory 最后被裁。链级裁剪可归因（`droppedChains` 记下是谁被裁），
 * 不会把别的链饿死。
 *
 * ## 纪律
 *
 * - 记录失败只吞掉，不影响本轮装配（与 `memory-inject` 的 `recordOnce` 同一条）。
 * - 不动非注入消息（用户消息、DSH runtime context 等 id 不匹配任何前缀）。
 * - 不传预算 = 不裁，保持旧行为。
 */
import type { RecordInjectionInput } from '../memory/types.ts'

export interface AssemblyBudget {
  maxTokens: number
  /** 估算一段文本的 token；缺省 `ceil(chars / 2)`（与 memory-inject 同一口径）。 */
  estimateTokens?: (text: string) => number
}

export interface AssemblyDeps {
  /**
   * 总预算。传函数时在每次装配时求值——`start.ts` 里真正的预算在注册点之后才算出，
   * 且未来可能随会话/模型变化。
   */
  budget?: AssemblyBudget | (() => AssemblyBudget | undefined)
  /** 写装配总账；抛错不得影响本轮装配。 */
  record?: (input: RecordInjectionInput) => void
  /** 裁剪顺序，低 → 高。默认 proactive 最先、memory 最后。 */
  dropOrder?: readonly string[]
}

interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

/**
 * 注入消息 id 前缀 → 链标识。与七条注入器的 `id: \`<prefix>-${randomUUID()}\`` 同源
 * （memory-inject.ts:285 / skill-inject.ts:140 / intent-trigger.ts:106 /
 * emotion-inject.ts:73 / session-recall.ts:242 / task-reminder.ts:204 /
 * proactive-recall.ts:286）。
 */
const PREFIX_TO_CHAIN: readonly (readonly [string, string])[] = [
  ['mem-', 'memory'],
  ['skill-', 'skill'],
  ['intent-', 'intent'],
  ['mood-', 'emotion'],
  ['recall-', 'session-recall'],
  ['task-reminder-', 'task-reminder'],
  ['proactive-', 'proactive'],
]

/** 裁剪顺序：低 → 高。memory 是记忆主通道，最后才动。 */
const DEFAULT_DROP_ORDER: readonly string[] = [
  'proactive', 'task-reminder', 'intent', 'emotion', 'session-recall', 'skill', 'memory',
]

export interface Assembly {
  dispose(): void
}

function chainOf(message: unknown): string | undefined {
  const id = (message as { id?: unknown } | undefined)?.id
  if (typeof id !== 'string') return undefined
  for (const [prefix, chain] of PREFIX_TO_CHAIN) {
    if (id.startsWith(prefix)) return chain
  }
  return undefined
}

/** 从一条消息里抽可见文本。content 可能是字符串，也可能是 ContentBlock[]。 */
function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    ))
    .join(' ')
}

export function attachAssembly(hookCtx: HookContext, deps: AssemblyDeps = {}): Assembly {
  const defaultEstimate = (text: string): number => Math.ceil(text.length / 2)
  const dropOrder = deps.dropOrder ?? DEFAULT_DROP_ORDER

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    try {
      const p = payload as { agent?: { session?: { id?: string } }; turn?: number; step?: number }
      const sessionId = p.agent?.session?.id ?? ''
      const turn = typeof p.turn === 'number' ? p.turn : -1
      const step = typeof p.step === 'number' ? p.step : -1

      const entries = decision.messages.map((message) => ({ message, chain: chainOf(message) }))
      const injected = entries.filter((e) => e.chain !== undefined)
      const chains = [...new Set(injected.map((e) => e.chain as string))]
      const usedChars = injected.reduce((n, e) => n + textOf(e.message).length, 0)

      let kept = entries
      const dropped: string[] = []
      const budget = typeof deps.budget === 'function' ? deps.budget() : deps.budget
      if (budget !== undefined) {
        const estimate = budget.estimateTokens ?? defaultEstimate
        const costOf = (list: typeof entries): number => list
          .filter((e) => e.chain !== undefined)
          .reduce((n, e) => n + estimate(textOf(e.message)), 0)
        let used = costOf(kept)
        for (const chain of dropOrder) {
          if (used <= budget.maxTokens) break
          if (!kept.some((e) => e.chain === chain)) continue
          kept = kept.filter((e) => e.chain !== chain)
          dropped.push(chain)
          used = costOf(kept)
        }
      }

      // 单独 try/catch：观测失败不得退化成「注入消失」（与 memory-inject 的 recordOnce 同一条）。
      try {
        deps.record?.({
          sessionId,
          turn,
          step,
          injected: chains.length,
          hitIds: [],
          kinds: {},
          usedChars,
          limit: 0,
          outcome: 'injected',
          chain: 'assembly',
          chains,
          droppedChains: dropped,
        })
      } catch { /* 观测失败不阻断装配 */ }

      if (kept.length === decision.messages.length) return decision
      return { ...decision, messages: kept.map((e) => e.message) }
    } catch {
      // 装配器自身崩了不能阻断对话：退回未裁剪的 decision。
      return decision
    }
  })

  return { dispose: off }
}
