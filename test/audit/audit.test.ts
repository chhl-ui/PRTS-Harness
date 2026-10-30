import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog } from '../../src/audit/index.ts'
import { makeTmp } from '../support/tmp.ts'
import type { AuditActor, AuditEvent } from '../../src/audit/index.ts'

const owner: AuditActor = { kind: 'owner' }
const sys = (c: 'authority' | 'stop' | 'supervisor' | 'integrity' | 'deletion'): AuditActor => ({ kind: 'system', component: c })
const model = (s = 's1'): AuditActor => ({ kind: 'model', sessionId: s })

function tmp() {
  const t = makeTmp('prts-audit-')
  return {
    dir: t.dir,
    db: t.db('a.sqlite'),
    cleanup(...closables: { close(): void }[]) { t.cleanup(...closables) },
  }
}
function code(fn: () => unknown): string | undefined {
  try { fn() } catch (e) { return (e as { code?: string }).code }
  assert.fail('expected throw')
}

test('append 各类 kind + query 过滤', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.append(sys('authority'), { kind: 'grant.issued', grantId: 'g1', subject: 'agent', capability: 'tool:pwsh', expiresAt: null })
    a.append(sys('authority'), { kind: 'grant.revoked', grantId: 'g1', reason: 'r' })
    a.append(sys('integrity'), { kind: 'integrity.checked', ok: true, detail: 'd' })
    a.append(model(), { kind: 'tool.denied', sessionId: 's1', tool: 'pwsh', reason: 'no grant' })
    a.append(owner, { kind: 'stop.requested', level: 'S2' })
    a.append(sys('stop'), { kind: 'stop.completed', level: 'S2', durationMs: 900 })
    a.append(owner, { kind: 'plugin.approved', pluginId: 'p1', contentSha256: 'a'.repeat(64) })
    a.append(owner, { kind: 'plugin.rejected', pluginId: 'p2', contentSha256: 'b'.repeat(64), reason: 'r' })
    a.append(owner, { kind: 'approval.decided', sessionId: 's1', tool: 'pwsh', outcome: 'allowed-once', grantId: 'g2' })
    a.append(owner, { kind: 'undo.performed', target: { kind: 'file', id: 'f1' }, detail: 'restored' })

    const all = a.query()
    assert.equal(all.length, 10)
    assert.deepEqual(all.map(r => r.seq), all.map((_, i) => i + 1))
    assert.equal(all[0].event.kind, 'grant.issued')
    assert.equal(all[0].actor.kind, 'system')

    const denied = a.query({ kinds: ['tool.denied'] })
    assert.equal(denied.length, 1)
    const limited = a.query({ limit: 2 })
    assert.deepEqual(limited.map(r => r.seq), [9, 10])
    const ranged = a.query({ since: all[4].ts, until: all[5].ts })
    assert.deepEqual(ranged.map(r => r.seq), [5, 6])
    const combo = a.query({ kinds: ['stop.requested', 'stop.completed'], limit: 1 })
    assert.equal(combo[0].event.kind, 'stop.completed')
    const chain = a.verifyChain()
    assert.equal(chain.ok, true)
    if (chain.ok) assert.equal(chain.events, 10)
  } finally { t.cleanup(a) }
})

test('deletion 流程：逐项完成自动补 deletion.completed', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.append(sys('deletion'), {
      kind: 'deletion.requested', deletionId: 'd1',
      target: { kind: 'task', id: 't1' },
      derivatives: [{ kind: 'session', ref: 's1' }, { kind: 'session', ref: 's2' }, { kind: 'evidence', ref: 'e1' }],
    })
    a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 0 })
    a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 1 })
    let d = a.deletion('d1')
    assert.equal(d.completed, false)
    assert.deepEqual(d.derivatives.map(x => x.done), [true, true, false])

    const before = a.exportDoc().events.length
    a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 2 })
    const events = a.exportDoc().events
    assert.equal(events.length, before + 2) // derivative-done + 自动 completed
    assert.equal(events[events.length - 1].kind, 'deletion.completed')
    assert.deepEqual(events[events.length - 1].actor, { kind: 'system', component: 'deletion' })
    d = a.deletion('d1')
    assert.equal(d.completed, true)
    assert.ok(d.completedAt !== null)

    // 错误码
    assert.equal(code(() => a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 0 })), 'INVALID_TRANSITION') // 已完成
    assert.equal(code(() => a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'nope', index: 0 })), 'NOT_FOUND')
    assert.equal(code(() => a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 9 })), 'INVALID_INPUT')
    assert.equal(code(() => a.append(owner, { kind: 'deletion.completed', deletionId: 'd1' })), 'INVALID_INPUT')
    assert.equal(code(() => a.append(sys('deletion'), {
      kind: 'deletion.requested', deletionId: 'd1',
      target: { kind: 'task', id: 't2' }, derivatives: [{ kind: 'x', ref: 'y' }],
    })), 'INVALID_TRANSITION')
    // 重复标记未完成项 → INVALID_TRANSITION + 事务回滚
    const t2 = tmp()
    const a2 = AuditLog.open(t2.db)
    try {
      a2.append(sys('deletion'), {
        kind: 'deletion.requested', deletionId: 'd2',
        target: { kind: 'task', id: 't' }, derivatives: [{ kind: 's', ref: '1' }, { kind: 's', ref: '2' }],
      })
      a2.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd2', index: 0 })
      const n = a2.exportDoc().events.length
      assert.equal(code(() => a2.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd2', index: 0 })), 'INVALID_TRANSITION')
      assert.equal(a2.exportDoc().events.length, n)
    } finally { t2.cleanup(a2) }
  } finally { t.cleanup(a) }
})

test('每 kind 至少一个非法输入 → INVALID_INPUT', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    const bad: AuditEvent[] = [
      { kind: 'grant.issued', grantId: '', subject: 's', capability: 'c', expiresAt: null } as AuditEvent,
      { kind: 'grant.revoked', grantId: 'g', reason: '' } as AuditEvent,
      { kind: 'tool.denied', sessionId: '', tool: 't', reason: 'r' } as AuditEvent,
      { kind: 'approval.decided', sessionId: 's', tool: 't', outcome: 'bogus' as never },
      { kind: 'stop.requested', level: 'S9' as never },
      { kind: 'stop.completed', level: 'S1', durationMs: 'x' as never },
      { kind: 'plugin.approved', pluginId: 'p', contentSha256: '' } as AuditEvent,
      { kind: 'plugin.rejected', pluginId: 'p', contentSha256: 'x', reason: '' } as AuditEvent,
      { kind: 'integrity.checked', ok: 'yes' as never, detail: 'd' },
      { kind: 'undo.performed', target: { kind: '', id: 'i' }, detail: 'd' } as AuditEvent,
      { kind: 'deletion.requested', deletionId: 'd', target: { kind: 't', id: 'i' }, derivatives: [] } as AuditEvent,
      { kind: 'deletion.derivative-done', deletionId: 'd', index: -1 },
      { kind: 'deletion.completed', deletionId: 'd' },
      { kind: 'bogus' } as unknown as AuditEvent,
    ]
    for (const e of bad) assert.equal(code(() => a.append(owner, e)), 'INVALID_INPUT', e.kind)
    assert.equal(a.exportDoc().events.length, 0)
  } finally { t.cleanup(a) }
})

test('重建 + 导出导入 + 篡改', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.append(sys('deletion'), {
      kind: 'deletion.requested', deletionId: 'd1',
      target: { kind: 'task', id: 't1' }, derivatives: [{ kind: 's', ref: '1' }, { kind: 's', ref: '2' }],
    })
    a.append(sys('deletion'), { kind: 'deletion.derivative-done', deletionId: 'd1', index: 0 })
    a.append(owner, { kind: 'grant.issued', grantId: 'g', subject: 's', capability: 'tool:x', expiresAt: null })
    const want = { del: a.deletion('d1'), doc: a.exportDoc() }
    a.rebuildProjections()
    assert.deepEqual(a.deletion('d1'), want.del)

    const t2 = makeTmp('prts-aimp-')
    const a2 = AuditLog.importDoc(t2.db('a.sqlite'), want.doc)
    try {
      assert.equal(a2.verifyChain().ok, true)
      assert.deepEqual(a2.deletion('d1'), want.del)
    } finally { t2.cleanup(a2) }

    const bad = JSON.parse(JSON.stringify(want.doc))
    bad.events[2].payload = { hacked: true }
    const t3 = makeTmp('prts-aimp2-')
    const a3Holder: { a?: AuditLog } = {}
    try {
      assert.equal(code(() => AuditLog.importDoc(t3.db('a.sqlite'), bad)), 'CHAIN_BROKEN')
      a3Holder.a = AuditLog.open(t3.db('a.sqlite'))
      assert.equal(a3Holder.a.exportDoc().events.length, 0)
    } finally { t3.cleanup(...(a3Holder.a ? [a3Holder.a] : [])) }
  } finally { t.cleanup(a) }
})
