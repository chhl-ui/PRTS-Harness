export type AuditErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'READ_ONLY'
  | 'CHAIN_BROKEN'

export class AuditError extends Error {
  readonly code: AuditErrorCode

  constructor(code: AuditErrorCode, message: string) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

export function raise(code: AuditErrorCode, message: string): never {
  throw new AuditError(code, message)
}
