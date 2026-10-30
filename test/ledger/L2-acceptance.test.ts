import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openTmp, owner, model, expectCodeAsync } from './helpers.ts'

test('L2: checks 验收失败回到 active 并带原因；全通过到 done', async () => {
  const c = openTmp()
  try {
    const artifact = join(c.dir, 'out.txt')
    writeFileSync(artifact, 'hello prts')
    const sha = createHash('sha256').update('hello prts').digest('hex')

    const missing = join(c.dir, 'missing.txt')
    const t = c.ledger.create(owner, {
      title: 'T', objective: 'O',
      acceptance: { kind: 'checks', checks: [{ kind: 'file-exists', path: missing }] },
    })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    const v = c.ledger.claimDone(model(), { id: a.id, revision: a.revision })
    assert.equal(v.phase, 'verifying')

    const r1 = await c.ledger.verify({ id: v.id, revision: v.revision })
    assert.equal(r1.phase, 'active')
    assert.ok(r1.lastRejection && r1.lastRejection.length > 0)

    // 换成正确校验：文件存在 + sha256 匹配 → done
    const t2 = c.ledger.create(owner, {
      title: 'T2', objective: 'O',
      acceptance: {
        kind: 'checks',
        checks: [
          { kind: 'file-exists', path: artifact },
          { kind: 'file-sha256', path: artifact, sha256: sha },
        ],
      },
    })
    const a2 = c.ledger.activate(owner, { id: t2.id, revision: t2.revision })
    const v2 = c.ledger.claimDone(model(), { id: a2.id, revision: a2.revision })
    const r2 = await c.ledger.verify({ id: v2.id, revision: v2.revision })
    assert.equal(r2.phase, 'done')

    // sha256 不符 → 回 active
    const t3 = c.ledger.create(owner, {
      title: 'T3', objective: 'O',
      acceptance: { kind: 'checks', checks: [{ kind: 'file-sha256', path: artifact, sha256: '0'.repeat(64) }] },
    })
    const a3 = c.ledger.activate(owner, { id: t3.id, revision: t3.revision })
    const v3 = c.ledger.claimDone(model(), { id: a3.id, revision: a3.revision })
    const r3 = await c.ledger.verify({ id: v3.id, revision: v3.revision })
    assert.equal(r3.phase, 'active')
    assert.ok(r3.lastRejection && r3.lastRejection.length > 0)
  } finally {
    c.cleanup()
  }
})

test('L2: owner-confirm 任务由 owner 裁定', async () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    const v = c.ledger.claimDone(model(), { id: a.id, revision: a.revision })
    assert.equal(v.phase, 'verifying')

    await expectCodeAsync(() => c.ledger.verify({ id: v.id, revision: v.revision }), 'INVALID_TRANSITION')

    const rej = c.ledger.ownerReject({ id: v.id, revision: v.revision }, '界面截图不对')
    assert.equal(rej.phase, 'active')
    assert.equal(rej.lastRejection, '界面截图不对')

    const a2 = c.ledger.claimDone(model(), { id: rej.id, revision: rej.revision })
    const done = c.ledger.ownerAccept({ id: a2.id, revision: a2.revision })
    assert.equal(done.phase, 'done')
  } finally {
    c.cleanup()
  }
})
