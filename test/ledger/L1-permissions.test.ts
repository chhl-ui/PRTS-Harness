import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTmp, owner, model, system, expectCode, expectCodeAsync } from './helpers.ts'

// L1：model 无法让任务到 done。
// actor 自由传入的写路径全部受权限矩阵约束；
// ownerAccept/ownerReject/verify/chargeUsage/stopByOwner/recoverOnStartup
// 签名上就不收 actor（固定 actor），模型侧没有可表达的调用面，宿主层（K2/K5）负责不外露。
test('L1: model 不能 activate / cancel / 越过 verifying 到 done', async () => {
  const c = openTmp()
  try {
    const t = c.ledger.create(model(), { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    assert.equal(t.phase, 'draft')
    assert.equal(t.revision, 1)

    expectCode(() => c.ledger.activate(model(), { id: t.id, revision: t.revision }), 'FORBIDDEN')
    expectCode(() => c.ledger.cancel(model(), { id: t.id, revision: t.revision }), 'FORBIDDEN')
    expectCode(() => c.ledger.resumeFromStop(model(), { id: t.id, revision: t.revision }), 'FORBIDDEN')
    assert.equal(c.ledger.get(t.id).phase, 'draft')
    assert.equal(c.ledger.get(t.id).revision, 1)

    const a = c.ledger.activate(owner, { id: t.id, revision: 1 })
    const v = c.ledger.claimDone(model(), { id: a.id, revision: a.revision })
    assert.equal(v.phase, 'verifying')

    // owner-confirm 任务：确定性校验器路径也不存在
    await expectCodeAsync(async () => c.ledger.verify({ id: v.id, revision: v.revision }), 'INVALID_TRANSITION')
    assert.equal(c.ledger.get(t.id).phase, 'verifying')

    // system actor 不能混进自由 actor 参数
    expectCode(() => c.ledger.note(system('verifier'), { id: t.id, revision: v.revision }, 'x'), 'FORBIDDEN')
  } finally {
    c.cleanup()
  }
})
