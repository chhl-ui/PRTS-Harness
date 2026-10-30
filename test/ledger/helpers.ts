import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/ledger/index.ts'
import type { Actor } from '../../src/ledger/index.ts'

export const owner: Actor = { kind: 'owner' }
export const model = (sessionId = 'sess-test'): Actor => ({ kind: 'model', sessionId })
export const system = (component: 'verifier' | 'budget' | 'stop' | 'recovery'): Actor => ({ kind: 'system', component })

export interface TmpCtx {
  dir: string
  ledger: Ledger
  cleanup(): void
}

export function openTmp(): TmpCtx {
  const dir = mkdtempSync(join(tmpdir(), 'prts-ledger-'))
  const ledger = Ledger.open(join(dir, 'ledger.sqlite'))
  return {
    dir,
    ledger,
    cleanup() {
      try { ledger.close() } catch { /* 已关 */ }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export interface ThrownLike { code?: string; message?: string }

export function catchError(fn: () => unknown): ThrownLike {
  try {
    fn()
  } catch (e) {
    return e as ThrownLike
  }
  assert.fail('expected throw, got none')
}

export function expectCode(fn: () => unknown, code: string): void {
  const e = catchError(fn)
  assert.equal(e.code, code, `expected ${code}, got ${String(e.code)} (${String(e.message)})`)
}

export async function expectCodeAsync(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn()
  } catch (e) {
    assert.equal((e as ThrownLike).code, code)
    return
  }
  assert.fail(`expected throw ${code}, got none`)
}
