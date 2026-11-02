export type Capability = string

/** workspace 内保持只读的子路径缺省名单：K2a（fs 工具层）与 workspace-acl（shell 层）共用一份。 */
export const DEFAULT_READ_ONLY_SUBPATHS = ['.git'] as const

export interface AuthorityConfig {
  /** 绝对路径，可写工作区。 */
  workspaceRoots: string[]
  /** 绝对路径，任何来源都禁止写入或删除（PRTS 数据根、守护进程目录）。 */
  protectedRoots: string[]
  /**
   * 绝对路径，工具结果卸载（spill）的存储根：模型**可读、不可写、不可删**。
   *
   * 必须与 workspaceRoots / protectedRoots 都不相交——落进前者模型就能改写卸载内容，
   * 落进后者模型又读不回来（卸载等于删除）。判定顺序 protectedRoots > spillRoots > workspaceRoots。
   * 缺省视为空数组，旧调用方行为不变。见 docs/design-tool-output-spill.md §5.1。
   */
  spillRoots?: string[]
  /**
   * workspace 内保持只读的子路径（相对于 workspace 根的路径段，如 `.git`）。
   *
   * 动机参照 codex 的 `WritableRoot.read_only_subpaths`：即使整个 workspace 可写，
   * 也不能让模型改自己的元数据——`.git` 被改可以伪造提交历史。
   * 只影响 `fs.write` / `fs.delete`；读取不受限。缺省 `['.git']`，传 `[]` 关闭。
   */
  readOnlySubpaths?: string[]
}

export interface ToolCall {
  sessionId: string
  callId: string
  tool: string
  capabilities: Capability[]
}

export type Decision =
  | { kind: 'allow'; via: 'policy' | 'grant' | 'once'; grantId?: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

export interface GrantView {
  grantId: string
  subject: string
  capability: Capability
  expiresAt: number | null
  issuedAt: number
}
