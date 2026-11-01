/**
 * 每轮自动注入记忆：把「无意识回忆」接进生产链路。
 *
 * ## 为什么挂在 `agent/pre-step`
 *
 * 记忆要有用，模型得在**这一轮开始前**看到相关历史。三条候选通道实测排除：
 * - `system-prompt/assemble`：`AssembleContext` 只有 scope/signal（外加 agent），
 *   拿不到本轮用户消息；而 `inbox.claim()` 在 assemble 之前就把消息移出了队列。
 * - `agent/request`：`LlmCallConfig` 只有 provider/model，类型注释明确写了
 *   「cannot mutate messages」。
 * - `agent/pre-step`：payload 带 `messages: UserMessage[]`（本轮已认领的消息），
 *   `next()` 返回 `{kind:'enter', messages}`，**可以安全追加**——dsh-agent-loop 自己
 *   就是这么把 runtime context 投影成一条消息的（`lib/index.js:909-919`）。
 *
 * ## 两条纪律
 *
 * 1. **先 `await next()` 再在其返回值上追加**，不要自己造 messages：默认实现里
 *    还有 system-prompt 的 context 投影，自造会把它们丢掉。
 * 2. **整段包 try/catch，失败只打日志**：记忆是辅助，检索崩了不能让人这一轮说不了话。
 *
 * 注入用 `role: 'user'` 而不是 system：DSH 的 system prompt 由 system-prompt 服务
 * 独占，绕过它会被 `complete` section 的恢复语义吞掉；user 角色是 harness 自己
 * 注入 runtime context 时用的同一条通道。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryHit, MemoryStore } from '../memory/index.ts'

export interface MemoryInjectionDeps {
  store: MemoryStore
  /** 注入条数上限，默认 5。 */
  limit?: number
  /** 短于这么多字符的查询不检索：两个字的噪声大于信息，默认 4。 */
  minQueryChars?: number
}

export interface MemoryInjection {
  dispose(): void
}

/** 只用到 `on`——与 `spill/wiring.ts` 同构，不把整个 Context 拖进依赖。 */
export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

interface PreStepPayload {
  agent?: { session?: { id?: string } }
  messages?: unknown[]
  turn?: number
  step?: number
}

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

/** 从一条消息里抽可见文本。content 可能是字符串，也可能是 ContentBlock[]。 */
function textOf(message: unknown): string {
  const m = message as { content?: unknown } | undefined
  const content = m?.content
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

/** 归一化后比较：去掉空白与常见标点、统一小写。 */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。？！；：、,.?!;:]/g, '').toLowerCase()
}

function formatTime(hit: MemoryHit): string {
  if (hit.occurredAtMs === null || hit.occurredAtMs === undefined) return hit.occurredRaw ?? '时间未知'
  return new Date(hit.occurredAtMs).toISOString()
}

/** 注入正文。必须自报来源，否则模型会把它当成用户这一轮说的话。 */
function render(hits: MemoryHit[]): string {
  const lines = hits.map((h, i) => `${i + 1}. [${h.kind}] ${formatTime(h)} — ${h.text}`)
  return '[记忆检索] 与当前问题可能相关的历史记录（按相关度排序，来自长期记忆；不是用户本轮发言）：\n'
    + lines.join('\n')
}

export function attachMemoryInjection(hookCtx: HookContext, deps: MemoryInjectionDeps): MemoryInjection {
  const limit = deps.limit ?? 5
  const minQueryChars = deps.minQueryChars ?? 4
  // 同一 step 只注入一次：waterfall 在重试/重放场景可能对同一步触发多次，
  // 叠加注入会让上下文里出现多份同样的记忆。
  const lastStep = new Map<string, number>()

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // next() 在 try 外：它自己的失败是真故障，不能被这里的兜底吞掉。
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision

      const p = payload as PreStepPayload
      const sessionId = p.agent?.session?.id ?? ''
      const step = typeof p.step === 'number' ? p.step : -1
      if (step >= 0 && lastStep.get(sessionId) === step) return decision

      const messages = p.messages ?? []
      if (messages.length === 0) return decision
      const query = textOf(messages[messages.length - 1])
      if (query.length < minQueryChars) return decision

      // 本轮问题自己也在库里：`agent/inbox/claimed` 在 pre-step 之前就把这条 user
      // 消息落成了 turn，检索会把它当「历史记录」带回来——既占名额又对模型零信息。
      // 真机实测见过注入里第 2 条就是本轮原话。
      const queryKey = normalizeText(query)
      const hits = deps.store
        .search({ text: query, limit, includeOrigin: ['live'] })
        .filter((h) => h.kind !== 'turn' || normalizeText(h.text) !== queryKey)
      if (hits.length === 0) return decision

      if (step >= 0) lastStep.set(sessionId, step)
      const injected = {
        id: `mem-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: render(hits) }],
        source: { kind: 'user' },
      }
      return { ...decision, messages: [...decision.messages, injected] }
    } catch (error) {
      console.error(`[prts] memory inject failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    dispose: () => {
      lastStep.clear()
      off()
    },
  }
}
