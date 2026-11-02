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
import { renderReading } from '../memory/index.ts'
import { applyRerank, type Reranker } from '../memory/rerank.ts'
import type { Embedder, MemoryHit, MemoryStore, ReadingDeps } from '../memory/index.ts'

export interface MemoryInjectionDeps {
  store: MemoryStore
  /** 注入条数上限，默认 5。 */
  limit?: number
  /**
   * 交叉编码器精排器（`PRTS_RERANK=1` 时由 start.ts 传入）。
   *
   * 只重排候选、不新增命中：候选池内召回是硬上限，它解决的是「答案在池里、
   * 但排不进 5 个注入名额」。未传或抛错时保持原有顺序，注入照常发生。
   */
  reranker?: Reranker
  /** 短于这么多字符的查询不检索：两个字的噪声大于信息，默认 4。 */
  minQueryChars?: number
  /**
   * 向量语义路（Wave 2）：惰性取 embedder——Ollama 探活不过时返回
   * undefined，本轮退化为纯字面检索。嵌入失败同样降级，不阻断注入。
   * 与更正钉住互补：pin 保证更正句必进，语义路补「咖啡→拿铁」这类
   * 零字面重叠的普通查询。
   */
  embedder?: () => Promise<Embedder | undefined>
  /**
   * 语义路余弦下限，默认 0.25：store 默认 0 会把余弦 0 的正交噪声也拉进
   * 融合（`sim >= 0` 全收），小库里噪声会占满 topK。bge-m3 中文短文本上
   * 无关对通常 <0.3、弱相关 ≥0.35——0.25 保弱命中、挡真噪声，可调。
   */
  semanticMinSim?: number
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

/**
 * 注入正文。必须自报来源，否则模型会把它当成用户这一轮说的话。
 *
 * 导出是给评测用的：离线探针必须喂**与生产完全相同**的文本，否则判分口径会漂——
 * 实测过一次（同一批题，带前缀的注入文本判 14/20，裸命中列表判 7/20），
 * 差 7 题全在格式而不是检索。
 *
 * `deps` 缺省时输出与历史版逐字一致的平铺编号列表；给出 `factMeta`/
 * `turnEntities`（`store` 的二阶补查）后进入「阅读」阶段（roadmap P1）：
 * 共享主题/会话的命中归组成卡，组内按时间升序并标出「最新」。
 */
export function renderInjection(hits: MemoryHit[], deps: ReadingDeps = {}): string {
  const r = renderReading(hits, deps)
  const header = r.grouped
    ? '[记忆检索] 与当前问题可能相关的历史记录（已按主题/会话归组；组内按时间排序，「最新」指该主题下最近一次记录，「较早」是更早的陈述。来自长期记忆，不是用户本轮发言）：\n'
    : '[记忆检索] 与当前问题可能相关的历史记录（按相关度排序，来自长期记忆；不是用户本轮发言）：\n'
  return header + r.body
}

export function attachMemoryInjection(hookCtx: HookContext, deps: MemoryInjectionDeps): MemoryInjection {
  const limit = deps.limit ?? 5
  const minQueryChars = deps.minQueryChars ?? 4
  const semanticMinSim = deps.semanticMinSim ?? 0.25
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
      let queryVector: number[] | undefined
      if (deps.embedder !== undefined) {
        try {
          const emb = await deps.embedder()
          if (emb !== undefined) queryVector = (await emb.embed([query]))[0]
        } catch { /* 嵌入失败降级为纯字面检索，不阻断对话 */ }
      }
      const ranked = deps.store
        .search({
          text: query, limit: limit * 3, includeOrigin: ['live'],
          ...(queryVector === undefined ? {} : { queryVector, semanticTopK: limit * 3, semanticMinSim }),
        })
        .filter((h) => h.kind !== 'turn' || h.sessionId !== sessionId)
        .filter((h) => !seen.has(h.id))
        .filter((h) => h.kind !== 'turn' || normalizeText(h.text) !== queryKey)
      // 精排（交叉编码器）：只重排 ranked，更正钉住（pinned）永远保持最前。
      // 依据：产品口径 @5 28.8% → 38.1%（+22 题，McNemar p=0.0000），
      // 见 docs/memory-recall-criteria-retest-2026-11-03.md 第九节。
      // 失败一律回落原顺序——记忆可以少几条精排，不能因为精排器挂了就不注入。
      let ordered = ranked
      if (deps.reranker !== undefined && ranked.length > 1) {
        try {
          const scores = await deps.reranker.score(query, ranked.map((h) => h.text))
          ordered = applyRerank(ranked, scores)
        } catch (error) {
          console.error(`[prts] memory rerank failed — 用原始顺序: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      // 更正钉住：近 30 天带更正标记的 user turn 直接进名额，排在字面命中之前。
      // 已过滤同会话（它在上下文里）与已注入过的 id。
      const pinned = correctionPins <= 0 ? [] : deps.store
        .recentCorrections({ sinceMs: Date.now() - correctionWindowMs, limit: correctionPins, excludeSessionId: sessionId })
        .filter((h) => !seen.has(h.id))
      const pinnedIds = new Set(pinned.map((h) => h.id))
      const hits = [...pinned, ...ordered.filter((h) => !pinnedIds.has(h.id))].slice(0, limit)
      if (hits.length === 0) return decision

      injectedSteps.add(stepKey)
      for (const h of hits) seen.add(h.id)
      injectedHitIds.set(sessionId, seen)
      // 阅读阶段（roadmap P1）：补查 fact 元数据与 turn 实体提及，
      // 把命中组织成主题/会话卡。失败降级平铺——归组是增强不是闸门。
      let reading: ReadingDeps = {}
      const factIds = hits.filter((h) => h.kind === 'fact').map((h) => h.id)
      const turnIds = hits.filter((h) => h.kind === 'turn').map((h) => h.id)
      try {
        reading = {
          ...(factIds.length > 0 ? { factMeta: deps.store.factMeta(factIds) } : {}),
          ...(turnIds.length > 0 ? { turnEntities: deps.store.turnEntities(turnIds) } : {}),
        }
      } catch { /* 元数据补查失败退回平铺注入 */ }
      const injected = {
        id: `mem-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: renderInjection(hits, reading) }],
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
