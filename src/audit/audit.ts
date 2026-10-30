import { DatabaseSync } from 'node:sqlite'
import { appendChained, canonicalJson, chainHash, verifyChainRows } from '../chain/index.ts'
import { raise } from './errors.ts'
import { applyAuditEvent } from './fold.ts'
import type {
  AuditActor,
  AuditEvent,
  AuditEventRow,
  AuditExportDoc,
  AuditRecord,
  DeletionState,
} from './types.ts'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_deletions (
  deletion_id TEXT PRIMARY KEY,
  target_json TEXT NOT NULL,
  derivatives_json TEXT NOT NULL,
  completed INTEGER NOT NULL,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER
);
`

const DELETION_ACTOR: AuditActor = { kind: 'system', component: 'deletion' }

interface EventDbRow {
  seq: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
  prev_hash: string
  hash: string
}

function rowToEvent(r: EventDbRow): AuditEventRow {
  return {
    seq: r.seq,
    kind: r.kind,
    actor: JSON.parse(r.actor_json) as AuditActor,
    payload: JSON.parse(r.payload_json),
    ts: r.ts,
    prev_hash: r.prev_hash,
    hash: r.hash,
  }
}

const LEVELS = new Set(['S0', 'S1', 'S2', 'S3'])
const OUTCOMES = new Set(['allowed-once', 'allowed-always', 'denied', 'cancelled', 'unavailable'])

function nonEmpty(v: unknown, f: string): asserts v is string {
  if (typeof v !== 'string' || v === '') raise('INVALID_INPUT', `${f} must be non-empty string`)
}
function num(v: unknown, f: string): asserts v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) raise('INVALID_INPUT', `${f} must be a number`)
}

/** 逐 kind 结构校验（不查投影）。 */
function validateEvent(e: AuditEvent): void {
  if (e === null || typeof e !== 'object' || typeof (e as { kind?: unknown }).kind !== 'string') {
    raise('INVALID_INPUT', 'event must have a string kind')
  }
  switch (e.kind) {
    case 'grant.issued':
      nonEmpty(e.grantId, 'grantId'); nonEmpty(e.subject, 'subject'); nonEmpty(e.capability, 'capability')
      if (e.expiresAt !== null) num(e.expiresAt, 'expiresAt')
      return
    case 'grant.revoked':
      nonEmpty(e.grantId, 'grantId'); nonEmpty(e.reason, 'reason'); return
    case 'tool.denied':
      nonEmpty(e.sessionId, 'sessionId'); nonEmpty(e.tool, 'tool'); nonEmpty(e.reason, 'reason'); return
    case 'approval.decided':
      nonEmpty(e.sessionId, 'sessionId'); nonEmpty(e.tool, 'tool')
      if (!OUTCOMES.has(e.outcome)) raise('INVALID_INPUT', `bad outcome ${String(e.outcome)}`)
      if (e.grantId !== undefined) nonEmpty(e.grantId, 'grantId')
      return
    case 'stop.requested':
      if (!LEVELS.has(e.level)) raise('INVALID_INPUT', `bad level ${String(e.level)}`); return
    case 'stop.completed':
      if (!LEVELS.has(e.level)) raise('INVALID_INPUT', `bad level ${String(e.level)}`)
      num(e.durationMs, 'durationMs')
      if (e.escalatedTo !== undefined && e.escalatedTo !== 'S3') raise('INVALID_INPUT', 'escalatedTo must be S3')
      return
    case 'plugin.approved':
      nonEmpty(e.pluginId, 'pluginId'); nonEmpty(e.contentSha256, 'contentSha256'); return
    case 'plugin.rejected':
      nonEmpty(e.pluginId, 'pluginId'); nonEmpty(e.contentSha256, 'contentSha256'); nonEmpty(e.reason, 'reason'); return
    case 'integrity.checked':
      if (typeof e.ok !== 'boolean') raise('INVALID_INPUT', 'ok must be boolean')
      nonEmpty(e.detail, 'detail'); return
    case 'undo.performed':
      nonEmpty(e.target?.kind, 'target.kind'); nonEmpty(e.target?.id, 'target.id'); nonEmpty(e.detail, 'detail'); return
    case 'deletion.requested':
      nonEmpty(e.deletionId, 'deletionId'); nonEmpty(e.target?.kind, 'target.kind'); nonEmpty(e.target?.id, 'target.id')
      if (!Array.isArray(e.derivatives) || e.derivatives.length === 0) {
        raise('INVALID_INPUT', 'derivatives must be a non-empty array')
      }
      for (const d of e.derivatives) { nonEmpty(d?.kind, 'derivative.kind'); nonEmpty(d?.ref, 'derivative.ref') }
      return
    case 'deletion.derivative-done':
      nonEmpty(e.deletionId, 'deletionId')
      if (!Number.isInteger(e.index) || (e.index as number) < 0) raise('INVALID_INPUT', 'index must be a non-negative integer')
      return
    case 'deletion.completed':
      raise('INVALID_INPUT', 'deletion.completed is appended internally, not by callers')
    default:
      raise('INVALID_INPUT', `unknown event kind: ${String((e as { kind?: unknown }).kind)}`)
  }
}

export class AuditLog {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly readOnly: boolean

  private constructor(db: DatabaseSync, now: () => number, readOnly: boolean) {
    this.db = db; this.now = now; this.readOnly = readOnly
  }

  static open(dbPath: string, opts?: { now?: () => number; readOnly?: boolean }): AuditLog {
    if (opts?.readOnly) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      db.exec('PRAGMA busy_timeout = 5000')
      return new AuditLog(db, opts.now ?? (() => Date.now()), true)
    }
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    return new AuditLog(db, opts?.now ?? (() => Date.now()), false)
  }

  close(): void { this.db.close() }

  private tx<T>(fn: () => T): T {
    if (this.readOnly) raise('READ_ONLY', 'audit log opened read-only')
    this.db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); this.db.exec('COMMIT'); return r }
    catch (e) { this.db.exec('ROLLBACK'); throw e }
  }

  private writeEvent(actor: AuditActor, e: AuditEvent): AuditRecord {
    const ts = this.now()
    const { seq, hash } = appendChained(
      this.db, 'audit_events',
      { kind: e.kind, actor, payload: e, ts },
      (f) => ({ seq: f.seq as number, kind: e.kind, actor_json: JSON.stringify(actor), payload_json: canonicalJson(e), ts, prev_hash: f.prev_hash as string, hash: f.hash as string }),
    )
    const last = this.db.prepare('SELECT prev_hash FROM audit_events WHERE seq = ?').get(seq) as { prev_hash: string }
    applyAuditEvent(this.db, { seq, kind: e.kind, actor, payload: e, ts, prev_hash: last.prev_hash, hash })
    return { seq, ts, actor, event: e, hash }
  }

  append(actor: AuditActor, event: AuditEvent): AuditRecord {
    validateEvent(event)
    return this.tx(() => {
      // 与投影相关的转移校验必须在写入前完成
      if (event.kind === 'deletion.requested' && this.deletionRow(event.deletionId)) {
        raise('INVALID_TRANSITION', `deletion ${event.deletionId} already requested`)
      }
      if (event.kind === 'deletion.derivative-done') {
        const row = this.deletionRow(event.deletionId)
        if (!row) raise('NOT_FOUND', `deletion ${event.deletionId} not found`)
        const derivs = JSON.parse(row.derivatives_json) as { done: boolean }[]
        if (event.index >= derivs.length) raise('INVALID_INPUT', `index ${event.index} out of range`)
        if (row.completed) raise('INVALID_TRANSITION', `deletion ${event.deletionId} already completed`)
        if (derivs[event.index].done) raise('INVALID_TRANSITION', `derivative ${event.index} already done`)
      }
      const rec = this.writeEvent(actor, event)
      // 最后一个派生项完成 → 同事务自动追加 deletion.completed
      if (event.kind === 'deletion.derivative-done') {
        const row = this.deletionRow(event.deletionId) as { derivatives_json: string; completed: number }
        const derivs = JSON.parse(row.derivatives_json) as { done: boolean }[]
        if (derivs.every((d) => d.done) && !row.completed) {
          this.writeEvent(DELETION_ACTOR, { kind: 'deletion.completed', deletionId: event.deletionId })
        }
      }
      return rec
    })
  }

  private deletionRow(id: string): { derivatives_json: string; completed: number } | undefined {
    return this.db.prepare('SELECT derivatives_json, completed FROM audit_deletions WHERE deletion_id = ?')
      .get(id) as { derivatives_json: string; completed: number } | undefined
  }

  query(filter?: { kinds?: AuditEvent['kind'][]; since?: number; until?: number; limit?: number }): AuditRecord[] {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as unknown as EventDbRow[]
    let out = rows.map(rowToEvent)
    if (filter?.kinds) out = out.filter((r) => filter.kinds!.includes(r.kind as AuditEvent['kind']))
    if (filter?.since !== undefined) out = out.filter((r) => r.ts >= filter.since!)
    if (filter?.until !== undefined) out = out.filter((r) => r.ts <= filter.until!)
    if (filter?.limit !== undefined) out = out.slice(-filter.limit)
    return out.map((r) => ({ seq: r.seq, ts: r.ts, actor: r.actor, event: r.payload as AuditEvent, hash: r.hash }))
  }

  deletion(deletionId: string): DeletionState {
    const row = this.db.prepare('SELECT * FROM audit_deletions WHERE deletion_id = ?').get(deletionId) as
      | { target_json: string; derivatives_json: string; completed: number; requested_at: number; completed_at: number | null }
      | undefined
    if (!row) raise('NOT_FOUND', `deletion ${deletionId} not found`)
    const derivatives = JSON.parse(row.derivatives_json) as { kind: string; ref: string; done: boolean }[]
    return {
      target: JSON.parse(row.target_json) as { kind: string; id: string },
      derivatives,
      completed: row.completed !== 0,
      requestedAt: row.requested_at,
      completedAt: row.completed_at,
    }
  }

  verifyChain(): ReturnType<typeof verifyChainRows> {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as unknown as EventDbRow[]
    return verifyChainRows(rows, (r) => ({
      seq: r.seq, kind: r.kind,
      actor: JSON.parse(r.actor_json),
      payload: JSON.parse(r.payload_json),
      ts: r.ts,
    }))
  }

  rebuildProjections(): void {
    this.tx(() => {
      this.db.exec('DELETE FROM audit_deletions')
      const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as unknown as EventDbRow[]
      for (const r of rows) applyAuditEvent(this.db, rowToEvent(r))
    })
  }

  exportDoc(): AuditExportDoc {
    const rows = this.db.prepare('SELECT * FROM audit_events ORDER BY seq').all() as unknown as EventDbRow[]
    return { format: 'prts-audit/1', events: rows.map(rowToEvent) }
  }

  static importDoc(dbPath: string, doc: AuditExportDoc): AuditLog {
    if (doc === null || typeof doc !== 'object' || doc.format !== 'prts-audit/1' || !Array.isArray(doc.events)) {
      raise('INVALID_INPUT', "doc must be { format: 'prts-audit/1', events: [] }")
    }
    let prev = '0'.repeat(64); let lastSeq = 0
    for (const e of doc.events) {
      if (e === null || typeof e !== 'object' || !Number.isInteger(e.seq) || e.seq <= lastSeq
        || typeof e.kind !== 'string' || e.actor === null || typeof e.actor !== 'object'
        || typeof e.ts !== 'number' || typeof e.prev_hash !== 'string' || typeof e.hash !== 'string') {
        raise('INVALID_INPUT', 'malformed audit event')
      }
      if (e.prev_hash !== prev || chainHash(prev, { seq: e.seq, kind: e.kind, actor: e.actor, payload: e.payload, ts: e.ts }) !== e.hash) {
        raise('CHAIN_BROKEN', `audit hash chain broken at seq ${e.seq}`)
      }
      prev = e.hash; lastSeq = e.seq
    }
    const log = AuditLog.open(dbPath)
    try {
      const cnt = (log.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as { c: number }).c
      if (cnt !== 0) raise('INVALID_INPUT', `target audit table not empty (${cnt} events)`)
      log.tx(() => {
        for (const e of doc.events) {
          log.db.prepare('INSERT INTO audit_events (seq,kind,actor_json,payload_json,ts,prev_hash,hash) VALUES (?,?,?,?,?,?,?)')
            .run(e.seq, e.kind, JSON.stringify(e.actor), canonicalJson(e.payload), e.ts, e.prev_hash, e.hash)
          applyAuditEvent(log.db, { seq: e.seq, kind: e.kind, actor: e.actor, payload: e.payload, ts: e.ts, prev_hash: e.prev_hash, hash: e.hash })
        }
      })
      return log
    } catch (err) {
      try { log.close() } catch { /* ignore */ }
      throw err
    }
  }
}
