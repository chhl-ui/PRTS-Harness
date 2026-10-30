/** 运行时完整停机钩子：经 ctx.get 取 agents/jobs，错误聚合抛给 StopController 记 failures。 */
import type { Context } from '@deepseek-ai/cordis'

interface AgentLike { cancel(cause: { kind: 'user' } | { kind: 'disposed' } | string, options?: unknown): void }
interface AgentsSvc { list(): AgentLike[] }
interface JobsSvc {
  list(caller?: unknown): { id: string }[]
  kill(id: string, caller?: unknown, reason?: string): 'requested' | 'already-finished'
}

export function createStopHooks(ctx: Context): {
  stopSpeech(): Promise<void>
  cancelAllTurns(): Promise<void>
  killAllJobs(): Promise<void>
} {
  return {
    async stopSpeech() { /* v1 无语音面 */ },
    async cancelAllTurns() {
      const agents = ctx.get('agents') as AgentsSvc | undefined
      if (!agents) throw new Error('stop-hooks: ctx.agents service not mounted')
      const errors: unknown[] = []
      for (const a of agents.list()) {
        try { a.cancel({ kind: 'user' }) } catch (e) { errors.push(e) }
      }
      if (errors.length) throw new AggregateError(errors, `cancelAllTurns: ${errors.length} agent cancel(s) failed`)
    },
    async killAllJobs() {
      const jobs = ctx.get('jobs') as JobsSvc | undefined
      if (!jobs) throw new Error('stop-hooks: ctx.jobs service not mounted')
      const errors: unknown[] = []
      for (const j of jobs.list()) {
        try { jobs.kill(j.id, undefined, 'prts stop') } catch (e) { errors.push(e) }
      }
      if (errors.length) throw new AggregateError(errors, `killAllJobs: ${errors.length} job kill(s) failed`)
    },
  }
}
