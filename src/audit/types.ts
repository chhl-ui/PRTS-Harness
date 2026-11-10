/** K4 审计日志类型。 */

export type AuditActor =
  | { kind: 'owner' }
  | { kind: 'model'; sessionId: string }
  | { kind: 'plugin'; pluginId: string }
  /**
   * `clock` 是 §G2 ① 的时钟组件：它在没有用户输入时主动起一次回合。
   * 单列一个 component 而不是复用 `plugin`——「她自己在无人时说的话」与
   * 「第三方插件做的事」在追责时不是同一件事。
   */
  | { kind: 'system'; component: 'authority' | 'stop' | 'supervisor' | 'integrity' | 'deletion' | 'clock' }

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
  /** 会话身份（设计见 `docs/design-session-identity.md` §3.1）：注册与释放都是授权事实。 */
  | { kind: 'session.registered'; sessionId: string; sessionKind: SessionKind; roots: string[]; parentSession?: string }
  | { kind: 'session.released'; sessionId: string }
  /**
   * §G2 ① 时钟：到点主动开了一次口。
   *
   * 落链的理由与 `tool.loop.suspected` 同一条：**误打扰率**只能靠事后回看攒样本，
   * 而对话会滚掉。`sessionId` 是本次离屏会话的 id，`refId` 是被说的那条
   * intent / task——不记正文来源，只记指针，审计链不该长成第二份记忆库。
   */
  | { kind: 'clock.fired'; sessionId?: string; reasonKind: 'intent' | 'stale-task' | 'fact'; refId: string; text: string }
  /** 时钟连续失败到阈值而自停。停是重要事实：它在没人看的时候停止了自主行为。 */
  | { kind: 'clock.stopped'; consecutive: number; why: string }

export type SessionKind = 'primary' | 'subagent'

/** `audit_sessions` 投影的一行。`releasedAtMs` 非空 = 已释放，判定按 deny。 */
export interface SessionRow {
  sessionId: string
  kind: SessionKind
  roots: string[]
  parentSession: string | null
  registeredAtMs: number
  releasedAtMs: number | null
}

/** 注册一个会话。`roots` 可以为空数组（只读会话）。 */
export interface RegisterSessionInput {
  sessionId: string
  kind: SessionKind
  roots: string[]
  parentSession?: string
}

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
