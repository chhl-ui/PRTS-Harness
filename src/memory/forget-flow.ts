/**
 * P0-2a 所有者流程：find（找回可删项）/ forget（计划→确认→执行+K4 记账）/ correct（纠正）。
 * CLI 与 chat 共用同一编排——两边不许各自实现一套删法，行为漂移就是数据事故。
 *
 * 顺序理由：先在 K4 记 `deletion.requested`，再动记忆库。中途崩溃 → K4 里留下
 * 未完成的删除，可见、可重跑；反过来「已删但无记录」无法事后追责。
 *
 * P0-2b 未做：会话日志删除（DSH 无删除与在用判定的公开接口，见 design doc）。
 * 本轮以 K4 未完成删除项如实记账——`session-log` derivative 保持未完成。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MemoryStore, MemoryHit, ForgetPlan } from './index.ts'
import type { AuditLog } from '../audit/audit.ts'

export interface OwnerHit { id: string; kind: string; time: string | null; text: string }

export function findForOwner(store: MemoryStore, query: string): OwnerHit[] {
  return store.search({ text: query, limit: 20, includeOrigin: ['live'], includeRetired: true, profileQuota: 5, summaryQuota: 5 })
    .map((h: MemoryHit) => ({
      id: h.id,
      kind: h.kind,
      time: h.occurredAtMs !== null && h.occurredAtMs !== undefined ? new Date(h.occurredAtMs).toISOString() : (h.occurredRaw ?? null),
      text: h.text.slice(0, 80),
    }))
}

interface SessionHit { sessionId: string; file: string }

/** 正文在 jsonl 里以 JSON 转义形态出现：查 `JSON.stringify(body).slice(1,-1)` 子串。 */
function scanSessionLogs(sessionsRoot: string, bodies: string[]): SessionHit[] {
  const hits: SessionHit[] = []
  if (!existsSync(sessionsRoot) || bodies.length === 0) return hits
  const needles = bodies.map(b => JSON.stringify(b).slice(1, -1)).filter(n => n.length > 0)
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (!e.name.startsWith('session') || !e.name.endsWith('.jsonl')) continue
      let content: string
      try { content = readFileSync(p, 'utf8') } catch { continue }
      if (needles.some(n => content.includes(n))) {
        // DSH 布局 sessions/--<cwd>--/<sessionId>/session.v4.jsonl——取父目录名。
        hits.push({ sessionId: basename(dirname(p)), file: p })
      }
    }
  }
  walk(sessionsRoot)
  return hits
}

export interface ForgetFlowResult {
  ok: boolean
  reason?: string
  plan?: ForgetPlan
  sessionHits?: SessionHit[]
  message: string
}

export function forgetFlow(opts: {
  store: MemoryStore
  audit?: AuditLog
  sessionsRoot?: string
  ids: string[]
  confirm: boolean
}): ForgetFlowResult {
  const { store, audit, sessionsRoot, ids, confirm } = opts
  const plan = store.planForget(ids)
  if (plan.turns.length === 0 && plan.facts.length === 0 && plan.profiles.length === 0 && plan.summaries.length === 0) {
    return { ok: false, reason: 'plan 为空：全部 id 不存在或已删除', plan, message: `没有可删除的目标（${plan.notFound.join(', ')}）` }
  }
  // 会话日志扫描在删之前做——执行后正文已清。只读，不落任何东西。
  const bodies: string[] = []
  for (const [kind, list] of [['turn', plan.turns], ['fact', plan.facts], ['summary', plan.summaries], ['profile', plan.profiles]] as const) {
    for (const id of list) {
      const b = store.readBodyForForget(kind as 'turn' | 'fact' | 'summary' | 'profile', id)
      if (b !== null && b !== '') bodies.push(b)
    }
  }
  const sessionHits = sessionsRoot === undefined ? [] : scanSessionLogs(sessionsRoot, bodies)

  const planText = `turn:${plan.turns.length} fact:${plan.facts.length} profile:${plan.profiles.length} summary:${plan.summaries.length}`
    + ` vectors:${plan.vectors} mentions:${plan.mentions} orphanEntities:${plan.orphanEntities} sessions:${plan.sessionsToRebuild.length}`
    + (plan.notFound.length > 0 ? ` notFound:[${plan.notFound.join(',')}]` : '')
    + (sessionHits.length > 0 ? ` 会话命中:[${sessionHits.map(h => h.sessionId).join(',')}]` : '')
  if (!confirm) {
    return { ok: true, plan, sessionHits, message: `删除计划（未执行）：${planText}\n加 --yes 执行。` }
  }
  if (audit === undefined) {
    return { ok: false, reason: 'audit 缺失', plan, sessionHits,
      message: '拒绝执行：confirm=true 必须有 audit（K4 记不起来就等于删了不记账）。' }
  }

  // K4 记账：每个顶层目标一条 deletion.requested；derivatives 依次 store/compact/session-log。
  const deletionIds: string[] = []
  for (const id of ids.filter(i => plan.turns.includes(i) || plan.facts.includes(i) || plan.profiles.includes(i) || plan.summaries.includes(i))) {
    const kind = id.startsWith('turn-') ? 'turn' : id.startsWith('fact-') ? 'fact' : id.startsWith('profile-') ? 'profile' : 'summary'
    const deletionId = `k4del-${randomUUID()}`
    audit.append({ kind: 'owner' }, {
      kind: 'deletion.requested', deletionId,
      target: { kind: `memory-${kind}`, id },
      derivatives: [
        { kind: 'memory-store', ref: 'memory.sqlite' },
        { kind: 'memory-compact', ref: 'memory.sqlite' },
        ...sessionHits.map(h => ({ kind: 'session-log', ref: h.sessionId })),
      ],
    })
    deletionIds.push(deletionId)
  }
  // 执行删除（事务内重算 plan——间隔写入被重新级联进来）。
  // store.forget 失败时 K4 requested 已登记——消息必须明说有哪些 id 挂着未执行的记录。
  const result = store.forget(ids, 'owner')
  if (!result.ok) {
    return { ok: false, reason: result.reason, plan, sessionHits,
      message: `删除失败：${result.reason}
K4 删除记录 ${deletionIds.join(', ')} 已登记但未执行（目标已不存在或 plan 为空）。` }
  }
  // K4 derivative-done 不吞错：写不进就是把「记忆已删但 K4 未完成」掩盖掉——抛出带 deletionId 的错误。
  for (const did of deletionIds) {
    try {
      audit.append({ kind: 'owner' }, { kind: 'deletion.derivative-done', deletionId: did, index: 0 })
      audit.append({ kind: 'owner' }, { kind: 'deletion.derivative-done', deletionId: did, index: 1 })
    } catch (e) {
      throw new Error(`记忆库已删除，但 K4 记账未完成：deletionId=${did}——${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const stillThere = sessionHits.map(h => h.sessionId).join(',')
  return {
    ok: true, plan: result.plan, sessionHits,
    message: `已删除：${planText}\n`
      + (sessionHits.length > 0 ? `会话日志仍含原文（deletion 未完成，P0-2b 才清）：${stillThere}\n` : '')
      + '当前对话上下文里已出现的内容不会因此消失。',
  }
}

export function correctFlow(opts: { store: MemoryStore; factId: string; object: string }): { ok: boolean; newFactId?: string; message: string } {
  const id = opts.store.correctFact({ factId: opts.factId, object: opts.object, actor: 'owner' })
  return { ok: true, newFactId: id, message: `已纠正：${opts.factId} → ${id}（旧值已退役并记 superseded_by）` }
}
