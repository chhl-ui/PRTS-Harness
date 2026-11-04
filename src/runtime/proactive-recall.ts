/**
 * V1-07 主动回忆：把「可以自然提起的旧事」接进生产链路。
 *
 * 架构需求 §7 V1-07：「7 天试用中出现自然提起过去的情况，博士认为恰当的占比
 * 至少 70%；**可以关闭**」。
 *
 * 与 `memory-inject.ts` 的分工不是重复而是相反方向：
 * - `memory-inject` 回答「这轮的问题需要哪些历史」——**有问必答**，每轮都注入。
 * - 这里回答「有没有一件旧事值得我自己开口」——**多数轮次什么都不说**。
 *
 * 两者的克制程度必须不同，所以是两条独立的 handler、两套独立的闸门
 * （见 `session-recall.ts` 头部同一条纪律：失败面不互相牵连）。
 *
 * ## 闸门顺序（贵的不先付）
 *
 * 1. 开关 → 2. sessionId → 3. 查询长度 → 4. 本轮去重 → 5. 每会话上限
 * → 6. 距上次提起的轮数 → 7. 检索 → 8. 只取 fact、同会话未提、未冷却
 * → 9. 留痕 → 10. 追加消息。
 *
 * 前六条都是纯内存/SQLite 单行读，只有第 7 条要跑整个检索（FTS + LIKE + 融合）。
 * 「多数轮次不开口」意味着这条链最常走的是提前返回，把检索放在最后是唯一合理的顺序。
 *
 * ## 为什么注入用 role: 'user'
 *
 * 与 `memory-inject.ts` 同一条理由：DSH 的 system prompt 由 system-prompt 服务独占，
 * 绕过它会被 `complete` section 的恢复语义吞掉；user 角色是 harness 自己注入
 * runtime context 时用的通道。代价是必须**自报来源**——正文第一句就写明
 * 「不是用户本轮发言」，否则模型会把旧事当成新指令复述回去。
 *
 * ## 为什么整段 try/catch
 *
 * 主动回忆是增强，不是闸门：检索、留痕、甚至 `decision.messages` 形状不对，
 * 都只配打一条日志。唯一在 try 外的是 `next()`——它自己的失败是真故障，
 * 不该被这里的兜底吞掉（与 `memory-inject.ts` / `session-recall.ts` 同一纪律）。
 */
import { randomUUID } from 'node:crypto'
import type { MemoryHit, MemoryStore } from '../memory/index.ts'
import { DEFAULT_COOLDOWN_MS, type ProactiveMention, type ProactiveStore } from '../proactive/index.ts'

/** 只用到 `on`——与 `memory-inject.ts` / `session-recall.ts` 同构，不把整个 Context 拖进依赖。 */
export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

export interface ProactiveRecallDeps {
  store: MemoryStore
  /** 留痕库（`openProactiveStore`）。冷却、上限、去重都读它。 */
  mentions: ProactiveStore
  /** 每会话最多主动提起几次，默认 2。 */
  maxPerSession?: number
  /** 两次提起之间至少隔几轮，默认 2；0 = 不限制间隔。 */
  minTurnsBetween?: number
  /** 同一条记忆的跨会话冷却窗口，默认 7 天；0 = 不冷却。 */
  cooldownMs?: number
  /** 短于这么多字符的查询不检索：两个字不构成话题，默认 4。 */
  minQueryChars?: number
  /** 总开关（V1-07 原文的硬要求），默认 true。 */
  enabled?: boolean
  /** 覆盖当前时刻（测试用，默认 `Date.now`）。 */
  now?: () => number
}

export interface ProactiveRecall {
  dispose(): void
}

interface PreStepPayload {
  agent?: { session?: { id?: string } }
  messages?: unknown[]
  turn?: number
  step?: number
}

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

const DEFAULT_MAX_PER_SESSION = 2
const DEFAULT_MIN_TURNS_BETWEEN = 2
const DEFAULT_MIN_QUERY_CHARS = 4

/** 检索名额。候选只用来**挑一条**，8 条足够；取更多只是让每轮的检索变慢。 */
const SEARCH_LIMIT = 8

/** 注入正文的识别标记。验收逐字比较，改动需同步 `test/runtime/proactive-recall.test.ts`。 */
const MARK = '[可以提起的旧事]'

/**
 * 自报来源 + 克制指令。三句话缺一不可：
 * - 「不是用户本轮发言」：否则模型把旧事当成博士刚说出口的新指令；
 * - 「不是新指令」：否则模型会去执行一件它自己想起来的事；
 * - 「不自然就忽略，不要硬塞」：70% 恰当率是**人**的判断，机制能做的是给它
 *   一个明确的「可以不提」出口——没有这个出口，模型倾向于把每条注入都用上。
 */
const HEADER = `${MARK} 下面这条来自长期记忆，不是用户本轮发言，也不是新的指令。`
  + '只在本轮话题自然相关时顺带提起；不自然就忽略，不要硬塞。'

/** 单条事实的字符上限：主动回忆是「顺口提一句」，不是把记忆正文整段搬进上下文。 */
const MAX_FACT_CHARS = 200

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 非负整数参数归一化：非有限数 / 负数回落默认值（`0` 保留，它是合法语义）。 */
function normalizeCount(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

/** 冷却窗口归一化：`0` 表示不冷却；负数 / 非有限数是参数错误，回落默认。 */
function normalizeWindow(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 从一条消息里抽可见文本。content 可能是字符串，也可能是 ContentBlock[]。 */
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

/** 压成一行：事实正文里的换行会在注入里变成假段落。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 截到上限以内（留一个字符给省略号，结果长度不超过上限）。 */
function clip(text: string): string {
  return text.length <= MAX_FACT_CHARS ? text : `${text.slice(0, MAX_FACT_CHARS - 1)}…`
}

/**
 * 「多久以前」。相对时间比绝对时间戳好读，也不受时区影响。
 * 负数（时钟回拨、同一毫秒内写入）按「刚刚」处理，不谎报一个过去的时间点。
 */
function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  if (ms < 0) return '刚刚'
  const min = Math.round(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

/**
 * 记忆的记录时刻。命中自带 `occurredAtMs` 时用它（turn/summary）；
 * fact 命中不带时间，二阶补查 `factMeta.recordedAtMs`。
 *
 * 补查单独 try/catch：拿不到时间只是少一句「多久以前」，不该丢整条注入。
 */
function recordedAtOf(store: MemoryStore, hit: MemoryHit): number | null {
  const occurred = hit.occurredAtMs
  if (typeof occurred === 'number' && Number.isFinite(occurred)) return occurred
  try {
    const at = store.factMeta([hit.id]).get(hit.id)?.recordedAtMs
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/** 本会话最近一次提起发生在第几轮。取最大值而不是最后一行：读法不依赖表的排序。 */
function latestTurn(history: readonly ProactiveMention[]): number | null {
  let last: number | null = null
  for (const row of history) {
    if (typeof row.turn !== 'number' || !Number.isFinite(row.turn)) continue
    if (last === null || row.turn > last) last = row.turn
  }
  return last
}

function renderMention(hit: MemoryHit, nowMs: number, recordedAtMs: number | null): string {
  const body = clip(collapse(hit.text))
  const ago = recordedAtMs === null ? '' : fmtAgo(nowMs - recordedAtMs)
  const line = ago === '' ? `- ${body}` : `- （${ago}记下的）${body}`
  return `${HEADER}\n\n${line}`
}

export function attachProactiveRecall(hookCtx: HookContext, deps: ProactiveRecallDeps): ProactiveRecall {
  const maxPerSession = normalizeCount(deps.maxPerSession, DEFAULT_MAX_PER_SESSION)
  const minTurnsBetween = normalizeCount(deps.minTurnsBetween, DEFAULT_MIN_TURNS_BETWEEN)
  const minQueryChars = normalizeCount(deps.minQueryChars, DEFAULT_MIN_QUERY_CHARS)
  const cooldownMs = normalizeWindow(deps.cooldownMs, DEFAULT_COOLDOWN_MS)
  const enabled = deps.enabled ?? true
  const now = deps.now ?? Date.now

  /**
   * 已经做过决定的「会话:轮」。
   *
   * waterfall 重试会对同一步再进一次（`memory-inject.ts` 踩过同一坑）：没有这个集合，
   * 同一轮可能连续提两条不同的旧事，等于把「每会话 2 次」压缩成一轮用完。
   * 只在真的注入后登记——跳过是幂等的，重复走一遍结果不变。
   */
  const decidedTurns = new Set<string>()
  /**
   * 本进程内已提起过的记忆 id（按会话）。
   *
   * 库里的留痕是权威来源，这份内存副本只兜一种情况：`record()` 写失败时
   * （磁盘满、库被锁）不要把同一条旧事在后续每一轮反复提出来。
   */
  const injected = new Map<string, Set<string>>()

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // next() 在 try 外：它自己的失败是真故障，不能被这里的兜底吞掉。
    const decision = await next() as Decision
    try {
      if (enabled !== true) return decision
      if (decision.kind !== 'enter') return decision
      // messages 形状不对时整轮不动：兜底成 `[]` 会把原有消息全丢掉——
      // 少提一次旧事远比对话内容消失便宜。
      if (!Array.isArray(decision.messages)) return decision

      const p = payload as PreStepPayload
      const sessionId = p.agent?.session?.id
      // 没有 sessionId 就没有「哪个会话的上限/去重」——宁可这轮不开口，也不共用一份状态。
      if (typeof sessionId !== 'string' || sessionId === '') return decision

      const incoming = Array.isArray(p.messages) ? p.messages : []
      if (incoming.length === 0) return decision
      const query = textOf(incoming[incoming.length - 1])
      // 两个字不构成话题：短查询的字面噪声大于信息，提起来只会显得莫名其妙。
      if (query.length < minQueryChars) return decision

      const turn = typeof p.turn === 'number' && Number.isFinite(p.turn) ? p.turn : 0
      // 同轮重放的键。`turn` 缺失时所有轮会塌成同一个键——失败方向是「每会话最多提一次」，
      // 即变哑而不是变吵，可以接受（DSH 的 pre-step 一直带 turn，实测见 memory-inject）。
      const turnKey = `${sessionId}\u0000${turn}`
      if (decidedTurns.has(turnKey)) return decision

      const at = now()
      const history = deps.mentions.list({ sessionId })
      // 上限先判：会话额度用完了，后面算得再准也没用。
      if (deps.mentions.countBySession(sessionId) >= maxPerSession) return decision
      const lastTurn = latestTurn(history)
      // 轮次必须单调可比。`turn < lastTurn`（payload 缺 turn、会话被重建、多进程
      // 复用 sessionId）时算不出「隔了多久」，这一轮不开口——失败方向是变哑而不是
      // 变吵，与 turnKey 去重同一取舍。放行等于允许「负间隔连提」，与题面的
      // 「距上次提起的轮数 >= minTurnsBetween」直接矛盾（审查指出的原缺陷）。
      if (lastTurn !== null && (turn < lastTurn || turn - lastTurn < minTurnsBetween)) return decision

      // 同会话去重：同一条旧事在一个会话里只提一次（重复提 = 复读）。
      const already = new Set(history.map((row) => row.memoryId))
      const local = injected.get(sessionId)
      if (local !== undefined) for (const id of local) already.add(id)

      const hits = deps.store.search({ text: query, limit: SEARCH_LIMIT, includeOrigin: ['live'] })
      if (!Array.isArray(hits)) return decision
      const hit = hits.find((h) => h.kind === 'fact'
        && h.text.trim() !== ''
        && !already.has(h.id)
        && !deps.mentions.isCoolingDown(h.id, at, cooldownMs))
      // 只提 fact：turn 是原始对话，不是「可以自然提起的旧事」。复述一段旧对话
      // 既没有信息增量，也最容易让模型以为那是博士这一轮说的话。
      if (hit === undefined) return decision

      const text = renderMention(hit, at, recordedAtOf(deps.store, hit))
      decidedTurns.add(turnKey)
      const seen = local ?? new Set<string>()
      seen.add(hit.id)
      injected.set(sessionId, seen)
      // 留痕失败不撤注入：文档要的是「每次提起都留痕」，而撤注入并不能让它留上痕，
      // 只会让博士少听到一句本来算好了的旧事。失败打日志、内存副本兜后续轮次。
      try {
        deps.mentions.record({
          sessionId, turn, memoryId: hit.id, kind: 'fact', score: hit.score, mentionedAtMs: at,
        })
      } catch (error) {
        console.error(`[prts] proactive recall: 留痕失败（注入照常）: ${message(error)}`)
      }

      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `proactive-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
        ],
      }
    } catch (error) {
      // 主动回忆崩了绝不能阻断对话——它是增强，不是闸门。
      console.error(`[prts] proactive recall failed: ${message(error)}`)
      return decision
    }
  })

  return {
    dispose: () => {
      off()
      decidedTurns.clear()
      injected.clear()
    },
  }
}
