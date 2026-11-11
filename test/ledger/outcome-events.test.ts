/**
 * 账本结局读通道（DESIGN-04）：outcomeEvents 的映射与口径。
 *
 * 钉住三件事：只认验收结局（claimDone 不算——那是模型自报）；
 * cancelled / stopped 不算（那是博士决策）；先拒后收产出两条回合记录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTmp, owner, model } from './helpers.ts'

test('OE1 owner 验收：先拒后收 → failure + success 两条，按 seq 排序', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    const v = c.ledger.claimDone(model(), { id: a.id, revision: a.revision })
    assert.deepEqual(c.ledger.outcomeEvents(), [], 'claimDone 是自报，不进结局通道')
    const rej = c.ledger.ownerReject({ id: v.id, revision: v.revision }, '证据不对')
    const v2 = c.ledger.claimDone(model(), { id: rej.id, revision: rej.revision })
    c.ledger.ownerAccept({ id: v2.id, revision: v2.revision })
    const events = c.ledger.outcomeEvents()
    assert.equal(events.length, 2)
    assert.deepEqual(events.map((e) => e.outcome), ['failure', 'success'])
    assert.ok(events.every((e) => e.taskId === t.id))
    assert.ok(events[0].seq < events[1].seq, '按账本 seq 排序')
  } finally { c.cleanup() }
})

test('OE2 checks 验收：verified ok → success，不 ok → failure', async () => {
  const c = openTmp()
  try {
    const artifact = join(c.dir, 'out.txt')
    writeFileSync(artifact, 'hello')
    const missing = join(c.dir, 'missing.txt')
    const t = c.ledger.create(owner, {
      title: 'T', objective: 'O',
      acceptance: { kind: 'checks', checks: [{ kind: 'file-exists', path: missing }] },
    })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    const v = c.ledger.claimDone(model(), { id: a.id, revision: a.revision })
    await c.ledger.verify({ id: v.id, revision: v.revision })
    assert.deepEqual(c.ledger.outcomeEvents().map((e) => e.outcome), ['failure'])

    const t2 = c.ledger.create(owner, {
      title: 'T2', objective: 'O',
      acceptance: { kind: 'checks', checks: [{ kind: 'file-exists', path: artifact }] },
    })
    const a2 = c.ledger.activate(owner, { id: t2.id, revision: t2.revision })
    const v2 = c.ledger.claimDone(model(), { id: a2.id, revision: a2.revision })
    await c.ledger.verify({ id: v2.id, revision: v2.revision })
    const events = c.ledger.outcomeEvents()
    assert.equal(events.length, 2)
    assert.equal(events[1].outcome, 'success')
    assert.equal(events[1].taskId, t2.id)
  } finally { c.cleanup() }
})

test('OE3 cancelled / stopped 不归因：博士决策不是技能效果', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    c.ledger.cancel(owner, { id: a.id, revision: a.revision })
    const t2 = c.ledger.create(owner, { title: 'T2', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a2 = c.ledger.activate(owner, { id: t2.id, revision: t2.revision })
    c.ledger.stopByOwner(a2.id)
    assert.deepEqual(c.ledger.outcomeEvents(), [])
  } finally { c.cleanup() }
})

test('OE4 重建投影后结局通道不变：它读的是链，不是投影', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    // 带会话绑定再重建——2026-11-10 A7 实测：漏清 task_bindings 会撞外键。
    const bound = c.ledger.bindSession(owner, { id: a.id, revision: a.revision }, 'sess-oe4')
    const v = c.ledger.claimDone(model(), { id: bound.id, revision: bound.revision })
    c.ledger.ownerAccept({ id: v.id, revision: v.revision })
    // 另留一个未结的绑定任务，验证重建后绑定本身也被重放回来。
    const t2 = c.ledger.create(owner, { title: 'T2', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a2 = c.ledger.activate(owner, { id: t2.id, revision: t2.revision })
    c.ledger.bindSession(owner, { id: a2.id, revision: a2.revision }, 'sess-oe4-live')
    const before = c.ledger.outcomeEvents()
    c.ledger.rebuildProjections()
    assert.deepEqual(c.ledger.outcomeEvents(), before)
    assert.equal(c.ledger.taskForSession('sess-oe4-live')?.id, t2.id, '重建应重放出未结任务的绑定')
    assert.equal(c.ledger.taskForSession('sess-oe4'), undefined, '已 done 的任务不再返回绑定')
  } finally { c.cleanup() }
})