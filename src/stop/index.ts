/** K3 停止权（运行时侧，DSH 无关）。`runtime-control.ts` 为控制管道客户端，须先于任何子进程派生调用。 */
import type { Ledger } from '../ledger/index.ts'
import type { AuditLog, AuditActor } from '../audit/index.ts'

export { connectControl } from './runtime-control.ts'
export type { RuntimeStopLevel } from './runtime-control.ts'

export type StopLevel = 'S0' | 'S1' | 'S2'

export interface StopHooks {
  stopSpeech(): Promise<void>          // S0
  cancelAllTurns(): Promise<void>      // S1、S2
  killAllJobs(): Promise<void>         // S2
}

export interface StopReport {
  level: StopLevel
  durationMs: number
  stoppedTasks: string[]
  failures: { step: string; error: string }[]
}

const STOP_ACTOR: AuditActor = { kind: 'system', component: 'stop' }

/**
 * 分级停止：S0 打断播报；S1 取消全部轮次；S2 取消轮次+杀作业+账本任务转 stopped-by-owner。
 * hook 抛错记 failures 并继续；账本停止不依赖 hook 成败。
 * 不做超时升级——超时升级由进程外守护进程负责。
 */
export class StopController {
  private readonly hooks: StopHooks
  private readonly ledger: Ledger
  private readonly audit: AuditLog
  private readonly now: () => number

  constructor(deps: { hooks: StopHooks; ledger: Ledger; audit: AuditLog; now?: () => number }) {
    this.hooks = deps.hooks
    this.ledger = deps.ledger
    this.audit = deps.audit
    this.now = deps.now ?? (() => Date.now())
  }

  async stop(level: StopLevel): Promise<StopReport> {
    const t0 = this.now()
    this.audit.append(STOP_ACTOR, { kind: 'stop.requested', level })
    const failures: { step: string; error: string }[] = []
    const run = async (step: string, fn: () => Promise<void>) => {
      try { await fn() } catch (e) {
        failures.push({ step, error: e instanceof Error ? e.message : String(e) })
      }
    }
    if (level === 'S0') await run('stopSpeech', () => this.hooks.stopSpeech())
    if (level === 'S1' || level === 'S2') {
      await run('cancelAllTurns', () => this.hooks.cancelAllTurns())
    }
    if (level === 'S2') {
      await run('killAllJobs', () => this.hooks.killAllJobs())
    }
    // 账本停止：非终态且未 stopped 的全部任务（不依赖上面 hook 成败）
    const stoppedTasks: string[] = []
    if (level === 'S2') {
      for (const t of this.ledger.list()) {
        if (t.phase === 'done' || t.phase === 'cancelled' || t.phase === 'stopped-by-owner') continue
        try {
          const r = this.ledger.stopByOwner(t.id)
          if (r) stoppedTasks.push(String(t.id))
        } catch (e) {
          failures.push({ step: 'stopByOwner', error: e instanceof Error ? e.message : String(e) })
        }
      }
    }
    const durationMs = this.now() - t0
    this.audit.append(STOP_ACTOR, { kind: 'stop.completed', level, durationMs })
    return { level, durationMs, stoppedTasks, failures }
  }
}
