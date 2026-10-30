import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openTmp, owner, model, system, expectCode } from './helpers.ts'

test('UNEXPECTED_STEP：同一步号不同名', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    c.ledger.activate(owner, { id: t.id, revision: t.revision })
    c.ledger.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true })
    expectCode(() => c.ledger.beginStep(owner, t.id, { stepNo: 1, name: 'b', idempotent: true }), 'UNEXPECTED_STEP')
  } finally { c.cleanup() }
})

test('STEP_NOT_STARTED：结束未开始的步骤', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    c.ledger.activate(owner, { id: t.id, revision: t.revision })
    expectCode(() => c.ledger.endStep(owner, t.id, 7, { status: 'succeeded' }), 'STEP_NOT_STARTED')
  } finally { c.cleanup() }
})

test('TASK_STOPPED / resumeFromStop', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.activate(owner, { id: t.id, revision: t.revision })
    const stopped = l.stopByOwner(t.id)
    assert.equal(stopped?.phase, 'stopped-by-owner')
    // 已 stopped → null（无转移）
    assert.equal(l.stopByOwner(t.id), null)
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true }), 'TASK_STOPPED')
    expectCode(() => l.retryUnknownStep(owner, t.id, 1), 'TASK_STOPPED')
    const paused = l.resumeFromStop(owner, { id: t.id, revision: l.get(t.id).revision })
    assert.equal(paused.phase, 'paused')
    const active = l.resume(owner, { id: t.id, revision: paused.revision })
    assert.equal(active.phase, 'active')
    // 终态 → null
    const t2 = l.create(owner, { title: 'T2', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a2 = l.activate(owner, { id: t2.id, revision: t2.revision })
    const v2 = l.claimDone(owner, { id: a2.id, revision: a2.revision })
    l.ownerAccept({ id: v2.id, revision: v2.revision })
    assert.equal(l.stopByOwner(t2.id), null)
    // cancel → stopped 也可达 cancelled
    const t3 = l.create(owner, { title: 'T3', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.activate(owner, { id: t3.id, revision: t3.revision })
    const c3 = l.cancel(owner, { id: t3.id, revision: l.get(t3.id).revision })
    assert.equal(c3.phase, 'cancelled')
    expectCode(() => l.beginStep(owner, t3.id, { stepNo: 1, name: 'a', idempotent: true }), 'TASK_STOPPED')
  } finally { c.cleanup() }
})

test('chargeUsage 超预算 → blocked budget-exceeded', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' }, budget: { maxRounds: 3, maxCostUsd: 1 } })
    l.activate(owner, { id: t.id, revision: t.revision })
    let s = l.chargeUsage(t.id, { rounds: 3 })
    assert.equal(s.phase, 'active') // 等于上限不阻塞（严格超出才转）
    s = l.chargeUsage(t.id, { rounds: 1 })
    assert.equal(s.phase, 'blocked')
    assert.equal(s.blockedReason?.code, 'budget-exceeded')
    assert.equal(s.usage.rounds, 4)
    expectCode(() => l.chargeUsage(t.id, { rounds: -1 }), 'INVALID_INPUT')
  } finally { c.cleanup() }
})

test('终态不可变 + INVALID_INPUT + NOT_FOUND', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    const v = l.claimDone(owner, { id: a.id, revision: a.revision })
    const done = l.ownerAccept({ id: v.id, revision: v.revision })
    expectCode(() => l.note(owner, { id: done.id, revision: done.revision }, 'x'), 'INVALID_TRANSITION')
    expectCode(() => l.cancel(owner, { id: done.id, revision: done.revision }), 'INVALID_TRANSITION')
    expectCode(() => l.activate(owner, { id: done.id, revision: done.revision }), 'INVALID_TRANSITION')

    expectCode(() => l.create(owner, { title: '  ', objective: 'O', acceptance: { kind: 'owner-confirm' } }), 'INVALID_INPUT')
    expectCode(() => l.get('task-nope' as never), 'NOT_FOUND')
    const t2 = l.create(owner, { title: 'T2', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a2 = l.activate(owner, { id: t2.id, revision: t2.revision })
    const v2 = l.claimDone(owner, { id: a2.id, revision: a2.revision })
    expectCode(() => l.ownerReject({ id: v2.id, revision: v2.revision }, ''), 'INVALID_INPUT')
    expectCode(() => l.beginStep(owner, t2.id, { stepNo: 0, name: 'x', idempotent: true }), 'INVALID_INPUT')
    expectCode(() => l.beginStep(owner, t2.id, { stepNo: 1.5, name: 'x', idempotent: true }), 'INVALID_INPUT')
  } finally { c.cleanup() }
})

test('非 active 不能跑步骤；paused/blocked/verifying → INVALID_TRANSITION', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    // draft 状态
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true }), 'INVALID_TRANSITION')
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    const p = l.pause(owner, { id: a.id, revision: a.revision })
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true }), 'INVALID_TRANSITION')
    const r = l.resume(owner, { id: t.id, revision: p.revision })
    const b = l.block(model(), { id: t.id, revision: r.revision }, { code: 'x', message: 'm' })
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true }), 'INVALID_TRANSITION')
    const u = l.unblock(owner, { id: t.id, revision: b.revision })
    const v = l.claimDone(model(), { id: u.id, revision: u.revision })
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true }), 'INVALID_TRANSITION')
    void v
  } finally { c.cleanup() }
})

test('beginStep recorded / 重复 started 名字冲突；list 过滤；note 改 revision', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.activate(owner, { id: t.id, revision: t.revision })
    l.beginStep(owner, t.id, { stepNo: 1, name: 'a', idempotent: true })
    l.endStep(owner, t.id, 1, { status: 'failed' })
    const again = l.beginStep(model(), t.id, { stepNo: 1, name: 'a', idempotent: true })
    assert.equal(again.kind, 'recorded')
    if (again.kind === 'recorded') assert.equal(again.step.status, 'failed')
    // started 状态下重 begin → UNEXPECTED_STEP
    l.beginStep(owner, t.id, { stepNo: 2, name: 'b', idempotent: true })
    expectCode(() => l.beginStep(owner, t.id, { stepNo: 2, name: 'b', idempotent: true }), 'UNEXPECTED_STEP')

    const t2 = l.create(owner, { title: 'T2', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    assert.equal(l.list({ phase: 'draft' }).length, 1)
    assert.equal(l.list({ phase: 'active' }).length, 1)
    assert.equal(l.list().length, 2)

    const revBefore = l.get(t2.id).revision
    const noted = l.note(model(), { id: t2.id, revision: revBefore }, 'hi')
    assert.equal(noted.revision, revBefore + 1)
    expectCode(() => l.note(model(), { id: t2.id, revision: revBefore }, 'stale'), 'STALE_REVISION')
    // system actor 走自由 actor 方法被拒
    expectCode(() => l.note(system('budget'), { id: t2.id, revision: noted.revision }, 'x'), 'FORBIDDEN')
    const sr = l.setResume(model(), { id: t2.id, revision: noted.revision }, { next: 'n1', open: ['o1'] })
    assert.equal(sr.resume.next, 'n1')
    assert.deepEqual(sr.resume.open, ['o1'])
  } finally { c.cleanup() }
})
