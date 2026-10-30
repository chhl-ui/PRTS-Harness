/** K1 任务账本：对外类型。 */

export type TaskId = string & { readonly __brand: 'TaskId' }

export type Actor =
  | { kind: 'owner' }
  | { kind: 'model'; sessionId: string }
  | { kind: 'system'; component: 'verifier' | 'budget' | 'stop' | 'recovery' }

export type TaskPhase =
  | 'draft'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'verifying'
  | 'done'
  | 'cancelled'
  | 'stopped-by-owner'

export type CheckSpec =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-sha256'; path: string; sha256: string }

export type AcceptanceSpec =
  | { kind: 'owner-confirm' }
  | { kind: 'checks'; checks: CheckSpec[] }

export interface Budget {
  maxCostUsd?: number
  maxRounds?: number
  maxMs?: number
}

export interface Usage {
  costUsd: number
  rounds: number
  ms: number
}

export interface TaskRef {
  id: TaskId
  revision: number
}

export interface TaskSnapshot extends TaskRef {
  title: string
  objective: string
  phase: TaskPhase
  /** 仅 phase==='blocked' 时存在。 */
  blockedReason?: { code: string; message: string }
  /** 最近一次验收未通过的原因。 */
  lastRejection?: string
  acceptance: AcceptanceSpec
  budget: Budget
  usage: Usage
  resume: { lastCompletedStep: number | null; next: string | null; open: string[] }
  createdAt: number
  updatedAt: number
}

export type StepStatus = 'started' | 'succeeded' | 'failed' | 'unknown'

export interface StepRecord {
  taskId: TaskId
  stepNo: number
  name: string
  idempotent: boolean
  status: StepStatus
  toolCallRef?: string
  outputRef?: string
}

export interface EvidenceRecord {
  taskId: TaskId
  artifactPath: string
  sha256: string
  producedBy: string
  recordedAt: number
}

/** ledger_events 表行（导出/导入与校验用的完整形态）。 */
export interface LedgerEventRow {
  seq: number
  task_id: string
  revision: number
  kind: string
  actor: Actor
  payload: unknown
  ts: number
  prev_hash: string
  hash: string
}

export interface LedgerExportDoc {
  format: 'prts-ledger/1'
  events: LedgerEventRow[]
}

export type VerifyChainResult =
  | { ok: true; events: number }
  | { ok: false; brokenAtSeq: number }

export type BeginStepResult =
  | { kind: 'run' }
  | { kind: 'recorded'; step: StepRecord }
  | { kind: 'unknown'; step: StepRecord }
