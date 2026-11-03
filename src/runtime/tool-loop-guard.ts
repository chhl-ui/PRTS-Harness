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
}

export interface LoopObservation {
  sessionId: string
  toolName: string
  /** 工具的已解析参数（`ToolExecution.arguments`）。 */
  args: unknown
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

  constructor(deps: LoopGuardDeps = {}) {
    const t = deps.threshold ?? 5
    this.threshold = Number.isFinite(t) && t >= 2 ? Math.floor(t) : 5
  }

  observe(o: LoopObservation): LoopVerdict {
    const fingerprint = `${o.toolName}:${fingerprintArgs(o.args)}`
    const prev = this.state.get(o.sessionId)
    const count = prev !== undefined && prev.fingerprint === fingerprint ? prev.count + 1 : 1
    this.state.set(o.sessionId, { fingerprint, count })
    return count >= this.threshold
      ? { kind: 'suspect', count, fingerprint }
      : { kind: 'ok', count }
  }

  /** 清掉某会话（或全部）的计数。会话结束、工具集变化后不该沿用旧计数。 */
  reset(sessionId?: string): void {
    if (sessionId === undefined) this.state.clear()
    else this.state.delete(sessionId)
  }
}
