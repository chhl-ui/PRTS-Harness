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
  RegisterSessionInput,
  SessionKind,
  SessionRow,
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
CREATE TABLE IF NOT EXISTS audit_grants (
  grant_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  capability TEXT NOT NULL,
  expires_at INTEGER,
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT,
  session_id TEXT
);
CREATE TABLE IF NOT EXISTS audit_once (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  consumed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_sessions (
  session_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('primary','subagent')),
  roots_json TEXT NOT NULL,
  parent_session TEXT,
  registered_at_ms INTEGER NOT NULL,
  released_at_ms INTEGER
);
`

const DELETION_ACTOR: AuditActor = { kind: 'system', component: 'deletion' }

/**
 * 幂等迁移：`audit_grants` 增可选列 `session_id`（grant 的会话归属）。
 *
 * 不能只改 SCHEMA：老库的 `CREATE TABLE IF NOT EXISTS` 不会补列，而 grant 的会话
 * 归属必须对既有授权链生效。所以先 `PRAGMA table_info` 看真实列，缺了才
 * `ALTER TABLE ... ADD COLUMN`——重复打开不报错，也不会重置已有数据。
 * 只读打开不做迁移（写不了）；读侧对缺失列按 null（全局授予）处理。
 */
function migrateSessionScope(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(audit_grants)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'session_id')) {
    db.exec('ALTER TABLE audit_grants ADD COLUMN session_id TEXT')
  }
}

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
      // sessionId 缺省 = 全局授予；给了就必须是非空串（空串会被读成「没有归属」的歧义）
      if (e.sessionId !== undefined) nonEmpty(e.sessionId, 'sessionId')
      return
    case 'grant.revoked':
      nonEmpty(e.grantId, 'grantId'); nonEmpty(e.reason, 'reason'); return
    case 'tool.denied':
      nonEmpty(e.sessionId, 'sessionId'); nonEmpty(e.tool, 'tool'); nonEmpty(e.reason, 'reason'); return
    case 'approval.decided':
      nonEmpty(e.sessionId, 'sessionId'); nonEmpty(e.callId, 'callId'); nonEmpty(e.tool, 'tool')
      if (!OUTCOMES.has(e.outcome)) raise('INVALID_INPUT', `bad outcome ${String(e.outcome)}`)
      if (!Array.isArray(e.capabilities) || !e.capabilities.every((c) => typeof c === 'string' && c !== '')) {
        raise('INVALID_INPUT', 'capabilities must be an array of non-empty strings')
      }
      if (e.grantId !== undefined) nonEmpty(e.grantId, 'grantId')
      return
    case 'approval.consumed':
      nonEmpty(e.callId, 'callId'); return
    case 'tool.loop.suspected':
      nonEmpty(e.sessionId, 'sessionId')
      nonEmpty(e.tool, 'tool')
      num(e.count, 'count')
      nonEmpty(e.fingerprint, 'fingerprint')
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
    case 'integrity.manifest-updated': {
      if (e.oldSha256 !== null && typeof e.oldSha256 !== 'string') raise('INVALID_INPUT', 'oldSha256 must be string|null')
      nonEmpty(e.newSha256, 'newSha256')
      for (const k of ['added', 'removed', 'changed'] as const) {
        if (!Array.isArray(e[k]) || e[k].some((x) => typeof x !== 'string')) {
          raise('INVALID_INPUT', `${k} must be string[]`)
        }
      }
      return
    }
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
    case 'session.registered': {
      nonEmpty(e.sessionId, 'sessionId')
      if (e.sessionKind !== 'primary' && e.sessionKind !== 'subagent') {
        raise('INVALID_INPUT', `bad session kind ${String(e.sessionKind)}`)
      }
      if (!Array.isArray(e.roots)) raise('INVALID_INPUT', 'roots must be string[]')
      if (e.roots.some((r) => typeof r !== 'string' || r === '')) {
        raise('INVALID_INPUT', 'roots must be non-empty strings')
      }
      if (e.parentSession !== undefined) nonEmpty(e.parentSession, 'parentSession')
      return
    }
    case 'session.released':
      nonEmpty(e.sessionId, 'sessionId'); return
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
    migrateSessionScope(db)
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
      this.checkTransitions(event)
      const rec = this.writeEvent(actor, event)
      this.afterWrite(event)
      return rec
    })
  }

  /** 一次事务内顺序追加多条事件（recordOwnerDecision 等复合写入用）。 */
  appendBatch(entries: { actor: AuditActor; event: AuditEvent }[]): AuditRecord[] {
    for (const e of entries) validateEvent(e.event)
    return this.tx(() => {
      const out: AuditRecord[] = []
      for (const { actor, event } of entries) {
        this.checkTransitions(event)
        out.push(this.writeEvent(actor, event))
        this.afterWrite(event)
      }
      return out
    })
  }

  private checkTransitions(event: AuditEvent): void {
    if (event.kind === 'grant.issued' && this.grantRow(event.grantId)) {
      raise('INVALID_TRANSITION', `grant ${event.grantId} already issued`)
    }
    if (event.kind === 'grant.revoked') {
      const row = this.grantRow(event.grantId)
      if (!row) raise('NOT_FOUND', `grant ${event.grantId} not found`)
      if (row.revoked_at !== null) raise('INVALID_TRANSITION', `grant ${event.grantId} already revoked`)
    }
    if (event.kind === 'approval.decided'
      && (event.outcome === 'allowed-once' || event.outcome === 'allowed-always')
      && this.onceRow(event.callId)) {
      raise('INVALID_TRANSITION', `approval for callId ${event.callId} already recorded`)
    }
    if (event.kind === 'approval.consumed') {
      const row = this.onceRow(event.callId)
      if (!row) raise('NOT_FOUND', `approval for callId ${event.callId} not found`)
      if (row.consumed) raise('INVALID_TRANSITION', `approval for callId ${event.callId} already consumed`)
    }
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
  }

  /** writeEvent 之后的联动：最后一个派生项完成 → 同事务自动追加 deletion.completed。 */
  private afterWrite(event: AuditEvent): void {
    if (event.kind !== 'deletion.derivative-done') return
    const row = this.deletionRow(event.deletionId) as { derivatives_json: string; completed: number }
    const derivs = JSON.parse(row.derivatives_json) as { done: boolean }[]
    if (derivs.every((d) => d.done) && !row.completed) {
      this.writeEvent(DELETION_ACTOR, { kind: 'deletion.completed', deletionId: event.deletionId })
    }
  }

  private deletionRow(id: string): { derivatives_json: string; completed: number } | undefined {
    return this.db.prepare('SELECT derivatives_json, completed FROM audit_deletions WHERE deletion_id = ?')
      .get(id) as { derivatives_json: string; completed: number } | undefined
  }

  private grantRow(id: string): { revoked_at: number | null } | undefined {
    return this.db.prepare('SELECT revoked_at FROM audit_grants WHERE grant_id = ?')
      .get(id) as { revoked_at: number | null } | undefined
  }

  private onceRow(callId: string): { consumed: number } | undefined {
    return this.db.prepare('SELECT consumed FROM audit_once WHERE call_id = ?')
      .get(callId) as { consumed: number } | undefined
  }

  /** 注册一个会话（事件 + 投影同事务）。actor 固定 system：这是宿主事实，不是模型可发起的动作。 */
  registerSession(actor: AuditActor, input: RegisterSessionInput): void {
    this.append(actor, {
      kind: 'session.registered',
      sessionId: input.sessionId,
      sessionKind: input.kind,
      roots: [...input.roots],
      ...(input.parentSession === undefined ? {} : { parentSession: input.parentSession }),
    })
  }

  /** 释放一个会话：写事件，投影置 released_at_ms；行保留（审计只追加）。 */
  releaseSession(actor: AuditActor, sessionId: string): void {
    this.append(actor, { kind: 'session.released', sessionId })
  }

  /** 读会话投影（判定与诊断用）。无进程内缓存——与 grant 判定同一不变量。 */
  listSessions(): SessionRow[] {
    const rows = this.db.prepare(
      `SELECT session_id, kind, roots_json, parent_session, registered_at_ms, released_at_ms
         FROM audit_sessions ORDER BY registered_at_ms, session_id`,
    ).all() as unknown as Array<{
      session_id: string; kind: SessionKind; roots_json: string; parent_session: string | null
      registered_at_ms: number; released_at_ms: number | null
    }>
    return rows.map((r) => ({
      sessionId: r.session_id,
      kind: r.kind,
      roots: JSON.parse(r.roots_json) as string[],
      parentSession: r.parent_session,
      registeredAtMs: Number(r.registered_at_ms),
      releasedAtMs: r.released_at_ms === null ? null : Number(r.released_at_ms),
    }))
  }

  /** 投影读取（K2a 判定用）：全部授予行，含已撤销/过期，由调用方按时间判定。 */
  listGrants(): { grantId: string; subject: string; capability: string; expiresAt: number | null; issuedAt: number; revokedAt: number | null; revokeReason: string | null; sessionId: string | null }[] {
    const rows = this.db.prepare('SELECT * FROM audit_grants ORDER BY issued_at').all() as {
      grant_id: string; subject: string; capability: string; expires_at: number | null
      issued_at: number; revoked_at: number | null; revoke_reason: string | null
      session_id?: string | null
    }[]
    return rows.map((r) => ({
      grantId: r.grant_id, subject: r.subject, capability: r.capability,
      expiresAt: r.expires_at, issuedAt: r.issued_at, revokedAt: r.revoked_at, revokeReason: r.revoke_reason,
      // 老库（迁移前建的）只读打开时没有这一列 → undefined，按全局授予处理
      sessionId: r.session_id ?? null,
    }))
  }

  /** 投影读取：某 callId 的一次性批准记录。 */
  getOnce(callId: string): { callId: string; sessionId: string; tool: string; capabilities: string[]; consumed: boolean } | null {
    const r = this.db.prepare('SELECT * FROM audit_once WHERE call_id = ?').get(callId) as
      | { call_id: string; session_id: string; tool: string; capabilities_json: string; consumed: number }
      | undefined
    if (!r) return null
    return {
      callId: r.call_id, sessionId: r.session_id, tool: r.tool,
      capabilities: JSON.parse(r.capabilities_json) as string[],
      consumed: r.consumed !== 0,
    }
  }

  /**
   * 原子「检查 + 消费」：BEGIN IMMEDIATE 内重读 audit_once，
   * 未消费才追加 approval.consumed 并置位；不存在或已消费返回 false（不抛）。
   * 用于并发同 callId 的守卫消费：抢输一方得到 false。
   */
  consumeOnce(actor: AuditActor, callId: string): boolean {
    return this.tx(() => {
      const row = this.onceRow(callId)
      if (!row || row.consumed !== 0) return false
      this.writeEvent(actor, { kind: 'approval.consumed', callId })
      return true
    })
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
      this.db.exec('DELETE FROM audit_grants')
      this.db.exec('DELETE FROM audit_once')
      this.db.exec('DELETE FROM audit_sessions')
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
