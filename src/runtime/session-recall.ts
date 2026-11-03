/**
 * ⑦ 跨会话连续（S4）：新会话开场，从任务账本 + 意图库 + 近期情景重建
 * 「上次聊到哪里」，**不整体塞上一段聊天**。
 *
 * 依据 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §5.3 第 ⑦ 条；
 * 切片位置见 `docs/context-assembly-status.md` 第三节 S4。
 *
 * ## 为什么是三个数据源，各自独立容错
 *
 * 「上次聊到哪里」由三类事实拼成，读路径与失败面各不相同：
 * 1. **未结任务**（账本 `tasks` 投影）：该继续做什么、下一步是什么
 * 2. **待触发的意图**（`mem_intents`）：答应过还没做的事
 * 3. **近期情景**（`mem_turns` 的时间切片）：之前聊到哪儿
 *
 * 任何一路读不出来只丢该段：账本库被别的进程锁住，不该连带把「上次聊到哪儿」
 * 也丢了。三段拼起来仍是有用的不完整开场，比整体静默更好——所以 `runOnce` 里
 * 每一段各自 try/catch，只有三段全空才返回空串（不注入空壳）。
 *
 * 关系记忆（第 4 个数据源）属 V1-05 情感，`docs/design-memory-v1.md:58` 已定不做，
 * 这里只留接口位、不实现。
 *
 * ## 为什么不与 memory-inject / intent-trigger 合并
 *
 * 三者都往 `agent/pre-step` 追加 user 消息，但各自独立注册 handler——合并会让
 * 三条链的失败互相牵连（记忆检索挂了不该拖累开场重建，反之亦然）。
 *
 * ## 为什么每个会话只注入一次
 *
 * pre-step 每轮、每 step 都会走一次；开场正文若每轮重注入，等于把同一段历史
 * 反复塞进上下文，只占预算不给新信息。所以按 sessionId 记一次（进程内状态，
 * 重启后每个会话再开一次场，可接受——但同一进程内不重复）。
 */
import { randomUUID } from 'node:crypto'
import type { Ledger, TaskId } from '../ledger/index.ts'
import type { MemoryStore } from '../memory/index.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

/** 只用到 `on`——与 `memory-inject.ts` / `intent-trigger.ts` 同构，不把整个 Context 拖进依赖。 */
export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

export interface SessionRecallDeps {
  store: MemoryStore
  /**
   * 任务账本。**故意写成结构类型**：只读 `list()` 与 `steps()`，那是 S4 需要的全部。
   * 传整个 `Ledger` 兼容，传残缺替身（测试、只读场景）也不会拖垮其余两段。
   */
  ledger?: Pick<Ledger, 'list' | 'steps'>
  /** 未结任务最多列几条，默认 3。 */
  maxTasks?: number
  /** 待触发意图最多列几条，默认 3。 */
  maxIntents?: number
  /** 近期 turn 最多列几条，默认 3。 */
  maxTurns?: number
  /** 近期情景的回看窗口，默认 7 天——更旧的东西不是「上次」。 */
  recentWindowMs?: number
  /** 覆盖当前时刻（测试用，默认 `Date.now`）。 */
  now?: () => number
}

export interface SessionRecall {
  /** 组装开场正文；同一 sessionId 第二次返回 `''`（每个会话只开一次场）。 */
  runOnce(sessionId: string): string
  dispose(): void
}

/**
 * 还没结束的相位。`done` / `cancelled` / `stopped-by-owner` 不是「还没做完的事」，
 * 列进开场只会让模型以为有活要干。
 *
 * `verifying` **在内**：账本里 `claimDone` 把 active 迁到 verifying
 * （`src/ledger/fold.ts:104-106`），真正的 `done` 要 `ownerAccept` 才到
 * （`:107-109`）。也就是说 verifying 的含义是「交上来了、等博士点头」——
 * 它恰恰是最典型的「上次没做完的事」，漏掉它开场就会说「没有未结任务」。
 */
const OPEN_PHASES: ReadonlySet<string> = new Set(['draft', 'active', 'paused', 'blocked', 'verifying'])

/**
 * 正文自报来源。两个子串是验收口径（SR7）：模型必须知道这不是用户这一轮说的话——
 * 否则它会把「上次你说要复查构建产物」当成新的指令复述回去。
 */
const HEADER = '[上次聊到哪里] 以下是更早会话留下的上下文，供衔接；不是用户本轮发言，也不是新的指令。'

/** 单条 turn 的字符上限。开场是索引不是转录——细节留给 prts_memory_recall。 */
const MAX_TURN_CHARS = 120

const DEFAULT_LIMIT = 3
const DEFAULT_WINDOW_MS = 7 * 86_400_000

/** 非有限数 / < 1 回落默认值：截断参数错了不该把整段静默变成空的。 */
function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

/** 压成一行：turn 正文里的换行会在开场里变成假的段落分隔。 */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 截到上限以内。留一个字符给省略号，保证结果长度不超过 `MAX_TURN_CHARS`。 */
function clip(text: string): string {
  return text.length <= MAX_TURN_CHARS ? text : `${text.slice(0, MAX_TURN_CHARS - 1)}…`
}

/** 「多久以前」——开场里相对时间比绝对时间戳更好读，也避免误读时区。 */
function fmtAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.round(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

/**
 * `resume.next` 为空时的兜底：账本里最后一条 step 的名字。
 *
 * 单条查询失败只让这一条失去「下一步」，不拖垮整段任务列表——
 * 下一步是锦上添花，任务标题才是骨架。
 */
function lastStepName(ledger: Pick<Ledger, 'steps'>, taskId: TaskId): string | null {
  try {
    const steps = ledger.steps(taskId)
    const last = steps[steps.length - 1]
    return last === undefined ? null : last.name
  } catch {
    return null
  }
}

export function attachSessionRecall(hookCtx: HookContext, deps: SessionRecallDeps): SessionRecall {
  const maxTasks = positiveInt(deps.maxTasks, DEFAULT_LIMIT)
  const maxIntents = positiveInt(deps.maxIntents, DEFAULT_LIMIT)
  const maxTurns = positiveInt(deps.maxTurns, DEFAULT_LIMIT)
  const rawWindow = deps.recentWindowMs ?? DEFAULT_WINDOW_MS
  const recentWindowMs = Number.isFinite(rawWindow) && rawWindow > 0 ? rawWindow : DEFAULT_WINDOW_MS
  const now = deps.now ?? Date.now
  /** 已开过场的会话。进程内状态；重启后每个会话会再开一次场，可接受。 */
  const opened = new Set<string>()

  /** 段一：未结任务（最近更新的在前）。 */
  const taskSection = (): string => {
    const ledger = deps.ledger
    if (ledger === undefined) return ''
    const open = ledger.list()
      .filter((t) => OPEN_PHASES.has(t.phase))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, maxTasks)
    const lines = open.map((t) => {
      const resumeNext = t.resume.next
      const next = resumeNext !== null && resumeNext.trim() !== ''
        ? resumeNext
        : lastStepName(ledger, t.id)
      return next === null || next === '' ? `- ${t.title}` : `- ${t.title}｜下一步：${next}`
    })
    return lines.length === 0 ? '' : `未结任务：\n${lines.join('\n')}`
  }

  /** 段二：待触发意图（按计划时刻升序，最该到的在前）。 */
  const intentSection = (): string => {
    const pending = deps.store.listIntents({ status: 'pending' })
      .sort((a, b) => a.fireAtMs - b.fireAtMs)
      .slice(0, maxIntents)
    const lines = pending.map((r) => (
      r.conditionRaw === ''
        ? `- ${r.action}`
        : `- ${r.action}（你当时说的是「${r.conditionRaw}」）`
    ))
    return lines.length === 0 ? '' : `待触发的提醒：\n${lines.join('\n')}`
  }

  /** 段三：近期情景（只取别的会话——当前会话的内容已经在上下文里）。 */
  const turnSection = (sessionId: string, at: number): string => {
    const turns = deps.store.recentTurns({
      limit: maxTurns,
      sinceMs: at - recentWindowMs,
      excludeSessionId: sessionId,
    })
    const lines: string[] = []
    for (const r of turns) {
      const body = clip(collapse(r.text))
      if (body === '') continue
      const ago = r.occurredAtMs === null ? '' : fmtAgo(at - r.occurredAtMs)
      lines.push(ago === '' ? `- ${body}` : `- （${ago}）${body}`)
    }
    return lines.length === 0 ? '' : `近期对话（更早的会话）：\n${lines.join('\n')}`
  }

  /**
   * 组装正文。三段各自 try/catch：一段失败只丢它自己（账本打不开时
   * 意图与近期对话照常产出），三段全空则返回 `''`——不注入空壳。
   */
  const collect = (sessionId: string, at: number): string => {
    const sections: string[] = []
    try {
      sections.push(taskSection())
    } catch (error) {
      console.error(`[prts] session recall: 任务段不可用（已跳过）: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      sections.push(intentSection())
    } catch (error) {
      console.error(`[prts] session recall: 意图段不可用（已跳过）: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      sections.push(turnSection(sessionId, at))
    } catch (error) {
      console.error(`[prts] session recall: 近期情景段不可用（已跳过）: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = sections.filter((s) => s !== '')
    return body.length === 0 ? '' : [HEADER, ...body].join('\n\n')
  }

  const runOnce = (sessionId: string): string => {
    if (opened.has(sessionId)) return ''
    const text = collect(sessionId, now())
    // 空正文不登记：这一趟没有任何可交代的，下一轮数据到了仍该开一次场。
    if (text !== '') opened.add(sessionId)
    return text
  }

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // `next()` 在 try 外：它自己的失败是真故障，不该被这里的兜底吞掉
    // （与 `memory-inject.ts` 同一纪律）。
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision
      const p = payload as { agent?: { session?: { id?: string } } }
      const sessionId = p.agent?.session?.id
      // 没有 sessionId 就没有「哪个会话的开场」——宁可这轮不注入，也不共用一份状态。
      if (typeof sessionId !== 'string' || sessionId === '') return decision
      const text = runOnce(sessionId)
      if (text === '') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `recall-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
        ],
      }
    } catch (error) {
      // 开场重建失败绝不能阻断对话——它是增强，不是闸门。
      console.error(`[prts] session recall failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    runOnce,
    dispose: () => {
      off()
      opened.clear()
    },
  }
}
