/**
 * 技能库的投影器：**唯一**允许写 `skills` 表的入口。
 *
 * 纪律与 `ledger/fold.ts`、`memory/fold.ts` 相同：投影只能由事件重放得到，
 * 任何绕过这里的写入都会在 `rebuildProjections` 之后消失。
 *
 * `default` 分支必须抛错——`memory/fold.ts` 踩过这个坑：新增事件种类忘了接，
 * 事件在同一事务里抛错回滚，外层 catch 把它连同正常结果一起吞掉，
 * 症状是「写成功了但没生效」而不是报错。
 */
import type { DatabaseSync } from 'node:sqlite'
import { raise } from '../ledger/errors.ts'
import type { SkillActor, SkillEvaluation, SkillEventKind, SkillProposal } from './types.ts'

export interface SkillEventInput {
  skill_id: string
  revision: number
  kind: SkillEventKind | string
  actor: SkillActor
  payload: unknown
  ts: number
}

interface ProjectionRow {
  skill_id: string
  revision: number
  phase: string
  evaluations_json: string
}

function requireRow(db: DatabaseSync, skillId: string): ProjectionRow {
  const row = db.prepare('SELECT skill_id, revision, phase, evaluations_json FROM skills WHERE skill_id = ?')
    .get(skillId) as ProjectionRow | undefined
  if (row === undefined) raise('NOT_FOUND', `skill ${skillId} not found`)
  return row
}

function setPhase(db: DatabaseSync, e: SkillEventInput, phase: string, retireReason: string | null): void {
  db.prepare('UPDATE skills SET revision = ?, phase = ?, retire_reason = ?, updated_at = ? WHERE skill_id = ?')
    .run(e.revision, phase, retireReason, e.ts, e.skill_id)
}

export function applySkillEvent(db: DatabaseSync, e: SkillEventInput): void {
  switch (e.kind) {
    case 'skill.proposed': {
      const p = e.payload as SkillProposal
      db.prepare(
        `INSERT INTO skills
           (skill_id, revision, phase, title, trigger_text, steps_json, pitfalls_json,
            source_refs_json, proposed_by_json, evaluations_json, retire_reason, created_at, updated_at)
         VALUES (?, ?, 'candidate', ?, ?, ?, ?, ?, ?, '[]', NULL, ?, ?)`,
      ).run(
        e.skill_id, e.revision, p.title, p.trigger,
        JSON.stringify(p.steps), JSON.stringify(p.pitfalls ?? []), JSON.stringify(p.sourceRefs ?? []),
        JSON.stringify(e.actor), e.ts, e.ts,
      )
      break
    }

    case 'skill.evaluated': {
      const p = e.payload as SkillEvaluation
      const row = requireRow(db, e.skill_id)
      const evals = JSON.parse(row.evaluations_json) as SkillEvaluation[]
      evals.push(p)
      db.prepare('UPDATE skills SET revision = ?, evaluations_json = ?, updated_at = ? WHERE skill_id = ?')
        .run(e.revision, JSON.stringify(evals), e.ts, e.skill_id)
      break
    }

    case 'skill.adopted':
      requireRow(db, e.skill_id)
      setPhase(db, e, 'active', null)
      break

    case 'skill.rejected':
      requireRow(db, e.skill_id)
      setPhase(db, e, 'rejected', null)
      break

    case 'skill.retired': {
      requireRow(db, e.skill_id)
      const p = e.payload as { reason: string }
      setPhase(db, e, 'retired', p.reason)
      break
    }

    case 'skill.restored':
      requireRow(db, e.skill_id)
      setPhase(db, e, 'active', null)
      break

    default:
      raise('INVALID_INPUT', `unknown skill event kind: ${String(e.kind)}`)
  }
}
