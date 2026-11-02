/**
 * K2a 授权判定（纯库；DSH 接线留待运行时集成阶段）。
 *
 * 强制点：DSH `tools.guard(fn)` 是唯一单调拒绝点（同步签名 string|undefined），
 * `tools/pre-execute` 瀑布与审批应答都可能被前置插件伪造，不作为强制点。
 * 本库的 guard(call) 与 DSH 守卫签名一致，每次都直查 SQLite，
 * 跨进程撤销对下一次调用即时生效。
 *
 * shell 命令的写入范围（pwsh 命令体里的删除/系统操作）守卫无法识别，
 * 留待 K2b 由 DSH OS 级沙箱处理。
 */
export { Authority } from './authority.ts'
export { AuthorityError } from './errors.ts'
export { cap, parseCapability, capabilityKey } from './capability.ts'
export { normalizePath, realpathBestEffort, isWithin } from './paths.ts'
export { classify } from './classify.ts'
export { DEFAULT_READ_ONLY_SUBPATHS } from './types.ts'
export type { AuthorityErrorCode } from './errors.ts'
export type { AuthorityConfig, Capability, Decision, GrantView, ToolCall } from './types.ts'
