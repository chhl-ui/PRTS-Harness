import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { AuditLog } from '../audit/index.ts'
import type { AuditActor, AuditEvent, SessionRow } from '../audit/index.ts'
import { raise } from './errors.ts'
import { cap, capabilityKey, parseCapability } from './capability.ts'
import { isWithin, normalizePath, realpathBestEffort } from './paths.ts'
import { DEFAULT_READ_ONLY_SUBPATHS } from './types.ts'
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
  private readonly spillRoots: string[]
  private readonly readOnlySubpaths: string[]
  /** 联网白名单（host 或 *.host），见 hostAllowed。 */
  private readonly netAllowHosts: string[]
  private readonly now: () => number

  /**
   * 审计链句柄，给运行时的非授权类事件用（如工具循环检测的 `tool.loop.suspected`）。
   *
   * 暴露而不是让调用方自己 `AuditLog.open` 同一路径：core.sqlite 已经有 Authority
   * 一条写连接，再开一条只会增加 WAL 写锁竞争，而事故现场恰恰是最不想锁冲突的时刻。
   */
  get auditLog(): AuditLog { return this.audit }

  // ── 会话身份（设计见 docs/design-session-identity.md §3.2）──────────────
  // actor 固定 system：注册/释放是宿主事实，不是模型可发起的动作。

  /** 注册主会话：roots = 当前 workspaceRoots。 */
  registerPrimarySession(sessionId: string): void {
    this.audit.registerSession(AUTH, {
      sessionId, kind: 'primary', roots: [...this.workspaceRoots],
    })
  }

  /**
   * 注册子会话：roots 由调用方（`spawnSubtask`）代码派生，**不接受模型可见入参**。
   * 写入前 realpath 归一——与 workspace/protected/spill 的构造口径一致，否则
   * symlink / 8.3 短名 / 大小写差异会让 roots 内 allow 漏判或越界。
   */
  registerSessionRoots(sessionId: string, roots: readonly string[], parentSession?: string): void {
    this.audit.registerSession(AUTH, {
      sessionId,
      kind: 'subagent',
      roots: roots.map(realpathBestEffort),
      ...(parentSession === undefined ? {} : { parentSession }),
    })
  }

  /** 释放会话：写事件、投影置 released_at_ms。行保留（审计只追加）。 */
  releaseSession(sessionId: string): void {
    this.audit.releaseSession(AUTH, sessionId)
  }

  /** 是否活跃子会话（已注册、kind=subagent、未释放）。 */
  isSubagentSession(sessionId: string): boolean {
    const row = this.sessionRow(sessionId)
    return row?.kind === 'subagent' && row.releasedAtMs === null
  }

  /** 是否有活跃会话身份（主/子都算）。空串与未注册一律 false。 */
  hasSessionScope(sessionId: string): boolean {
    const row = this.sessionRow(sessionId)
    return row !== undefined && row.releasedAtMs === null
  }

  /** 直查投影，无进程内缓存（与 grant 判定同一不变量）。 */
  private sessionRow(sessionId: string): SessionRow | undefined {
    if (sessionId === '') return undefined
    return this.audit.listSessions().find((r) => r.sessionId === sessionId)
  }

  private constructor(audit: AuditLog, config: AuthorityConfig, now: () => number) {
    this.audit = audit
    // 与 evalCap 里的 realpathBestEffort 同一规范化域：两侧都取真实路径再比
    this.workspaceRoots = config.workspaceRoots.map(realpathBestEffort)
    this.protectedRoots = config.protectedRoots.map(realpathBestEffort)
    this.spillRoots = (config.spillRoots ?? []).map(realpathBestEffort)
    // 只读子路径是相对名（如 '.git'），不做 realpath——它由 workspace 根现拼。
    this.readOnlySubpaths = config.readOnlySubpaths ?? [...DEFAULT_READ_ONLY_SUBPATHS]
    // 联网白名单：把「每次调用都问人」换成「常用域名一次配置」。
    // 只对 host 做小写归一，不做 URL 解析——白名单项本身就是 host 或 *.host 形式。
    this.netAllowHosts = (config.netAllowHosts ?? []).map((h) => h.trim().toLowerCase()).filter((h) => h !== '')
    this.now = now
  }

  /**
   * host 是否命中白名单。规则刻意写得窄：
   * - 精确项：必须完全相等
   * - `*.example.com`：匹配任意级子域，但**不匹配裸域**（裸域要单独列）
   * - 不做后缀包含判断——`evilgithubusercontent.com` 不该被子串蒙混过关
   */
  private hostAllowed(host: string): boolean {
    const h = host.trim().toLowerCase()
    if (h === '' || h === '*') return false
    for (const rule of this.netAllowHosts) {
      if (rule.startsWith('*.')) {
        const suffix = rule.slice(1) // '.example.com'
        if (h.endsWith(suffix) && h.length > suffix.length) return true
        continue
      }
      if (h === rule) return true
    }
    return false
  }

  /**
   * 受保护根（已 realpath 归一，与 evalCap 判定用的是同一份数组实例内容）。
   *
   * 给「输入域校验」用：`prts_task_add_evidence` 这类工具需要判断某路径是否落进
   * 受保护目录。判定必须与 guard 同源——另传一份 dataRoot 出去就成了两处真相，
   * 迟早漂移。返回副本，调用方无法改到内部数组。
   */
  protectedRootPaths(): readonly string[] {
    return [...this.protectedRoots]
  }

  /**
   * spill 根（同上，只读副本）。
   *
   * 给启动自检用：spill 根必须与 protectedRoots / workspaceRoots 都不相交，
   * 否则要么模型读不回来（落进受保护根），要么模型能改写卸载内容（落进工作区）。
   */
  spillRootPaths(): readonly string[] {
    return [...this.spillRoots]
  }

  /** 工作区根（同上，只读副本）。 */
  workspaceRootPaths(): readonly string[] {
    return [...this.workspaceRoots]
  }

  static open(dbPath: string, config: AuthorityConfig, opts?: { now?: () => number }): Authority {
    return new Authority(AuditLog.open(dbPath), config, opts?.now ?? (() => Date.now()))
  }

  close(): void {
    this.audit.close()
  }

  /**
   * 该已归一化路径落在哪个 workspace 的只读子路径下？返回子路径名或 undefined。
   *
   * 只按段边界匹配：`.git` 不会命中 `.github`，`notgit` 也不会命中。
   */
  private readOnlySubpathOf(rp: string): string | undefined {
    for (const root of this.workspaceRoots) {
      for (const sub of this.readOnlySubpaths) {
        if (isWithin(rp, join(root, sub))) return sub
      }
    }
    return undefined
  }

  private validGrants(): { grantId: string; capability: string; sessionId: string | null }[] {
    const now = this.now()
    return this.audit.listGrants()
      .filter((g) => g.revokedAt === null && (g.expiresAt === null || now < g.expiresAt))
      .map((g) => ({ grantId: g.grantId, capability: g.capability, sessionId: g.sessionId }))
  }

  /**
   * grant 对本次调用是否在会话范围内：`sessionId === null` → 全局（旧数据、所有者显式全局授权）；
   * 非空 → 必须与 `call.sessionId` 完全相等，父会话的持久授权不会静默传给子会话。
   *
   * 四族（fs.write / net / exec / tool）在这里统一收窄，而不是在 evalCap 各分支里各写一遗——
   * 分支里写就会漏一个。空 `call.sessionId` 不匹配任何会话绑定 grant（与 once 同一判据：
   * 「没有会话」不等于「任何会话」）。
   */
  private grantsForSession(sessionId: string): { grantId: string; capability: string; sessionId: string | null }[] {
    // 空会话没有任何 grant：全局授予（sessionId === null）也只对「某个真实会话」生效。
    // 「没有会话」不是「任何会话」——这一条与 once 的 covered 判据同源。
    if (sessionId === '') return []
    return this.validGrants()
      .filter((g) => g.sessionId === null || g.sessionId === sessionId)
  }

  /** 该路径是否落在会话登记的 roots 内（roots 已 realpath 归一，这里再归一一侧对齐）。 */
  private inSessionRoots(row: SessionRow, rp: string): boolean {
    return row.roots.some((r) => isWithin(rp, realpathBestEffort(r)))
  }

  /**
   * 会话级写入口径（W2）。只收窄、不打开任何新通道：
   *
   * - 空 sessionId → deny（「没有会话」不是「任何会话」，与 grantsForSession 同一判据）
   * - 未注册 → defer（没有身份记录不等于有罪，回落原判定）
   * - 主会话 → defer
   * - 已释放子会话 → deny（身份已交回，不再持有任何写权）
   * - 活跃子会话 → roots 内 allow；全局 workspace 内且 roots 外 deny；其余 defer
   *
   * 只由 fs.write / fs.delete 调用；fs.read 与 exec 不经过这里。
   */
  private decideSessionScoped(sessionId: string, rp: string): 'allow' | 'deny' | 'defer' {
    if (sessionId === '') return 'deny'
    const row = this.sessionRow(sessionId)
    if (row === undefined) return 'defer'
    if (row.releasedAtMs !== null) return 'deny'
    if (row.kind === 'primary') return 'defer'
    if (this.inSessionRoots(row, rp)) return 'allow'
    if (this.workspaceRoots.some((r) => isWithin(rp, r))) return 'deny'
    return 'defer'
  }

  private evalCap(
    c: Capability,
    grants: { grantId: string; capability: string; sessionId: string | null }[],
    sessionId: string,
  ): CapResult {
    const p = parseCapability(c)
    switch (p.kind) {
      case 'fs.read': {
        // 读侧保护：protectedRoots（数据根、密钥目录）对模型不可读。
        // 此前这里是无条件 allow，而 dsh-sandbox-windows-acl 自述只创建 WRITE_RESTRICTED
        // 令牌（读完全不受限），两边都不管等于 <dataRoot>/secrets/*.key 对模型 shell 敞开。
        const rp = realpathBestEffort(p.arg)
        if (this.protectedRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.read denied: ${p.arg} is inside protected root` }
        }
        if (this.spillRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'allow', via: 'policy' }
        }
        return { kind: 'allow', via: 'policy' }
      }
      case 'fs.write': {
        const rp = realpathBestEffort(p.arg)
        if (this.protectedRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.write denied: ${p.arg} is inside protected root` }
        }
        if (this.spillRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.write denied: ${p.arg} is inside spill root` }
        }
        if (this.workspaceRoots.some((r) => isWithin(rp, r))) {
          const sub = this.readOnlySubpathOf(rp)
          if (sub !== undefined) {
            return { kind: 'deny', reason: `fs.write denied: ${p.arg} is inside read-only subpath '${sub}'` }
          }
          // 会话级收窄（W2）：已注册子会话只能写自己的 roots。
          // 未注册会话 / 主会话 → defer，落到原先的 workspace allow，不翻转。
          const scoped = this.decideSessionScoped(sessionId, rp)
          if (scoped === 'deny') return { kind: 'deny', reason: 'fs.write denied: subagent session' }
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
        if (this.spillRoots.some((r) => isWithin(rp, r))) {
          return { kind: 'deny', reason: `fs.delete denied: ${p.arg} is inside spill root` }
        }
        const roSub = this.readOnlySubpathOf(rp)
        if (roSub !== undefined) {
          return { kind: 'deny', reason: `fs.delete denied: ${p.arg} is inside read-only subpath '${roSub}'` }
        }
        // 删除恒 ask，唯一例外：活跃子会话删自己 roots 之外的全局工作区文件——
        // 这不是「要不要批准」的问题，而是子会话根本没有那份权限。
        const row = this.sessionRow(sessionId)
        if (row !== undefined && row.kind === 'subagent' && row.releasedAtMs === null
          && this.workspaceRoots.some((r) => isWithin(rp, r))
          && !this.inSessionRoots(row, rp)) {
          return { kind: 'deny', reason: 'fs.delete denied: subagent session' }
        }
        return { kind: 'ask', reason: `fs.delete requires per-call approval: ${p.arg}` }
      }
      case 'system':
        return { kind: 'ask', reason: `system:${p.arg} requires per-call approval` }
      case 'net': {
        // 白名单优先于 grant：常用域名不该每次弹审批。
        // 白名单为空时行为与改动前完全一致（全部 ask）。
        if (this.hostAllowed(p.arg)) return { kind: 'allow', via: 'policy' }
        const g = grants.find((g) => g.capability === c)
        if (g) return { kind: 'allow', via: 'grant', grantId: g.grantId }
        return { kind: 'ask', reason: `no active grant for ${c}` }
      }
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
    const grants = this.grantsForSession(call.sessionId)
    const results = call.capabilities.map((c) => this.evalCap(c, grants, call.sessionId))

    const deny = results.find((r) => r.kind === 'deny')
    if (deny) return { kind: 'deny', reason: (deny as { reason: string }).reason }

    const asks = results.filter((r) => r.kind === 'ask')
    if (asks.length > 0) {
      // 一次性批准：callId 未消费、会话一致、且记录的能力覆盖本次全部能力 → ask 变 once。
      //
      // 会话必须一并比：批准是「给某会话的某一次调用」的，只比 capabilities 时，
      // 同 callId 换个 sessionId 就能复用别人问出来的批准（父会话 → 子会话静默通过）。
      // 空 sessionId 一律不 covered——运行时确实存在空会话 id，不能把「没有会话」
      // 当成「任何会话」，否则去掉 callId 唯一性假设就整条旁路了。
      const once = this.audit.getOnce(call.callId)
      const recorded = once ? new Set(once.capabilities.map(capabilityKey)) : null
      const covered = recorded !== null && !once!.consumed
        && call.sessionId !== ''
        && once!.sessionId === call.sessionId
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
          // 「总是允许」是「给这个会话的」，不是「给整台机器的」：子会话问出来的
          // always 不能变成全局授予，否则一次审批就能把小孩升级成主人。
          sessionId: d.sessionId,
        },
      })),
    ]
    this.audit.appendBatch(entries)
    return { grantIds: grants.map((g) => g.grantId) }
  }

  /** 所有者通道：签发授予，返回 grantId。`sessionId` 缺省 = 全局授予。 */
  issueGrant(g: { subject: 'model'; capability: Capability; expiresAt: number | null; sessionId?: string }): string {
    if (g.subject !== 'model') raise('INVALID_INPUT', `subject must be 'model': ${String(g.subject)}`)
    parseCapability(g.capability) // 校验结构
    if (g.expiresAt !== null && (typeof g.expiresAt !== 'number' || !Number.isFinite(g.expiresAt))) {
      raise('INVALID_INPUT', 'expiresAt must be a number or null')
    }
    if (g.sessionId !== undefined && (typeof g.sessionId !== 'string' || g.sessionId === '')) {
      raise('INVALID_INPUT', 'sessionId must be a non-empty string when given')
    }
    const grantId = `grant-${randomUUID()}`
    this.audit.append(OWNER, {
      kind: 'grant.issued', grantId, subject: g.subject, capability: g.capability, expiresAt: g.expiresAt,
      ...(g.sessionId === undefined ? {} : { sessionId: g.sessionId }),
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
      .map((g) => ({ grantId: g.grantId, subject: g.subject, capability: g.capability, expiresAt: g.expiresAt, issuedAt: g.issuedAt, sessionId: g.sessionId }))
  }
}
