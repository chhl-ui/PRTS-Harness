/**
 * 把压缩决策接到 `agent/pre-step`：**只观测与记录，不改压缩行为**。
 *
 * 为什么要有这一层：DSH 的 `compactIfNeeded` 在 `requestHeader` / `routedTarget`
 * 为空时静默 `return null`（`dsh-compaction-basic/lib/index.js:932-935`）——既不压缩
 * 也不报告。PRTS 的取向是「信息不足必须可见」（`compaction-policy.ts` 头注释），
 * 所以这里把同一时刻的决策写下来：`compact` 而实际没压，就是那处静默跳过的指纹。
 *
 * 为什么用模型真实窗口而不是 `DSH_CONTEXT_WINDOW`：后者是**注入预算**的配置窗口
 * （`start.ts` 的 `resolveTokenBudget` 入参，默认 1000000），不是模型能力。
 * 拿它判压缩等于假设窗口无限，正是 `dsh-compaction-basic` 拿不到上下文容量时的
 * 那个毛病。真实窗口只能由 adapter 提供，因此必须异步取，且按会话取。
 *
 * 三条纪律（与 `memory-inject` / `assembly` 同源）：
 * - 观测失败不阻断回合：任何异常都退回未改动的 decision。
 * - `reject` 的回合不记录：没有装配就没有压缩可谈。
 * - `record` 抛错只吞掉：观测不该拖垮对话。
 */
import { decideCompaction } from './compaction-policy.ts'
import type { CompactionDecision } from './compaction-policy.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

/** 决策所需的四项配置，由装配层给出——本模块不持有默认值。 */
export interface CompactionPolicyConfig {
  /** 窗口的多少比例算超限。 */
  thresholdRatio: number
  /** 给模型生成回答留的空间。 */
  outputReserve: number
  /** token 估算偏差的缓冲。 */
  safetyMargin: number
  /** 总开关；`false` 时决策恒为 `skip` / `disabled`。 */
  enabled: boolean
}

/** 一次决策的落账形态。`reason` 只在非 `compact` 时出现。 */
export interface CompactionPolicyRecord {
  action: CompactionDecision['action']
  reason?: string
  usedTokens?: number
  contextWindow?: number
  sessionId: string
  turn: number
}

export interface CompactionPolicyDeps {
  config: CompactionPolicyConfig
  /** 读本会话已用 token；抛错或返回非法值会被 `decideCompaction` 当作「未知」处理。 */
  measure: (agent: unknown) => number | undefined
  /** 读模型真实窗口；抛错按「未知」（→ `capacity-unknown`），不炸回合。 */
  resolveWindow: (agent: unknown) => Promise<number | undefined>
  /** 记录决策；抛错被吞掉。 */
  record: (row: CompactionPolicyRecord) => void
}

export interface CompactionPolicy {
  dispose(): void
}

/** 从 session 上取请求头；缺失或抛错都返回 undefined。 */
function headerOf(session: unknown): unknown {
  try {
    return (session as { requestHeader?: () => unknown } | undefined)?.requestHeader?.()
  } catch {
    return undefined
  }
}

export function attachCompactionPolicy(hookCtx: HookContext, deps: CompactionPolicyDeps): CompactionPolicy {
  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    try {
      if (decision === null || decision.kind !== 'enter') return decision
      const p = payload as { agent?: { session?: { id?: string } }; turn?: number }
      const agent = (payload as { agent?: unknown }).agent
      const session = p?.agent?.session
      const sessionId = session?.id ?? ''
      const turn = typeof p?.turn === 'number' ? p.turn : -1

      // 请求头缺失时**不**去问窗口：DSH 也是先看它。这里保持一致，
      // 让「拿不到请求头」如实落成 capacity-unknown，而不是拿配置窗口顶替。
      const header = headerOf(session)
      let contextWindow: number | undefined
      if (header !== undefined) {
        try {
          contextWindow = await deps.resolveWindow(agent)
        } catch {
          contextWindow = undefined
        }
      }

      let usedTokens: number | undefined
      try {
        usedTokens = deps.measure(agent)
      } catch {
        usedTokens = undefined
      }

      const d = decideCompaction({
        // undefined 交给 decideCompaction 的「未知」分支（usedTokens 声明为 number，
        // 这里显式转成 NaN 表达「读不到」，与它的 usedTokensOr 约定一致）。
        usedTokens: usedTokens === undefined ? Number.NaN : usedTokens,
        contextWindow: contextWindow ?? null,
        thresholdRatio: deps.config.thresholdRatio,
        outputReserve: deps.config.outputReserve,
        safetyMargin: deps.config.safetyMargin,
        enabled: deps.config.enabled,
      })

      try {
        deps.record({
          action: d.action,
          ...(d.action === 'compact' ? {} : { reason: d.reason }),
          ...(usedTokens === undefined ? {} : { usedTokens }),
          ...(contextWindow === undefined ? {} : { contextWindow }),
          sessionId,
          turn,
        })
      } catch { /* 观测失败不阻断装配 */ }
    } catch { /* 决策失败不得改变本轮回合 */ }
    return decision
  })

  return { dispose: off }
}
