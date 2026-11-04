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
  /**
   * 联网白名单：命中即 allow，不再逐次审批。
   *
   * 支持精确 host（`api.deepseek.com`）与子域通配（`*.githubusercontent.com`，
   * 匹配任意级子域但**不匹配裸域**）。空/缺省 = 所有联网动作都要人点头（改动前行为）。
   * 只影响 `net` 能力，对 fs / exec 无影响。
   */
  netAllowHosts?: string[]
}

export interface ToolCall {
  /**
   * 发起调用的会话。空串表示「解析失败」，**不是**「任何会话」：空串不匹配任何
   * 会话绑定 grant/once，也不匹配全局授予（fail-closed）。
   *
   * 契约：会话创建与切换只经 owner 通道，不注册为模型工具；子会话不继承
   * 父会话的 grant/once，需要重新问人（子会话的 workspaceRoots 收窄在 W2
   * `prts_subtask` 派生时处理）。
   */
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
  /** null = 全局授予；非空 = 只对该会话生效。 */
  sessionId: string | null
}
