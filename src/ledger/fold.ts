import type { DatabaseSync } from 'node:sqlite'
import type { LedgerEventRow } from './types.ts'

interface TaskRow {
  task_id: string
  revision: number
  phase: string
  blocked_json: string | null
  usage_json: string
  budget_json: string
  resume_json: string
}

interface StepRow {
  step_no: number
  status: string
  output_ref: string | null
}

export interface UsageShape {
  costUsd: number
  rounds: number
  ms: number
}

export interface BudgetShape {
  maxCostUsd?: number
  maxRounds?: number
  maxMs?: number
}

/**
 * 共享预算判定（fold 阻塞决策与 Ledger 的 resume/unblock 前置检查同一函数）：
 * 返回超限字段的描述列表，空数组即未超限。严格大于才计为超出。
 */
export function usageExceeded(usage: UsageShape, budget: BudgetShape): string[] {
  const exceeded: string[] = []
  if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) {
    exceeded.push(`costUsd ${usage.costUsd} > maxCostUsd ${budget.maxCostUsd}`)
  }
  if (budget.maxRounds !== undefined && usage.rounds > budget.maxRounds) {
    exceeded.push(`rounds ${usage.rounds} > maxRounds ${budget.maxRounds}`)
  }
  if (budget.maxMs !== undefined && usage.ms > budget.maxMs) {
    exceeded.push(`ms ${usage.ms} > maxMs ${budget.maxMs}`)
  }
  return exceeded
}

/**
 * 唯一的投影更新函数：tasks / task_steps / evidence 只能经这里写。
 * 增量路径（每个事务里）与 rebuildProjections（按 seq 重放）调用同一个函数，
 * 因此投影是事件序列的纯函数。
 */
export function applyEvent(db: DatabaseSync, e: LedgerEventRow): void {
  const taskRow = (): TaskRow | undefined =>
    db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(e.task_id) as TaskRow | undefined

  const setPhase = (phase: string, blockedJson: string | null = null): void => {
    db.prepare('UPDATE tasks SET phase = ?, blocked_json = ? WHERE task_id = ?')
      .run(phase, blockedJson, e.task_id)
  }

  switch (e.kind) {
    case 'task.created': {
      const p = e.payload as { title: string; objective: string; acceptance: unknown; budget: unknown }
      db.prepare(
        `INSERT INTO tasks (
           task_id, revision, title, objective, phase, blocked_json, last_rejection,
           acceptance_json, budget_json, usage_json, resume_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      ).run(
        e.task_id,
        e.revision,
        p.title,
        p.objective,
        JSON.stringify(p.acceptance),
        JSON.stringify(p.budget ?? {}),
        JSON.stringify({ costUsd: 0, rounds: 0, ms: 0 }),
        JSON.stringify({ lastCompletedStep: null, next: null, open: [] }),
        e.ts,
        e.ts,
      )
      return // created_at/updated_at/revision 已在插入时写好
    }

    case 'task.activated':
      setPhase('active')
      break
    case 'task.paused':
      setPhase('paused')
      break
    case 'task.resumed':
      setPhase('active')
      break
    case 'task.blocked': {
      const p = e.payload as { code: string; message: string }
      setPhase('blocked', JSON.stringify({ code: p.code, message: p.message, by: e.actor.kind }))
      break
    }
    case 'task.unblocked':
      setPhase('active')
      break
    case 'task.done-claimed':
      setPhase('verifying')
      break
    case 'task.owner-accepted':
      setPhase('done')
      break
    case 'task.cancelled':
      setPhase('cancelled')
      break
    case 'task.stopped':
      setPhase('stopped-by-owner')
      break
    case 'task.resumed-from-stop':
      setPhase('paused')
      break

    case 'task.verified': {
      const p = e.payload as { ok: boolean; rejection: string | null }
      if (p.ok) {
        setPhase('done')
      } else {
        db.prepare('UPDATE tasks SET phase = ?, blocked_json = NULL, last_rejection = ? WHERE task_id = ?')
          .run('active', p.rejection ?? '', e.task_id)
      }
      break
    }
    case 'task.owner-rejected': {
      const p = e.payload as { reason: string }
      db.prepare('UPDATE tasks SET phase = ?, blocked_json = NULL, last_rejection = ? WHERE task_id = ?')
        .run('active', p.reason, e.task_id)
      break
    }
    case 'task.noted':
      break
    case 'task.resume-set': {
      const p = e.payload as { next: string | null; open: string[] }
      const row = taskRow()
      const resume = JSON.parse(row?.resume_json ?? '{}') as {
        lastCompletedStep: number | null
        next: string | null
        open: string[]
      }
      resume.next = p.next
      resume.open = p.open
      db.prepare('UPDATE tasks SET resume_json = ? WHERE task_id = ?')
        .run(JSON.stringify(resume), e.task_id)
      break
    }

    case 'step.begun': {
      const p = e.payload as { stepNo: number; name: string; idempotent: boolean; toolCallRef?: string }
      db.prepare(
        `INSERT INTO task_steps (task_id, step_no, name, idempotent, status, tool_call_ref, output_ref)
         VALUES (?, ?, ?, ?, 'started', ?, NULL)`,
      ).run(e.task_id, p.stepNo, p.name, p.idempotent ? 1 : 0, p.toolCallRef ?? null)
      break
    }
    case 'step.retried': {
      const p = e.payload as { stepNo: number }
      db.prepare("UPDATE task_steps SET status = 'started' WHERE task_id = ? AND step_no = ?")
        .run(e.task_id, p.stepNo)
      break
    }
    case 'step.recovered': {
      const p = e.payload as { stepNo: number }
      db.prepare("UPDATE task_steps SET status = 'unknown' WHERE task_id = ? AND step_no = ?")
        .run(e.task_id, p.stepNo)
      break
    }
    case 'step.ended': {
      const p = e.payload as { stepNo: number; status: 'succeeded' | 'failed'; outputRef?: string }
      db.prepare('UPDATE task_steps SET status = ?, output_ref = ? WHERE task_id = ? AND step_no = ?')
        .run(p.status, p.outputRef ?? null, e.task_id, p.stepNo)
      if (p.status === 'succeeded') {
        const row = taskRow()
        const resume = JSON.parse(row?.resume_json ?? '{}') as {
          lastCompletedStep: number | null
          next: string | null
          open: string[]
        }
        if (resume.lastCompletedStep === null || p.stepNo > resume.lastCompletedStep) {
          resume.lastCompletedStep = p.stepNo
          db.prepare('UPDATE tasks SET resume_json = ? WHERE task_id = ?')
            .run(JSON.stringify(resume), e.task_id)
        }
      }
      break
    }

    case 'evidence.added': {
      const p = e.payload as { artifactPath: string; sha256: string; producedBy: string }
      db.prepare(
        `INSERT INTO evidence (task_id, artifact_path, sha256, produced_by, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(e.task_id, p.artifactPath, p.sha256, p.producedBy, e.ts)
      break
    }

    case 'usage.charged': {
      const p = e.payload as { delta: { costUsd?: number; rounds?: number; ms?: number } }
      const row = taskRow()
      if (!row) break
      const usage = JSON.parse(row.usage_json) as UsageShape
      usage.costUsd += p.delta.costUsd ?? 0
      usage.rounds += p.delta.rounds ?? 0
      usage.ms += p.delta.ms ?? 0
      db.prepare('UPDATE tasks SET usage_json = ? WHERE task_id = ?')
        .run(JSON.stringify(usage), e.task_id)

      const budget = JSON.parse(row.budget_json) as BudgetShape
      const exceeded = usageExceeded(usage, budget)
      if (exceeded.length > 0 && row.phase === 'active') {
        setPhase('blocked', JSON.stringify({
          code: 'budget-exceeded',
          message: `budget exceeded: ${exceeded.join('; ')}`,
          by: e.actor.kind,
        }))
      }
      break
    }

    case 'task.budget-set': {
      const p = e.payload as { budget: unknown }
      db.prepare('UPDATE tasks SET budget_json = ? WHERE task_id = ?')
        .run(JSON.stringify(p.budget ?? {}), e.task_id)
      break
    }

    default:
      throw new Error(`unknown ledger event kind: ${e.kind}`)
  }

  // 统一规则：每条事件把任务的 revision 推进一格、updated_at 记为事件时间。
  db.prepare('UPDATE tasks SET revision = ?, updated_at = ? WHERE task_id = ?')
    .run(e.revision, e.ts, e.task_id)
}
