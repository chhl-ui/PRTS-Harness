import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Ledger } from '../../src/ledger/index.ts'
import { makeTmp } from '../support/tmp.ts'
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
  const t = makeTmp('prts-ledger-')
  const ledger = Ledger.open(join(t.dir, 'ledger.sqlite'))
  return {
    dir: t.dir,
    ledger,
    cleanup() {
      t.cleanup(ledger)
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
