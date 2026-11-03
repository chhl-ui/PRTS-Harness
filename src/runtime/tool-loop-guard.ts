/**
 * 工具循环检测（Super-agent 模块 5 缺的那一半）。
 *
 * `supervisor` 只答「进程活着吗」，不答「这活是不是在原地打转」。
 * 这里补的是后者：同一会话里连续 N 次「同一个工具 + 完全相同的参数」→ 判为疑似循环。
 *
 * ## 为什么第一版只标记、不自动停
 *
 * `docs/design-superagent-fusion.md` 第七节自己写了预测的失败模式：合理重试会被误报
 * （模型重试同一命令是因为第一次超时）。自动 `stop('S1')` 会 `cancelAllTurns`，
 * 一次误判就把一整轮对话杀掉。所以第一版只产出 verdict 与日志，停机权留在上层——
 * 等有真实误报率数据再谈自动动作。
 *
 * ## 分桶纪律
 *
 * 计数器必须按 `sessionId` 分桶。并发子会话各自的重试若并进同一个计数，
 * 两个会话各调 3 次就会凑出 6 次误报（议事会提过这个风险，成立）。
 * `tools/result` 的 execution 带 `agent.session.id`，归属拿得到。
 */
import { createHash } from 'node:crypto'

export interface LoopGuardDeps {
  /** 连续多少次完全相同才算可疑，默认 5。低于 2 没有意义（2 次相同是常态）。 */
  threshold?: number
  /** 判定成立时的回调。想接审计用 `attachToolLoopAudit`，不必直接传这个。 */
  onSuspect?: (e: SuspectEvent) => void
}

export interface LoopObservation {
  sessionId: string
  toolName: string
  /** 工具的已解析参数（`ToolExecution.arguments`）。 */
  args: unknown
}

/**
 * 判定为疑似循环时往外抛的事件。
 *
 * 字段名与 `AuditEvent` 的 `tool.loop.suspected` 一致（用 `tool` 而不是 `toolName`），
 * 这样它可以直接交给审计 sink，不需要在两层之间做一次映射——映射层是最容易漏字段的地方。
 */
export interface SuspectEvent {
  kind: 'tool.loop.suspected'
  sessionId: string
  tool: string
  /** 阈值那一次的连续次数。事后能看出是「第 3 次就报了」还是「跑到第 9 次才报」。 */
  count: number
  fingerprint: string
}

export type LoopVerdict =
  | { kind: 'ok'; count: number }
  | { kind: 'suspect'; count: number; fingerprint: string }

/**
 * 参数指纹：递归排序对象键后再序列化。
 *
 * 直接 `JSON.stringify` 不够——模型两次生成的对象键序可以不同（`{a,b}` vs `{b,a}`），
 * 语义相同却算两个指纹，检测就失效了。数组顺序**保留**：`[1,2]` 与 `[2,1]` 是不同参数。
 */
export function fingerprintArgs(args: unknown): string {
  const seen = new WeakSet<object>()
  const canon = (value: unknown): unknown => {
    if (value === null || typeof value !== 'object') {
      // undefined / function / symbol 不是合法 JSON，统一成 null，避免它们让指纹漂移。
      return typeof value === 'function' || typeof value === 'undefined' || typeof value === 'symbol'
        ? null
        : value
    }
    if (seen.has(value as object)) return '[circular]'
    seen.add(value as object)
    if (Array.isArray(value)) return value.map(canon)
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canon(v)] as const)
    return Object.fromEntries(entries)
  }
  return createHash('sha256').update(JSON.stringify(canon(args)) ?? 'null').digest('hex').slice(0, 16)
}

export class ToolLoopGuard {
  private readonly threshold: number
  /** sessionId → 上一个指纹与已连续次数。只留最近一次，历史不需要。 */
  private readonly state = new Map<string, { fingerprint: string; count: number }>()
  /** 疑似循环的订阅者。判定与消费分离：guard 不知道审计、日志或停止权存在。 */
  private readonly listeners = new Set<(e: SuspectEvent) => void>()

  constructor(deps: LoopGuardDeps = {}) {
    const t = deps.threshold ?? 5
    this.threshold = Number.isFinite(t) && t >= 2 ? Math.floor(t) : 5
    if (deps.onSuspect !== undefined) this.listeners.add(deps.onSuspect)
  }

  /** 订阅疑似循环事件，返回解除函数（幂等）。 */
  subscribe(fn: (e: SuspectEvent) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  observe(o: LoopObservation): LoopVerdict {
    const fingerprint = `${o.toolName}:${fingerprintArgs(o.args)}`
    const prev = this.state.get(o.sessionId)
    const count = prev !== undefined && prev.fingerprint === fingerprint ? prev.count + 1 : 1
    this.state.set(o.sessionId, { fingerprint, count })
    if (count < this.threshold) return { kind: 'ok', count }
    const event: SuspectEvent = {
      kind: 'tool.loop.suspected',
      sessionId: o.sessionId,
      tool: o.toolName,
      count,
      fingerprint,
    }
    for (const fn of this.listeners) {
      // 订阅者（审计 / 日志）失败不得改变判定结果，也不得让 observe 抛错——
      // 观测是增强，不是闸门。
      try { fn(event) } catch { /* 忽略：判定照常返回 */ }
    }
    return { kind: 'suspect', count, fingerprint }
  }

  /** 清掉某会话（或全部）的计数。会话结束、工具集变化后不该沿用旧计数。 */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.state.clear()
    else this.state.delete(sessionId)
  }
}
