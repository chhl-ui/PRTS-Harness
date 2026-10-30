import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { ZERO_HASH, appendChained, canonicalJson, chainHash, eventHash, sha256hex, verifyChainRows } from '../chain/index.ts'
import { raise } from './errors.ts'
import { applyEvent, usageExceeded } from './fold.ts'
import type {
  AcceptanceSpec,
  Actor,
  BeginStepResult,
  Budget,
  CheckSpec,
  EvidenceRecord,
  LedgerEventRow,
  StepRecord,
  TaskId,
  TaskPhase,
  TaskRef,
  TaskSnapshot,
  Usage,
  VerifyChainResult,
  LedgerExportDoc,
} from './types.ts'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_events (
  seq INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  phase TEXT NOT NULL,
  blocked_json TEXT,
  last_rejection TEXT,
  acceptance_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  resume_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_steps (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  step_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  idempotent INTEGER NOT NULL,
  status TEXT NOT NULL,
  tool_call_ref TEXT,
  output_ref TEXT,
  PRIMARY KEY (task_id, step_no)
);
CREATE TABLE IF NOT EXISTS evidence (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  artifact_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  produced_by TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
`

interface TaskRow {
  task_id: string
  revision: number
  title: string
  objective: string
  phase: string
  blocked_json: string | null
  last_rejection: string | null
  acceptance_json: string
  budget_json: string
  usage_json: string
  resume_json: string
  created_at: number
  updated_at: number
}

interface EventDbRow {
  seq: number
  task_id: string
  revision: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
  prev_hash: string
  hash: string
}

interface StepRow {
  task_id: string
  step_no: number
  name: string
  idempotent: number
  status: string
  tool_call_ref: string | null
  output_ref: string | null
}

const TERMINAL: ReadonlySet<string> = new Set(['done', 'cancelled'])
const STOPPED: ReadonlySet<string> = new Set(['cancelled', 'stopped-by-owner'])

/** model 经自由 actor 参数允许的操作；owner 全可；system 一律 FORBIDDEN。 */
const MODEL_OPS = new Set([
  'create', 'note', 'setResume', 'beginStep', 'endStep', 'addEvidence',
  'claimDone', 'block', 'unblock', 'pause', 'resume',
])

const OWNER: Actor = { kind: 'owner' }
const VERIFIER: Actor = { kind: 'system', component: 'verifier' }
const BUDGET: Actor = { kind: 'system', component: 'budget' }
const STOP: Actor = { kind: 'system', component: 'stop' }
const RECOVERY: Actor = { kind: 'system', component: 'recovery' }

function eventOf(row: EventDbRow): LedgerEventRow {
  return {
    seq: row.seq,
    task_id: row.task_id,
    revision: row.revision,
    kind: row.kind,
    actor: JSON.parse(row.actor_json) as Actor,
    payload: JSON.parse(row.payload_json),
    ts: row.ts,
    prev_hash: row.prev_hash,
    hash: row.hash,
  }
}

export class Ledger {
  private readonly db: DatabaseSync
  private readonly now: () => number
  private readonly readOnly: boolean

  private constructor(db: DatabaseSync, now: () => number, readOnly: boolean) {
    this.db = db
    this.now = now
    this.readOnly = readOnly
  }

  static open(dbPath: string, opts?: { now?: () => number; readOnly?: boolean }): Ledger {
    if (opts?.readOnly) {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      db.exec('PRAGMA foreign_keys = ON')
      db.exec('PRAGMA busy_timeout = 5000')
      return new Ledger(db, opts.now ?? (() => Date.now()), true)
    }
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    return new Ledger(db, opts?.now ?? (() => Date.now()), false)
  }

  close(): void {
    this.db.close()
  }

  // ---------- 事务与事件追加 ----------

  private tx<T>(fn: () => T): T {
    if (this.readOnly) raise('READ_ONLY', 'ledger opened read-only')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 必须在事务内调用：追加一条事件并把投影折叠进去。 */
  private appendEvent(taskId: string, revision: number, kind: string, actor: Actor, payload: unknown): void {
    const ts = this.now()
    const { seq, prev_hash, hash } = appendChained(
      this.db,
      'ledger_events',
      { task_id: taskId, revision, kind, actor, payload, ts },
      (f) => ({
        seq: f.seq as number,
        task_id: taskId,
        revision,
        kind,
        actor_json: JSON.stringify(actor),
        payload_json: canonicalJson(payload),
        ts,
        prev_hash: f.prev_hash as string,
        hash: f.hash as string,
      }),
    )
    applyEvent(this.db, { seq, task_id: taskId, revision, kind, actor, payload, ts, prev_hash, hash })
  }

  // ---------- 读侧 ----------

  private taskRow(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id) as TaskRow | undefined
  }

  private mustTask(id: string): TaskRow {
    const row = this.taskRow(id)
    if (!row) raise('NOT_FOUND', `task not found: ${id}`)
    return row
  }

  private toSnapshot(row: TaskRow): TaskSnapshot {
    const snap: TaskSnapshot = {
      id: row.task_id as TaskId,
      revision: row.revision,
      title: row.title,
      objective: row.objective,
      phase: row.phase as TaskPhase,
      acceptance: JSON.parse(row.acceptance_json) as AcceptanceSpec,
      budget: JSON.parse(row.budget_json) as Budget,
      usage: JSON.parse(row.usage_json) as Usage,
      resume: JSON.parse(row.resume_json) as TaskSnapshot['resume'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    if (row.phase === 'blocked' && row.blocked_json) {
      snap.blockedReason = JSON.parse(row.blocked_json) as { code: string; message: string }
    }
    if (row.last_rejection !== null) {
      snap.lastRejection = row.last_rejection
    }
    return snap
  }

  private snapshot(id: string): TaskSnapshot {
    return this.toSnapshot(this.mustTask(id))
  }

  get(id: TaskId): TaskSnapshot {
    return this.snapshot(id)
  }

  list(filter?: { phase?: TaskPhase }): TaskSnapshot[] {
    const rows = filter?.phase
      ? this.db.prepare('SELECT * FROM tasks WHERE phase = ? ORDER BY created_at, task_id').all(filter.phase)
      : this.db.prepare('SELECT * FROM tasks ORDER BY created_at, task_id').all()
    return (rows as unknown as TaskRow[]).map((r) => this.toSnapshot(r))
  }

  private stepRow(taskId: string, stepNo: number): StepRow | undefined {
    return this.db.prepare('SELECT * FROM task_steps WHERE task_id = ? AND step_no = ?')
      .get(taskId, stepNo) as StepRow | undefined
  }

  private toStep(row: StepRow): StepRecord {
    const rec: StepRecord = {
      taskId: row.task_id as TaskId,
      stepNo: row.step_no,
      name: row.name,
      idempotent: row.idempotent !== 0,
      status: row.status as StepRecord['status'],
    }
    if (row.tool_call_ref !== null) rec.toolCallRef = row.tool_call_ref
    if (row.output_ref !== null) rec.outputRef = row.output_ref
    return rec
  }

  steps(taskId: TaskId): StepRecord[] {
    const rows = this.db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_no').all(taskId) as unknown as StepRow[]
    return rows.map((r) => this.toStep(r))
  }

  evidence(taskId: TaskId): EvidenceRecord[] {
    const rows = this.db.prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY rowid').all(taskId) as {
      task_id: string; artifact_path: string; sha256: string; produced_by: string; recorded_at: number
    }[]
    return rows.map((r) => ({
      taskId: r.task_id as TaskId,
      artifactPath: r.artifact_path,
      sha256: r.sha256,
      producedBy: r.produced_by,
      recordedAt: r.recorded_at,
    }))
  }

  // ---------- 校验辅助 ----------

  private perm(actor: Actor, op: string): void {
    if (actor?.kind === 'owner') return
    if (actor?.kind === 'model') {
      if (MODEL_OPS.has(op)) return
      raise('FORBIDDEN', `model actor may not ${op}`)
    }
    if (actor?.kind === 'system') {
      raise('FORBIDDEN', `system actor goes through fixed-actor paths, not ${op}`)
    }
    raise('INVALID_INPUT', `unknown actor kind: ${String((actor as { kind?: unknown })?.kind)}`)
  }

  private checkRevision(row: TaskRow, ref: TaskRef): void {
    if (row.revision !== ref.revision) {
      raise('STALE_REVISION', `task ${ref.id}: expected revision ${ref.revision}, current ${row.revision}`)
    }
  }

  private checkPhase(row: TaskRow, allowed: readonly string[], op: string): void {
    if (!allowed.includes(row.phase)) {
      raise('INVALID_TRANSITION', `${op}: task ${row.task_id} is '${row.phase}'`)
    }
  }

  private checkStepGate(row: TaskRow): void {
    if (STOPPED.has(row.phase)) {
      raise('TASK_STOPPED', `task ${row.task_id} is '${row.phase}'`)
    }
    if (row.phase !== 'active') {
      raise('INVALID_TRANSITION', `steps require 'active', task ${row.task_id} is '${row.phase}'`)
    }
  }

  private static nonEmpty(v: unknown, field: string): asserts v is string {
    if (typeof v !== 'string' || v.trim() === '') {
      raise('INVALID_INPUT', `${field} must be a non-empty string`)
    }
  }

  private static positiveInt(v: unknown, field: string): asserts v is number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      raise('INVALID_INPUT', `${field} must be a positive integer`)
    }
  }

  private static absolutePath(v: unknown, field: string): asserts v is string {
    if (typeof v !== 'string' || !isAbsolute(v)) {
      raise('INVALID_INPUT', `${field} must be an absolute path`)
    }
  }

  private static checkBudget(budget: Budget | undefined): void {
    if (!budget) return
    for (const [k, v] of Object.entries(budget)) {
      if (!['maxCostUsd', 'maxRounds', 'maxMs'].includes(k)) {
        raise('INVALID_INPUT', `unknown budget field: ${k}`)
      }
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        raise('INVALID_INPUT', `budget.${k} must be a non-negative number`)
      }
    }
  }

  /** model 在 resume/unblock 前的预算门：usage 已超时拒绝；owner 不受限。 */
  private checkBudgetGate(actor: Actor, row: TaskRow, op: string): void {
    if (actor.kind !== 'model') return
    const exceeded = usageExceeded(
      JSON.parse(row.usage_json) as Usage,
      JSON.parse(row.budget_json) as Budget,
    )
    if (exceeded.length > 0) {
      raise('BUDGET_EXCEEDED', `${op}: usage already over budget: ${exceeded.join('; ')}`)
    }
  }

  /** 通用 ref 写操作：权限→修订→阶段→事件→快照，全部在一个事务里。 */
  private transition(
    actor: Actor,
    ref: TaskRef,
    op: string,
    allowedPhases: readonly string[],
    kind: string,
    payload: unknown,
  ): TaskSnapshot {
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, op)
      this.checkRevision(row, ref)
      this.checkPhase(row, allowedPhases, op)
      this.appendEvent(row.task_id, row.revision + 1, kind, actor, payload)
      return this.snapshot(row.task_id)
    })
  }

  // ---------- 任务生命周期 ----------

  create(actor: Actor, input: {
    title: string
    objective: string
    acceptance: AcceptanceSpec
    budget?: Budget
  }): TaskSnapshot {
    this.perm(actor, 'create')
    Ledger.nonEmpty(input?.title, 'title')
    Ledger.nonEmpty(input?.objective, 'objective')
    if (input.acceptance?.kind !== 'owner-confirm' && input.acceptance?.kind !== 'checks') {
      raise('INVALID_INPUT', 'acceptance.kind must be owner-confirm or checks')
    }
    if (input.acceptance.kind === 'checks' && !Array.isArray(input.acceptance.checks)) {
      raise('INVALID_INPUT', 'acceptance.checks must be an array')
    }
    if (input.acceptance.kind === 'checks') {
      for (const check of input.acceptance.checks) {
        if (check?.kind === 'file-exists') {
          Ledger.absolutePath(check.path, 'check.path')
        } else if (check?.kind === 'file-sha256') {
          Ledger.absolutePath(check.path, 'check.path')
          if (typeof check.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(check.sha256)) {
            raise('INVALID_INPUT', 'check.sha256 must be 64 lowercase hex characters')
          }
        } else {
          raise('INVALID_INPUT', `unknown check kind: ${String((check as { kind?: unknown })?.kind)}`)
        }
      }
    }
    Ledger.checkBudget(input.budget)
    const id = `task-${randomUUID()}` as TaskId
    return this.tx(() => {
      this.appendEvent(id, 1, 'task.created', actor, {
        title: input.title,
        objective: input.objective,
        acceptance: input.acceptance,
        budget: input.budget ?? {},
      })
      return this.snapshot(id)
    })
  }

  activate(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.transition(actor, ref, 'activate', ['draft'], 'task.activated', {})
  }

  pause(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.transition(actor, ref, 'pause', ['active'], 'task.paused', {})
  }

  block(actor: Actor, ref: TaskRef, reason: { code: string; message: string }): TaskSnapshot {
    Ledger.nonEmpty(reason?.code, 'reason.code')
    Ledger.nonEmpty(reason?.message, 'reason.message')
    return this.transition(actor, ref, 'block', ['active'], 'task.blocked', reason)
  }

  unblock(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, 'unblock')
      this.checkRevision(row, ref)
      this.checkPhase(row, ['blocked'], 'unblock')
      const blocked = JSON.parse(row.blocked_json ?? '{}') as { by?: string }
      if (actor.kind === 'model' && blocked.by !== 'model') {
        raise('FORBIDDEN', `model may only unblock self-imposed blocks (by='${blocked.by ?? '?'}')`)
      }
      this.checkBudgetGate(actor, row, 'unblock')
      this.appendEvent(row.task_id, row.revision + 1, 'task.unblocked', actor, {})
      return this.snapshot(row.task_id)
    })
  }

  resume(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, 'resume')
      this.checkRevision(row, ref)
      this.checkPhase(row, ['paused'], 'resume')
      this.checkBudgetGate(actor, row, 'resume')
      this.appendEvent(row.task_id, row.revision + 1, 'task.resumed', actor, {})
      return this.snapshot(row.task_id)
    })
  }

  /** 固定 owner 通道：重设预算上限；非终态任务可用，不查修订号。 */
  setBudget(ref: TaskRef, budget: Budget): TaskSnapshot {
    Ledger.checkBudget(budget)
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `setBudget: task ${row.task_id} is terminal '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'task.budget-set', OWNER, { budget: budget ?? {} })
      return this.snapshot(row.task_id)
    })
  }

  claimDone(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.transition(actor, ref, 'claimDone', ['active'], 'task.done-claimed', {})
  }

  cancel(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, 'cancel')
      this.checkRevision(row, ref)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `cancel: task ${row.task_id} already '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'task.cancelled', actor, {})
      return this.snapshot(row.task_id)
    })
  }

  stopByOwner(taskId: TaskId): TaskSnapshot | null {
    return this.tx(() => {
      const row = this.mustTask(taskId)
      if (TERMINAL.has(row.phase) || row.phase === 'stopped-by-owner') return null
      this.appendEvent(row.task_id, row.revision + 1, 'task.stopped', STOP, {})
      return this.snapshot(row.task_id)
    })
  }

  resumeFromStop(actor: Actor, ref: TaskRef): TaskSnapshot {
    return this.transition(actor, ref, 'resumeFromStop', ['stopped-by-owner'], 'task.resumed-from-stop', {})
  }

  // ---------- 验收 ----------

  async verify(ref: TaskRef): Promise<TaskSnapshot> {
    if (this.readOnly) raise('READ_ONLY', 'ledger opened read-only')
    const pre = this.mustTask(ref.id)
    if (pre.phase !== 'verifying') {
      raise('INVALID_TRANSITION', `verify: task ${ref.id} is '${pre.phase}', not 'verifying'`)
    }
    const acceptance = JSON.parse(pre.acceptance_json) as AcceptanceSpec
    if (acceptance.kind !== 'checks') {
      raise('INVALID_TRANSITION', `verify: task ${ref.id} acceptance is '${acceptance.kind}', needs owner ruling`)
    }
    const results = (acceptance as { checks: CheckSpec[] }).checks.map((check) => runCheck(check))
    const ok = results.every((r) => r.ok)
    const rejection = ok ? null : results.filter((r) => !r.ok).map((r) => r.detail).join('; ')
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      if (row.phase !== 'verifying') {
        raise('INVALID_TRANSITION', `verify: task ${ref.id} left 'verifying' before commit`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'task.verified', VERIFIER, { ok, results, rejection })
      return this.snapshot(row.task_id)
    })
  }

  ownerAccept(ref: TaskRef): TaskSnapshot {
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.checkPhase(row, ['verifying'], 'ownerAccept')
      this.appendEvent(row.task_id, row.revision + 1, 'task.owner-accepted', OWNER, {})
      return this.snapshot(row.task_id)
    })
  }

  ownerReject(ref: TaskRef, reason: string): TaskSnapshot {
    Ledger.nonEmpty(reason, 'reason')
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.checkPhase(row, ['verifying'], 'ownerReject')
      this.appendEvent(row.task_id, row.revision + 1, 'task.owner-rejected', OWNER, { reason })
      return this.snapshot(row.task_id)
    })
  }

  // ---------- 备注与恢复点 ----------

  note(actor: Actor, ref: TaskRef, text: string): TaskSnapshot {
    if (typeof text !== 'string') raise('INVALID_INPUT', 'text must be a string')
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, 'note')
      this.checkRevision(row, ref)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `note: task ${row.task_id} is terminal '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'task.noted', actor, { text })
      return this.snapshot(row.task_id)
    })
  }

  setResume(actor: Actor, ref: TaskRef, r: { next: string | null; open: string[] }): TaskSnapshot {
    if (r === null || typeof r !== 'object' || !Array.isArray(r.open) || !r.open.every((x) => typeof x === 'string')) {
      raise('INVALID_INPUT', 'resume must be { next: string|null, open: string[] }')
    }
    if (r.next !== null && typeof r.next !== 'string') {
      raise('INVALID_INPUT', 'resume.next must be string or null')
    }
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.perm(actor, 'setResume')
      this.checkRevision(row, ref)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `setResume: task ${row.task_id} is terminal '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'task.resume-set', actor, { next: r.next, open: r.open })
      return this.snapshot(row.task_id)
    })
  }

  // ---------- 步骤 ----------

  beginStep(actor: Actor, taskId: TaskId, s: {
    stepNo: number
    name: string
    idempotent: boolean
    toolCallRef?: string
  }): BeginStepResult {
    this.perm(actor, 'beginStep')
    Ledger.positiveInt(s?.stepNo, 'stepNo')
    Ledger.nonEmpty(s?.name, 'name')
    if (typeof s.idempotent !== 'boolean') raise('INVALID_INPUT', 'idempotent must be a boolean')
    return this.tx(() => {
      const row = this.mustTask(taskId)
      this.checkStepGate(row)
      const existing = this.stepRow(taskId, s.stepNo)
      if (existing) {
        if (existing.name !== s.name) {
          raise('UNEXPECTED_STEP', `step ${s.stepNo} recorded as '${existing.name}', got '${s.name}'`)
        }
        if (existing.status === 'succeeded' || existing.status === 'failed') {
          return { kind: 'recorded', step: this.toStep(existing) }
        }
        if (existing.status === 'unknown') {
          return { kind: 'unknown', step: this.toStep(existing) }
        }
        raise('UNEXPECTED_STEP', `step ${s.stepNo} is already in-flight ('started')`)
      }
      this.appendEvent(taskId, row.revision + 1, 'step.begun', actor, {
        stepNo: s.stepNo,
        name: s.name,
        idempotent: s.idempotent,
        toolCallRef: s.toolCallRef,
      })
      return { kind: 'run' }
    }) as BeginStepResult
  }

  retryUnknownStep(actor: Actor, taskId: TaskId, stepNo: number): void {
    this.perm(actor, 'beginStep')
    Ledger.positiveInt(stepNo, 'stepNo')
    this.tx(() => {
      const row = this.mustTask(taskId)
      this.checkStepGate(row)
      const step = this.stepRow(taskId, stepNo)
      if (!step) raise('NOT_FOUND', `step ${stepNo} not found on task ${taskId}`)
      if (step.status !== 'unknown') {
        raise('INVALID_TRANSITION', `step ${stepNo} is '${step.status}', not 'unknown'`)
      }
      if (!step.idempotent && actor.kind !== 'owner') {
        raise('FORBIDDEN', `step ${stepNo} is not idempotent; only owner may retry an unknown step`)
      }
      this.appendEvent(taskId, row.revision + 1, 'step.retried', actor, { stepNo })
    })
  }

  endStep(actor: Actor, taskId: TaskId, stepNo: number, r: {
    status: 'succeeded' | 'failed'
    outputRef?: string
  }): void {
    this.perm(actor, 'endStep')
    Ledger.positiveInt(stepNo, 'stepNo')
    if (r?.status !== 'succeeded' && r?.status !== 'failed') {
      raise('INVALID_INPUT', "status must be 'succeeded' or 'failed'")
    }
    this.tx(() => {
      const row = this.mustTask(taskId)
      const step = this.stepRow(taskId, stepNo)
      if (!step || step.status !== 'started') {
        raise('STEP_NOT_STARTED', `step ${stepNo} is not 'started'`)
      }
      this.appendEvent(taskId, row.revision + 1, 'step.ended', actor, {
        stepNo,
        status: r.status,
        outputRef: r.outputRef,
      })
    })
  }

  // ---------- 证据与预算 ----------

  addEvidence(actor: Actor, ref: TaskRef, e: { artifactPath: string; producedBy: string }): TaskSnapshot {
    this.perm(actor, 'addEvidence')
    Ledger.nonEmpty(e?.artifactPath, 'artifactPath')
    Ledger.nonEmpty(e?.producedBy, 'producedBy')
    Ledger.absolutePath(e.artifactPath, 'artifactPath')
    const resolved = resolve(e.artifactPath)
    if (!existsSync(resolved)) {
      raise('EVIDENCE_MISSING', `evidence file not found: ${resolved}`)
    }
    const sha = sha256hex(readFileSync(resolved))
    return this.tx(() => {
      const row = this.mustTask(ref.id)
      this.checkRevision(row, ref)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `addEvidence: task ${row.task_id} is terminal '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'evidence.added', actor, {
        artifactPath: e.artifactPath,
        sha256: sha,
        producedBy: e.producedBy,
      })
      return this.snapshot(row.task_id)
    })
  }

  chargeUsage(taskId: TaskId, u: Partial<Usage>): TaskSnapshot {
    for (const [k, v] of Object.entries(u ?? {})) {
      if (!['costUsd', 'rounds', 'ms'].includes(k)) {
        raise('INVALID_INPUT', `unknown usage field: ${k}`)
      }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        raise('INVALID_INPUT', `usage.${k} must be a non-negative number`)
      }
    }
    return this.tx(() => {
      const row = this.mustTask(taskId)
      if (TERMINAL.has(row.phase)) {
        raise('INVALID_TRANSITION', `chargeUsage: task ${row.task_id} is terminal '${row.phase}'`)
      }
      this.appendEvent(row.task_id, row.revision + 1, 'usage.charged', BUDGET, { delta: u })
      return this.snapshot(row.task_id)
    })
  }

  // ---------- 恢复、校验、迁移 ----------

  recoverOnStartup(): StepRecord[] {
    return this.tx(() => {
      const started = this.db.prepare(
        "SELECT * FROM task_steps WHERE status = 'started' ORDER BY task_id, step_no",
      ).all() as unknown as StepRow[]
      for (const s of started) {
        const row = this.mustTask(s.task_id)
        this.appendEvent(s.task_id, row.revision + 1, 'step.recovered', RECOVERY, { stepNo: s.step_no })
      }
      return started.map((s) => this.toStep(this.stepRow(s.task_id, s.step_no) as StepRow))
    })
  }

  verifyChain(): VerifyChainResult {
    const rows = this.db.prepare('SELECT * FROM ledger_events ORDER BY seq').all() as unknown as EventDbRow[]
    return verifyChainRows(rows, (r) => ({
      seq: r.seq,
      task_id: r.task_id,
      revision: r.revision,
      kind: r.kind,
      actor: JSON.parse(r.actor_json),
      payload: JSON.parse(r.payload_json),
      ts: r.ts,
    })) as VerifyChainResult
  }

  rebuildProjections(): void {
    this.tx(() => {
      this.db.exec('DELETE FROM evidence')
      this.db.exec('DELETE FROM task_steps')
      this.db.exec('DELETE FROM tasks')
      const rows = this.db.prepare('SELECT * FROM ledger_events ORDER BY seq').all() as unknown as EventDbRow[]
      for (const r of rows) applyEvent(this.db, eventOf(r))
    })
  }

  exportDoc(): LedgerExportDoc {
    const rows = this.db.prepare('SELECT * FROM ledger_events ORDER BY seq').all() as unknown as EventDbRow[]
    return { format: 'prts-ledger/1', events: rows.map(eventOf) }
  }

  static importDoc(dbPath: string, doc: LedgerExportDoc): Ledger {
    if (doc === null || typeof doc !== 'object' || doc.format !== 'prts-ledger/1' || !Array.isArray(doc.events)) {
      raise('INVALID_INPUT', "doc must be { format: 'prts-ledger/1', events: [] }")
    }
    // 全链校验先于任何写入
    let prev = ZERO_HASH
    let lastSeq = 0
    for (const e of doc.events) {
      if (
        e === null || typeof e !== 'object'
        || !Number.isInteger(e.seq) || e.seq <= lastSeq
        || typeof e.task_id !== 'string'
        || !Number.isInteger(e.revision)
        || typeof e.kind !== 'string'
        || e.actor === null || typeof e.actor !== 'object'
        || typeof e.ts !== 'number'
        || typeof e.prev_hash !== 'string'
        || typeof e.hash !== 'string'
      ) {
        raise('INVALID_INPUT', `malformed event at index ${doc.events.indexOf(e)}`)
      }
      if (e.prev_hash !== prev || eventHash(e, prev) !== e.hash) {
        raise('CHAIN_BROKEN', `hash chain broken at seq ${e.seq}`)
      }
      prev = e.hash
      lastSeq = e.seq
    }

    const ledger = Ledger.open(dbPath)
    try {
      const count = (ledger.db.prepare('SELECT COUNT(*) AS c FROM ledger_events').get() as { c: number }).c
      if (count !== 0) {
        raise('INVALID_INPUT', `target database is not empty (${count} events)`)
      }
      ledger.tx(() => {
        for (const e of doc.events) {
          ledger.db.prepare(
            `INSERT INTO ledger_events (seq, task_id, revision, kind, actor_json, payload_json, ts, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(e.seq, e.task_id, e.revision, e.kind, JSON.stringify(e.actor), canonicalJson(e.payload), e.ts, e.prev_hash, e.hash)
          applyEvent(ledger.db, {
            seq: e.seq,
            task_id: e.task_id,
            revision: e.revision,
            kind: e.kind,
            actor: e.actor,
            payload: e.payload,
            ts: e.ts,
            prev_hash: e.prev_hash,
            hash: e.hash,
          })
        }
      })
      return ledger
    } catch (err) {
      try { ledger.close() } catch { /* 已关 */ }
      throw err
    }
  }
}

interface CheckResult {
  check: CheckSpec
  ok: boolean
  detail: string
}

function runCheck(check: CheckSpec): CheckResult {
  switch (check?.kind) {
    case 'file-exists': {
      if (!isAbsolute(check.path)) raise('INVALID_INPUT', 'check.path must be absolute')
      const p = resolve(check.path)
      const ok = existsSync(p)
      return { check, ok, detail: ok ? `file-exists ok: ${p}` : `file-exists 失败: 文件不存在 ${p}` }
    }
    case 'file-sha256': {
      if (!isAbsolute(check.path)) raise('INVALID_INPUT', 'check.path must be absolute')
      const p = resolve(check.path)
      if (!existsSync(p)) {
        return { check, ok: false, detail: `file-sha256 失败: 文件不存在 ${p}` }
      }
      const actual = sha256hex(readFileSync(p))
      const ok = actual === check.sha256
      return { check, ok, detail: ok ? `file-sha256 ok: ${p}` : `file-sha256 失败: 哈希不匹配 ${p}` }
    }
    default:
      raise('INVALID_INPUT', `unknown check kind: ${String((check as { kind?: unknown })?.kind)}`)
  }
}
