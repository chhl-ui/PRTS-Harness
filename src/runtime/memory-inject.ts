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
  /**
   * 更正钉住名额（默认 2）：近期带更正标记的 user turn 不经检索直接占位。
   * 存在的理由是 V1-06 F10——「我最近改喝拿铁了」没有「咖啡」二字，BM25
   * 在「我喝咖啡有什么习惯」下召不回它，模型于是答了旧值。在语义检索
   * 落地之前，更正句是宁可多注也不能漏的信号。占 limit 内名额：
   * 钉住的优先级高于字面命中，但总量不超限（上下文成本不变）。
   */
  correctionPins?: number
  /** 更正标记的回看窗口，默认 30 天。 */
  correctionWindowMs?: number
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

/**
 * 注入正文。必须自报来源，否则模型会把它当成用户这一轮说的话。
 *
 * 导出是给评测用的：离线探针必须喂**与生产完全相同**的文本，否则判分口径会漂——
 * 实测过一次（同一批题，带前缀的注入文本判 14/20，裸命中列表判 7/20），
 * 差 7 题全在格式而不是检索。
 */
export function renderInjection(hits: MemoryHit[]): string {
  const lines = hits.map((h, i) => `${i + 1}. [${h.kind}] ${formatTime(h)} — ${h.text}`)
  return '[记忆检索] 与当前问题可能相关的历史记录（按相关度排序，来自长期记忆；不是用户本轮发言）：\n'
    + lines.join('\n')
}

export function attachMemoryInjection(hookCtx: HookContext, deps: MemoryInjectionDeps): MemoryInjection {
  const limit = deps.limit ?? 5
  const minQueryChars = deps.minQueryChars ?? 4
  const correctionPins = deps.correctionPins ?? 2
  const correctionWindowMs = deps.correctionWindowMs ?? 30 * 86_400_000
  // 防同一 step 重放重复注入（waterfall 重试可对同一步触发多次）。
  // 键必须是 sessionId+turn+step——DSH 每轮 step 归 0（dsh-agent-loop/lib/index.js:955），
  // 只记 step 会把每轮首步都当成「已注入」而跳过，生产上实测变成只有首轮注入。
  const injectedSteps = new Set<string>()
  // 每 session 已注入过的命中 id：注入会以 user/message 持久化进会话日志，
  // 重复注入只是占上下文，没有新信息。进程内状态，重启丢——重启后可能重复注入一次，
  // 可接受。
  const injectedHitIds = new Map<string, Set<string>>()

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // next() 在 try 外：它自己的失败是真故障，不能被这里的兜底吞掉。
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision

      const p = payload as PreStepPayload
      const sessionId = p.agent?.session?.id ?? ''
      const turn = typeof p.turn === 'number' ? p.turn : -1
      const step = typeof p.step === 'number' ? p.step : -1
      const stepKey = `${sessionId}:${turn}:${step}`
      if (injectedSteps.has(stepKey)) return decision

      const messages = p.messages ?? []
      if (messages.length === 0) return decision
      const query = textOf(messages[messages.length - 1])
      if (query.length < minQueryChars) return decision

      // 本轮问题自己也在库里：`agent/inbox/claimed` 在 pre-step 之前就把这条 user
      // 消息落成了 turn，检索会把它当「历史记录」带回来——既占名额又对模型零信息。
      // 真机实测见过注入里第 2 条就是本轮原话。（保留作兜底：本会话 turn 过滤已覆盖它。）
      const queryKey = normalizeText(query)
      const seen = injectedHitIds.get(sessionId) ?? new Set<string>()
      // 三层过滤：1) 本会话自己的 turn（已在上下文里；代价：会话被 DSH 压缩后，
      //   早期同会话内容只能靠 prts_memory_recall 工具找回，注入不再带回——工具侧
      //   不做此过滤）2) 本会话已注入过的命中 id 3) 本轮原话（兜底）。
      // search 多取 limit*3 补齐过滤损耗，再截回 limit。
      const lexical = deps.store
        .search({ text: query, limit: limit * 3, includeOrigin: ['live'] })
        .filter((h) => h.kind !== 'turn' || h.sessionId !== sessionId)
        .filter((h) => !seen.has(h.id))
        .filter((h) => h.kind !== 'turn' || normalizeText(h.text) !== queryKey)
      // 更正钉住：近 30 天带更正标记的 user turn 直接进名额，排在字面命中之前。
      // 已过滤同会话（它在上下文里）与已注入过的 id。
      const pinned = correctionPins <= 0 ? [] : deps.store
        .recentCorrections({ sinceMs: Date.now() - correctionWindowMs, limit: correctionPins, excludeSessionId: sessionId })
        .filter((h) => !seen.has(h.id))
      const pinnedIds = new Set(pinned.map((h) => h.id))
      const hits = [...pinned, ...lexical.filter((h) => !pinnedIds.has(h.id))].slice(0, limit)
      if (hits.length === 0) return decision

      injectedSteps.add(stepKey)
      for (const h of hits) seen.add(h.id)
      injectedHitIds.set(sessionId, seen)
      const injected = {
        id: `mem-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: renderInjection(hits) }],
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
      injectedSteps.clear()
      injectedHitIds.clear()
      off()
    },
  }
}
