/**
 * runner 的命令行解析。
 *
 * 单独成文件是为了**可测**：`runner.ts` 顶层有 `await main()`，导入即执行，
 * 没法直接从它那里导入解析函数来单测。
 *
 * 协议（与 runner.ts 的文档一致）：
 *
 * ```
 * node runner.ts --profile <名称> --workspace <路径> [--read-path <路径>]... [--inherit] -- <命令> [参数...]
 * ```
 *
 * `--read-path` 可重复，每个值是 AppContainer 需要额外获得读权限的目录
 * （当前唯一用途：工具结果卸载的存储根，让沙箱里的 shell 能回读卸载结果）。
 */

/** runner 解析后的参数。 */
export interface RunnerArgv {
  profile?: string
  workspace?: string
  /** 需要额外授予读权限的目录，按出现顺序。 */
  readPaths: string[]
  inherit: boolean
  command: string[]
}

/** 解析 runner 的 argv（不含 node 与脚本路径）。 */
export function parseRunnerArgv(argv: readonly string[]): RunnerArgv {
  const sep = argv.indexOf('--')
  if (sep < 0) return { readPaths: [], inherit: false, command: [] }
  const opts = argv.slice(0, sep)
  const command = argv.slice(sep + 1)
  let profile: string | undefined
  let workspace: string | undefined
  const readPaths: string[] = []
  let inherit = false
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i] === '--profile') profile = opts[i + 1]
    else if (opts[i] === '--workspace') workspace = opts[i + 1]
    else if (opts[i] === '--inherit') inherit = true
    else if (opts[i] === '--read-path') {
      const value = opts[i + 1]
      if (value !== undefined && value !== '') readPaths.push(value)
      i += 1
    }
  }
  return { profile, workspace, readPaths, inherit, command }
}
