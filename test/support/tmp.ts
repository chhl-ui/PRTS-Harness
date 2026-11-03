import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TmpDir {
  dir: string
  db(name?: string): string
  /** 先容错关闭传入句柄，再删目录（Windows 句柄释放滞后用 retries 兜底）。 */
  cleanup(...closables: { close(): void }[]): void
}

/** 同步睡眠（cleanup 是同步接口，不能改 async）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
      // Windows 上被 node:sqlite 打开的库文件不允许删除，而 rmSync 的
      // maxRetries 只对目录相关错误生效——文件级 EPERM 会 0ms 直接抛出，
      // 重试参数完全没进去（.rivet 探针实测：rmSync(..., maxRetries:30) 在
      // 打开的 core.sqlite 上 elapsed=0ms 就 EPERM）。真正需要的是「等它释放」：
      // R4 失败后的残留目录实测 1s 后可删（3/3 命中均在 1s）。
      // 所以这里自己做同步重试，100ms 一次、最多 10s；正常情况第一次就成功，
      // 真泄漏（永久占用）仍会失败，不掩盖问题。
      const deadline = Date.now() + 10_000
      for (;;) {
        try {
          rmSync(dir, { recursive: true, force: true })
          return
        } catch (e) {
          if (Date.now() >= deadline) throw e
          sleepSync(100)
        }
      }
    },
  }
}
