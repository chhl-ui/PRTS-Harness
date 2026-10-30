import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { AuditLog } from '../audit/index.ts'
import type { AuditActor, AuditEvent } from '../audit/index.ts'
import { raise } from './errors.ts'
import { cap, capabilityKey, parseCapability } from './capability.ts'
import { isWithin, normalizePath, realpathBestEffort } from './paths.ts'
import type { AuthorityConfig, Capability, Decision, GrantView, ToolCall } from './types.ts'

const OWNER: AuditActor = { kind: 'owner' }
const AUTH: AuditActor = { kind: 'system', component: 'authority' }

type CapResult =
  | { kind: 'allow'; via: 'policy' | 'grant'; grantId?: string }
  | { kind: 'ask'; reason: string }
  | { kind: 'deny'; reason: string }

const GRANTABLE = new Set(['fs.write', 'net', 'exec', 'tool'])

/**
 * 授权判定（K2a）：decide 为同步纯读；guard 是 DSH tools.guard 形态的
 * 唯一强制点（同步、单调拒绝）。授予事实只存在于 audit_grants 投影，
 * 每次调用直接查 SQLite，不使用进程内缓存——跨进程撤销对下一次调用即时生效。
 */
export class Authority {
  private readonly audit: AuditLog
  private readonly workspaceRoots: string[]
  private readonly protectedRoots: string[]
  private readonly now: () => number

  private constructor(audit: AuditLog, config: AuthorityConfig, now: () => number) {
    this.audit = audit
    // 与 evalCap 里的 realpathBestEffort 同一规范化域：两侧都取真实路径再比
    this.workspaceRoots = config.workspaceRoots.map(realpathBestEffort)
    this.protectedRoots = config.protectedRoots.map(realpathBestEffort)
    this.now = now
  }

  static open(dbPath: string, config: AuthorityConfig, opts?: { now?: () => number }): Authority {
    return new Authority(AuditLog.open(dbPath), config, opts?.now ?? (() => Date.now()))
  }

  close(): void {
    this.audit.close()
  }

  private validGrants(): { grantId: string; capability: string }[] {
    const now = this.now()
    return this.audit.listGrants()
      .filter((g) => g.revokedAt === null && (g.expiresAt === null || now < g.expiresAt))
      .map((g) => ({ grantId: g.grantId, capability: g.capability }))
  }

  private evalCap(c: Capability, grants: { grantId: string; capability: string }[]): CapResult {
    const p = parseCapability(c)
    switch (p.kind) {
      case 'fs.read':
        return { kind: 'allow', via: 'policy' }
      case 'fs.write': {
        const rp = realpathBestEffort(p.arg)
        if (this.protectedRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.write denied: ${p.arg} is inside protected root` }
        }
        if (this.workspaceRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'allow', via: 'policy' }
        }
        const g = grants.find((g) => g.capability.startsWith('fs.write:')
          && isWithin(rp, realpathBestEffort(g.capability.slice('fs.write:'.length))))
        if (g) return { kind: 'allow', via: 'grant', grantId: g.grantId }
        return { kind: 'ask', reason: `fs.write outside workspace: ${p.arg}` }
      }
      case 'fs.delete': {
        const rp = realpathBestEffort(p.arg)
        if (this.protectedRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.delete denied: ${p.arg} is inside protected root` }
        }
        return { kind: 'ask', reason: `fs.delete requires per-call approval: ${p.arg}` }
      }
      case 'system':
        return { kind: 'ask', reason: `system:${p.arg} requires per-call approval` }
      case 'net':
      case 'exec':
      case 'tool': {
        const g = grants.find((g) => g.capability === c)
        if (g) return { kind: 'allow', via: 'grant', grantId: g.grantId }
        return { kind: 'ask', reason: `no active grant for ${c}` }
      }
    }
  }

  /** 同步、只读。一次调用的全部能力都放行才放行；deny > ask > allow。 */
  decide(call: ToolCall): Decision {
    const grants = this.validGrants()
    const results = call.capabilities.map((c) => this.evalCap(c, grants))

    const deny = results.find((r) => r.kind === 'deny')
    if (deny) return { kind: 'deny', reason: (deny as { reason: string }).reason }

    const asks = results.filter((r) => r.kind === 'ask')
    if (asks.length > 0) {
      // 一次性批准：callId 未消费且记录的能力覆盖本次全部能力 → ask 变 once
      const once = this.audit.getOnce(call.callId)
      const recorded = once ? new Set(once.capabilities.map(capabilityKey)) : null
      const covered = recorded !== null && !once!.consumed
        && call.capabilities.every((c) => recorded.has(capabilityKey(c)))
      if (covered) return { kind: 'allow', via: 'once' }
      return { kind: 'ask', reason: (asks[0] as { reason: string }).reason }
    }

    // 全部 allow：via 按 最受限通道 once > grant > policy 汇报
    const grantHit = results.find((r) => r.kind === 'allow' && r.via === 'grant') as { grantId?: string } | undefined
    if (grantHit) return { kind: 'allow', via: 'grant', grantId: grantHit.grantId }
    return { kind: 'allow', via: 'policy' }
  }

  /**
   * DSH tools.guard 形态：拒绝返回理由串，放行返回 undefined。
   * allow(via==='once') 时写 approval.consumed 消费本次批准；
   * ask/deny 写 tool.denied 审计。输入非法时按拒绝处理（fail closed）。
   */
  /**
   * DSH tools.guard 形态：拒绝返回理由串，放行返回 undefined。
   * allow(via==='once') 时经 AuditLog.consumeOnce 原子消费；
   * 任何内部异常都转成拒绝理由，绝不抛出（DSH 对抛异常的 guard 行为未核实，不依赖）。
   */
  guard(call: ToolCall): string | undefined {
    try {
      const decision = this.decide(call)
      if (decision.kind === 'allow') {
        if (decision.via === 'once' && !this.audit.consumeOnce(AUTH, call.callId)) {
          return this.denyWithAudit(call, 'one-time approval already consumed')
        }
        return undefined
      }
      return this.denyWithAudit(call, decision.reason)
    } catch (e) {
      return `guard: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  private denyWithAudit(call: ToolCall, reason: string): string {
    try {
      this.audit.append(AUTH, { kind: 'tool.denied', sessionId: call.sessionId, tool: call.tool, reason })
    } catch { /* 审计写入失败不掩盖拒绝 */ }
    return reason
  }

  /**
   * 所有者通道：记录一次性审批结果。allowed-always 时对可授予能力
   * （fs.write→父目录范围、net、exec、tool）各写一条 grant.issued；
   * fs.delete / system 不生成授予。整个写入在一个事务内完成。
   */
  recordOwnerDecision(d: {
    sessionId: string
    callId: string
    tool: string
    capabilities: Capability[]
    outcome: 'allowed-once' | 'allowed-always' | 'denied' | 'cancelled' | 'unavailable'
  }): { grantIds: string[] } {
    // 全部输入先校验，不合法 → INVALID_INPUT，不写入任何内容
    if (typeof d.sessionId !== 'string' || d.sessionId === ''
      || typeof d.callId !== 'string' || d.callId === ''
      || typeof d.tool !== 'string' || d.tool === '') {
      raise('INVALID_INPUT', 'sessionId/callId/tool must be non-empty strings')
    }
    if (!Array.isArray(d.capabilities)) raise('INVALID_INPUT', 'capabilities must be an array')
    for (const c of d.capabilities) parseCapability(c)

    const grants: { grantId: string; capability: string }[] = []
    if (d.outcome === 'allowed-always') {
      for (const c of d.capabilities) {
        const p = parseCapability(c)
        if (!GRANTABLE.has(p.kind)) continue
        const capability = p.kind === 'fs.write' ? cap.fsWrite(dirname(normalizePath(p.arg))) : c
        grants.push({ grantId: `grant-${randomUUID()}`, capability })
      }
    }
    const entries: { actor: AuditActor; event: AuditEvent }[] = [
      {
        actor: OWNER,
        event: {
          kind: 'approval.decided',
          sessionId: d.sessionId,
          callId: d.callId,
          tool: d.tool,
          capabilities: d.capabilities,
          outcome: d.outcome,
          grantId: grants[0]?.grantId,
        },
      },
      ...grants.map((g) => ({
        actor: OWNER,
        event: {
          kind: 'grant.issued' as const,
          grantId: g.grantId,
          subject: 'model',
          capability: g.capability,
          expiresAt: null,
        },
      })),
    ]
    this.audit.appendBatch(entries)
    return { grantIds: grants.map((g) => g.grantId) }
  }

  /** 所有者通道：签发授予，返回 grantId。 */
  issueGrant(g: { subject: 'model'; capability: Capability; expiresAt: number | null }): string {
    if (g.subject !== 'model') raise('INVALID_INPUT', `subject must be 'model': ${String(g.subject)}`)
    parseCapability(g.capability) // 校验结构
    if (g.expiresAt !== null && (typeof g.expiresAt !== 'number' || !Number.isFinite(g.expiresAt))) {
      raise('INVALID_INPUT', 'expiresAt must be a number or null')
    }
    const grantId = `grant-${randomUUID()}`
    this.audit.append(OWNER, {
      kind: 'grant.issued', grantId, subject: g.subject, capability: g.capability, expiresAt: g.expiresAt,
    })
    return grantId
  }

  /** 所有者通道：撤销授予。 */
  revokeGrant(grantId: string, reason: string): void {
    if (typeof reason !== 'string' || reason === '') raise('INVALID_INPUT', 'reason must be non-empty')
    this.audit.append(OWNER, { kind: 'grant.revoked', grantId, reason })
  }

  /** 当前有效授予（未撤销且未过期）。 */
  activeGrants(): GrantView[] {
    const now = this.now()
    return this.audit.listGrants()
      .filter((g) => g.revokedAt === null && (g.expiresAt === null || now < g.expiresAt))
      .map((g) => ({ grantId: g.grantId, subject: g.subject, capability: g.capability, expiresAt: g.expiresAt, issuedAt: g.issuedAt }))
  }
}
