/** K4 审计日志类型。 */

export type AuditActor =
  | { kind: 'owner' }
  | { kind: 'model'; sessionId: string }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'system'; component: 'authority' | 'stop' | 'supervisor' | 'integrity' | 'deletion' }

/** 形如 'tool:pwsh'、'fs.write:C:\\path'、'net:example.com'；本组件只校验非空。 */
export type Capability = string

export type AuditEvent =
  /** sessionId 缺省 = 全局授予（旧数据与所有者显式发的全局授权）；非空 = 只对该会话生效。 */
  | { kind: 'grant.issued'; grantId: string; subject: string; capability: Capability; expiresAt: number | null; sessionId?: string }
  | { kind: 'grant.revoked'; grantId: string; reason: string }
  | { kind: 'tool.denied'; sessionId: string; tool: string; reason: string }
  /** 工具循环检测：同一会话连续 N 次同工具同参。落链是为了攒误报率样本。 */
  | { kind: 'tool.loop.suspected'; sessionId: string; tool: string; count: number; fingerprint: string }
  | { kind: 'approval.decided'; sessionId: string; callId: string; tool: string; capabilities: string[]; outcome: 'allowed-once' | 'allowed-always' | 'denied' | 'cancelled' | 'unavailable'; grantId?: string }
  | { kind: 'approval.consumed'; callId: string }
  | { kind: 'stop.requested'; level: 'S0' | 'S1' | 'S2' | 'S3' }
  | { kind: 'stop.completed'; level: 'S0' | 'S1' | 'S2' | 'S3'; durationMs: number; escalatedTo?: 'S3' }
  | { kind: 'plugin.approved'; pluginId: string; contentSha256: string }
  | { kind: 'plugin.rejected'; pluginId: string; contentSha256: string; reason: string }
  | { kind: 'integrity.checked'; ok: boolean; detail: string }
  | { kind: 'integrity.manifest-updated'; oldSha256: string | null; newSha256: string; added: string[]; removed: string[]; changed: string[] }
  | { kind: 'undo.performed'; target: { kind: string; id: string }; detail: string }
  | { kind: 'deletion.requested'; deletionId: string; target: { kind: string; id: string }; derivatives: { kind: string; ref: string }[] }
  | { kind: 'deletion.derivative-done'; deletionId: string; index: number }
  | { kind: 'deletion.completed'; deletionId: string }

export interface AuditRecord {
  seq: number
  ts: number
  actor: AuditActor
  event: AuditEvent
  hash: string
}

export interface AuditEventRow {
  seq: number
  kind: string
  actor: AuditActor
  payload: unknown
  ts: number
  prev_hash: string
  hash: string
}

export interface AuditExportDoc {
  format: 'prts-audit/1'
  events: AuditEventRow[]
}

export interface DeletionState {
  target: { kind: string; id: string }
  derivatives: { kind: string; ref: string; done: boolean }[]
  completed: boolean
  requestedAt: number
  completedAt: number | null
}
