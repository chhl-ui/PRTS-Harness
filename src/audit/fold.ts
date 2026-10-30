import type { DatabaseSync } from 'node:sqlite'
import type { AuditEventRow } from './types.ts'

/**
 * 唯一的审计投影更新函数：audit_deletions 只能经这里写。
 * 增量路径与 rebuildProjections 共用。
 */
export function applyAuditEvent(db: DatabaseSync, e: AuditEventRow): void {
  const p = e.payload as Record<string, unknown>
  switch (e.kind) {
    case 'deletion.requested': {
      const derivatives = (p.derivatives as { kind: string; ref: string }[])
        .map((d) => ({ kind: d.kind, ref: d.ref, done: false }))
      db.prepare(
        `INSERT INTO audit_deletions (deletion_id, target_json, derivatives_json, completed, requested_at, completed_at)
         VALUES (?, ?, ?, 0, ?, NULL)`,
      ).run(String(p.deletionId), JSON.stringify(p.target), JSON.stringify(derivatives), e.ts)
      break
    }
    case 'deletion.derivative-done': {
      const row = db.prepare('SELECT * FROM audit_deletions WHERE deletion_id = ?')
        .get(p.deletionId as string) as { derivatives_json: string; completed: number } | undefined
      if (!row) break
      const derivatives = JSON.parse(row.derivatives_json) as { kind: string; ref: string; done: boolean }[]
      const index = p.index as number
      if (index < 0 || index >= derivatives.length) break
      derivatives[index].done = true
      // completed/completed_at 只由随后的 deletion.completed 事件置位
      db.prepare('UPDATE audit_deletions SET derivatives_json = ? WHERE deletion_id = ?')
        .run(JSON.stringify(derivatives), p.deletionId as string)
      break
    }
    case 'deletion.completed': {
      db.prepare('UPDATE audit_deletions SET completed = 1, completed_at = ? WHERE deletion_id = ?')
        .run(e.ts, p.deletionId as string)
      break
    }
    default:
      // 其余 kind 只进事件表，无投影
      break
  }
}
