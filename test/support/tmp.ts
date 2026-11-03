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
      // Windows 上被强杀的子进程（runtime.test.ts 的 R4 会 shutdown 一个真实
      // main.ts）释放文件句柄比父进程的 rmSync 慢。10×50ms=500ms 在库数量增加后
      // 不够用了——实测 PRTS 打开 core/memory/skills/persona/emotion 五个 sqlite 后，
      // R4 的清理开始间歇性 EPERM。放到 30×100ms=3s：正常情况第一次就成功，
      // 只有真泄漏才会耗满，且**仍然会失败**，不掩盖问题。
      rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
    },
  }
}
