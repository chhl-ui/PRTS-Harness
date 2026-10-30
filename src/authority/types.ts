export type Capability = string

export interface AuthorityConfig {
  /** 绝对路径，可写工作区。 */
  workspaceRoots: string[]
  /** 绝对路径，任何来源都禁止写入或删除（PRTS 数据根、守护进程目录）。 */
  protectedRoots: string[]
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
