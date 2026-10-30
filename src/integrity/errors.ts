export type IntegrityCode =
  | 'MANIFEST_UNANCHORED' | 'ENTRY_MISSING' | 'ENTRY_NAME_MISMATCH' | 'ENTRY_DISABLED'
  | 'ENTRY_DYNAMIC_DISABLED' | 'PROTECTED_PACKAGE_DUPLICATED' | 'VERSION_MISMATCH'
  | 'TREE_MISMATCH' | 'PACKAGE_MISSING' | 'LINK_IN_TREE' | 'INTEGRITY_FAILED'

export class IntegrityError extends Error {
  readonly code: IntegrityCode
  readonly failures: { code: IntegrityCode; detail: string }[]

  constructor(code: IntegrityCode, message: string, failures: { code: IntegrityCode; detail: string }[] = []) {
    super(message)
    this.name = 'IntegrityError'
    this.code = code
    this.failures = failures
  }
}
