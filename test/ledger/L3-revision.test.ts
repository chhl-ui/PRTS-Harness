import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTmp, owner, model, expectCode } from './helpers.ts'

test('L3: 过期修订被拒，事件数不变', () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision }) // revision 2
    const eventsBefore = c.ledger.exportDoc().events.length

    expectCode(() => c.ledger.pause(owner, { id: t.id, revision: 1 }), 'STALE_REVISION')
    expectCode(() => c.ledger.note(model(), { id: t.id, revision: 99 }, 'x'), 'STALE_REVISION')
    assert.equal(c.ledger.exportDoc().events.length, eventsBefore)
    assert.equal(c.ledger.get(t.id).revision, a.revision)
    assert.equal(c.ledger.get(t.id).phase, 'active')

    // 最新修订可以写
    const p = c.ledger.pause(owner, { id: t.id, revision: a.revision })
    assert.equal(p.phase, 'paused')
    assert.equal(p.revision, a.revision + 1)
  } finally {
    c.cleanup()
  }
})
