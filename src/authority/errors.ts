export type AuthorityErrorCode = 'INVALID_INPUT'

export class AuthorityError extends Error {
  readonly code: AuthorityErrorCode

  constructor(code: AuthorityErrorCode, message: string) {
    super(message)
    this.name = 'AuthorityError'
    this.code = code
  }
}

export function raise(code: AuthorityErrorCode, message: string): never {
  throw new AuthorityError(code, message)
}
