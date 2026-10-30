import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TmpDir {
  dir: string
  db(name?: string): string
  /** 先容错关闭传入句柄，再删目录（Windows 句柄释放滞后用 retries 兜底）。 */
  cleanup(...closables: { close(): void }[]): void
}

export function makeTmp(prefix = 'prts-'): TmpDir {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    db(name = 'db.sqlite') {
      return join(dir, name)
    },
    cleanup(...closables) {
      for (const c of closables) {
        try { c.close() } catch { /* 已关闭则忽略 */ }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    },
  }
}
