/**
 * 后台巩固调度（P1-3）：空闲时把 live turn 巩固成关联图与事实。
 *
 * ## 为什么必须有它
 *
 * 巩固此前只有 CLI 手动入口（`prts memory consolidate / extract-facts`），运行时
 * 零调度——生产库里永远只有对话原文，没有实体/事实，`mem_facts` 空转，「纠正了
 * 还答旧值」（V1-06 F10）的修复链路第一段就断在这里。
 *
 * ## 触发与预算
 *
 * - 挂 `agent/turn-stopping`：回合结束后 idle 毫秒无事发生才跑——巩固不能跟
 *   用户回合抢事件循环（规则巩固是同步 SQL，跑在进程内）。
 * - 启动时先 kick 一次：上次关机留下的积压不用等第一轮对话。
 * - 每次运行有独立预算（rulesMaxTurns / factsLimit）：到顶即停，`budget` 状态
 *   会安排紧接着的下一轮，积压期间逐步消化而不是一次跑死。
 * - 随时可取消：`dispose()` 中止当前运行（ AbortSignal 只在批边界生效，
 *   不留下半成品——巩固管线的既有不变量）。
 *
 * ## 模型阶段的可有可无
 *
 * 规则巩固零成本、必跑；事实抽取要调本地 Ollama。探活失败（Ollama 没起、
 * 端口不通）时**跳过模型阶段而不是报错**——本地模型是加分项不是前置条件，
 * 降级期间规则图照长，检索照常工作。探活结果缓存，避免每轮一次 HTTP。
 *
 * 所有失败只写 stderr——巩固是后台事，绝不能影响前台对话。
 */
import type { Embedder, MemoryStore, TextGenerator } from '../memory/index.ts'

export interface MemorySchedulerDeps {
  store: MemoryStore
  /** 事件总线（agent/turn-stopping）。不给也能用——只能靠 runOnce 手动触发。 */
  events?: { on(name: string, fn: (payload: unknown) => void): () => void }
  /** 惰性取生成器：Ollama 探活不过时返回 undefined，本次只跑规则巩固。 */
  generator?: () => Promise<TextGenerator | undefined>
  /**
   * 惰性取向量后端（Wave 2）：与 generator 独立——嵌入（bge-m3）与事实
   * 抽取（q38）是两个模型，探活/可用性各自判定。缺席时跳过嵌入阶段。
   */
  embedder?: () => Promise<Embedder | undefined>
  /**
   * 当前情绪效价（-1..1）提供者。**记忆库不 import 情感库**，所以由装配层接线；
   * 缺席或返回 undefined 时事实落 0.5（旧行为）。见 `memory/lifecycle.ts:importanceFromValence`。
   */
  currentValence?: () => number | undefined
  /** 回合结束后多少毫秒视为空闲，默认 3000。 */
  idleMs?: number
  /** 每次运行规则巩固的 turn 预算，默认 500。 */
  rulesMaxTurns?: number
  /** 每次运行事实抽取处理的 turn 数，默认 20。 */
  factsLimit?: number
  /** 事实抽取每批条数，默认 10。 */
  factsBatch?: number
  /**
   * 每次运行补向量的条数上限，默认 200。kinds 固定 ['fact','profile','turn']：
   * 生产 live 库量级小（日均数十 turn），turn 是必须含的——「咖啡→拿铁」
   * 这类语义缺口在 turn 正文里，不是 fact 里。
   */
  embedLimit?: number
  log?: (msg: string) => void
}

export interface MemorySchedulerStats {
  runs: number
  rulesTurns: number
  factsTurns: number
  factsAdded: number
  /** 连续跳过模型阶段的次数（探活不过）。 */
  modelSkips: number
  /** 嵌入阶段累计补成的向量条数与失败条数。 */
  embedded: number
  embedFailed: number
  lastError: string | null
  lastRunAtMs: number | null
  running: boolean
}

export interface MemoryScheduler {
  /** 立刻跑一轮（不等 idle）。已在跑时排队——返回的 Promise 代表「已排上」。 */
  runOnce(): Promise<void>
  stats(): MemorySchedulerStats
  dispose(): void
}

export function attachMemoryScheduler(deps: MemorySchedulerDeps): MemoryScheduler {
  const idleMs = deps.idleMs ?? 3000
  const rulesMaxTurns = deps.rulesMaxTurns ?? 500
  const factsLimit = deps.factsLimit ?? 20
  const factsBatch = deps.factsBatch ?? 10
  const embedLimit = deps.embedLimit ?? 200
  const log = deps.log ?? ((msg: string) => console.error(msg))

  const stats: MemorySchedulerStats = {
    runs: 0, rulesTurns: 0, factsTurns: 0, factsAdded: 0,
    modelSkips: 0, embedded: 0, embedFailed: 0,
    lastError: null, lastRunAtMs: null, running: false,
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let queued = false
  let disposed = false

  const schedule = (delayMs: number): void => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void runOnce()
    }, delayMs)
  }

  const runOnce = async (): Promise<void> => {
    if (disposed) return
    if (running) { queued = true; return }
    running = true
    stats.running = true
    try {
      // 1. 规则巩固：同步、零成本，一次一个预算单位。
      const rules = deps.store.consolidateRules({ maxTurns: rulesMaxTurns, signal: abort.signal })
      stats.rulesTurns += rules.turns

      // 2. 事实抽取：生成器可用才跑。生成器自身/抽取失败都不影响规则成果。
      if (deps.generator !== undefined && !abort.signal.aborted) {
        let gen: TextGenerator | undefined
        try { gen = await deps.generator() } catch { gen = undefined }
        if (gen === undefined) {
          stats.modelSkips++
        } else {
          const r = await deps.store.consolidateFacts({
            generator: gen, limit: factsLimit, batchSize: factsBatch,
            actor: 'system', signal: abort.signal,
            // 情绪只在「刚结束一回合」时才对得上（那正是 turn-stopping 触发的这一档）；
            // 启动 kick 补历史时拿到的是当下的情绪，属已知近似——
            // 取舍写在 `memory/lifecycle.ts:importanceFromValence` 的注释里。
            ...(deps.currentValence === undefined ? {} : { emotionValence: deps.currentValence }),
          })
          stats.factsTurns += r.turns
          stats.factsAdded += r.added
          // 事实层 backlog 还在：马上排下一轮，别等下一次对话空闲。
          if (r.stop === 'budget' || rules.stopped === 'budget') schedule(500)
        }
      } else if (rules.stopped === 'budget') {
        schedule(500)
      }

      // 3. 向量补齐：与模型阶段独立——嵌入后端缺席/失败不拖垮前两段的成果。
      // kinds 显式含 turn：live 库量级小，且「咖啡→拿铁」式语义缺口在 turn 正文里。
      if (deps.embedder !== undefined && !abort.signal.aborted) {
        try {
          const emb = await deps.embedder()
          if (emb !== undefined) {
            const r = await deps.store.embedPending({
              embedder: emb, limit: embedLimit, kinds: ['fact', 'profile', 'turn'],
            })
            stats.embedded += r.embedded
            stats.embedFailed += r.failed
          }
        } catch (e) {
          stats.embedFailed++
          log(`[prts] memory embed stage failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      stats.runs++
      stats.lastError = null
      stats.lastRunAtMs = Date.now()
    } catch (error) {
      // 巩固失败只记账——绝不往事件 handler 里抛（会污染 agent 的错误通道）。
      stats.lastError = error instanceof Error ? error.message : String(error)
      log(`[prts] memory scheduler run failed: ${stats.lastError}`)
    } finally {
      running = false
      stats.running = false
      if (queued && !disposed) {
        queued = false
        schedule(0)
      }
    }
  }

  const off = deps.events?.on('agent/turn-stopping', () => {
    // 每回合都重置 idle 计时：连续对话期间不抢资源。
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    schedule(idleMs)
  })

  // 启动 kick：清上次关机留下的积压。
  schedule(idleMs)

  return {
    runOnce,
    stats: () => ({ ...stats }),
    dispose() {
      disposed = true
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      abort.abort()
      off?.()
    },
  }
}

/**
 * 本地生成端点探活器：可用性的带缓存判定。
 *
 * 探活本身是一次 GET，毫秒级；缓存 60 s 让「服务没起」期间的每轮巩固
 * 不至于都等满超时（超时默认 1.5 s，服务不跑时每次都白等）。
 * `path` 默认 Ollama 的 `/api/version`；OpenAI 兼容端点传 `/models`
 * （Strata / llama.cpp / vLLM 都有这个 GET，语义同为「模型已就绪」）。
 */
export function createOllamaProbe(opts: { baseUrl: string; path?: string; timeoutMs?: number; cacheMs?: number; fetchImpl?: typeof fetch }): () => Promise<boolean> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '')
  const path = opts.path ?? '/api/version'
  const timeoutMs = opts.timeoutMs ?? 1500
  const cacheMs = opts.cacheMs ?? 60_000
  const fetchImpl = opts.fetchImpl ?? fetch
  let cached: { up: boolean; at: number } | undefined
  return async () => {
    if (cached !== undefined && Date.now() - cached.at < cacheMs) return cached.up
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    let up = false
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, { signal: ctrl.signal })
      up = res.ok
    } catch { up = false } finally { clearTimeout(t) }
    cached = { up, at: Date.now() }
    return up
  }
}
