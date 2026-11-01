/**
 * 工具结果卸载的本地存储。
 *
 * 布局：`<root>/session-<sha256(sessionId) 前 16 hex>/<12 字节随机 hex>-<编码后的名字>`。
 *
 * 安全要点（与设计 §4.2、§5.2 对应）：
 * - 文件名里的名字来自调用方建议，先过 {@link encodeSegment} 变成单一路径段，
 *   所以 `../`、绝对路径、NUL 都不可能跳出会话目录。
 * - 会话目录建好后 `lstat` 复核它确实是目录且不是符号链接/junction，再写文件。
 * - 文件用 `open(path,'wx',0o600)` 独占创建：既不会覆盖已有文件，也不能被
 *   预置的符号链接把写入引到别处。`0o600` 只在 POSIX 上生效（Windows 无 mode 位，
 *   那边的边界来自根的位置与后续的进程级沙箱，见设计 §5.3）。
 * - 存储失败一律抛错，由调用方降级为「保留原内联结果」。
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { encodeSegment } from './encode.ts'
import type { SpillRef, SpillSaveInput, SpillStore } from './types.ts'

/** 本地存储的构造参数。 */
export interface LocalSpillStoreOptions {
  /** 存储根。可以是 dataRoot 之外的独立目录（设计 §4.2 要求它与受保护根、工作区根都不相交）。 */
  root: string
}

/** 会话目录名：sha256 前 16 位十六进制（64 bit），碰撞概率低到可忽略；碰撞后果是跨会话读到彼此的文件。 */
function sessionDirName(sessionId: string): string {
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`
}

/** 造一个本地 spill 存储。 */
export function createLocalSpillStore(options: LocalSpillStoreOptions): SpillStore {
  const root = resolve(options.root)

  return {
    async saveText(input: SpillSaveInput): Promise<SpillRef> {
      const dir = join(root, sessionDirName(input.sessionId))
      await mkdir(dir, { recursive: true, mode: 0o700 })

      // 复核：目录已存在时 mkdir 不会报错，但可能被换成符号链接/文件。
      const dirStat = await lstat(dir)
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        throw new Error(`spill: session dir is not a plain directory: ${dir}`)
      }

      // 名字只是提示：编码后是单一路径段，随机前缀保证不覆盖。
      const name = `${randomBytes(12).toString('hex')}-${encodeSegment(input.suggestedName)}`
      const path = join(dir, name)

      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(input.content)
      } finally {
        await handle.close()
      }

      const bytes = Buffer.byteLength(input.content, 'utf8')
      // 单行超长是「存了却读不回来」的真实场景：read 按行分页，单行超过 2000 字符
      // 会被截断且 offset 推进不了（dsh-tool-fs 的 READ_MAX_LINE_LENGTH）。所以单行
      // 结果必须给出按字符窗口推进的读法，否则卸载等于丢失。
      // 路径用单引号包（PowerShell 的 literal string），内部单引号按 PS 规则双写。
      const quoted = path.replace(/'/g, "''")
      const retrievalHint = input.content.includes('\n')
        ? `完整结果已存至 ${path}（${bytes} 字节）。用 read 读；超长时按它返回的提示传 offset 续读。`
        : `完整结果已存至 ${path}（${bytes} 字节，单行）。read 会把单行截到 2000 字符，`
          + `改用 pwsh 分段：$t=(Get-Content -LiteralPath '${quoted}' -Raw); $t.Substring(0,2000)`
          + `（之后把 0 换成 2000、4000…）`

      return { locator: path, bytes, retrievalHint }
    },
  }
}
