export type LedgerErrorCode =
  | 'NOT_FOUND'
  | 'STALE_REVISION'
  | 'FORBIDDEN'
  | 'INVALID_TRANSITION'
  | 'UNEXPECTED_STEP'
  | 'STEP_NOT_STARTED'
  | 'TASK_STOPPED'
  | 'EVIDENCE_MISSING'
  | 'CHAIN_BROKEN'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_INPUT'

export class LedgerError extends Error {
  readonly code: LedgerErrorCode

  constructor(code: LedgerErrorCode, message: string) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
  }
}

export function raise(code: LedgerErrorCode, message: string): never {
  throw new LedgerError(code, message)
}
