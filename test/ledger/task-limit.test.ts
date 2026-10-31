/**
 * W1：任务并发上限与 draft→activate 语义。
 *
 * 两条规则：
 *  - 模型建的任务停在 draft，等 owner 批准才 activate；模型的未结任务数有上限（默认 4），
 *    owner 通道不受限——博士正在推进的工作不能被账本策略挡住。
 *  - activate 只由 owner 执行（MODEL_OPS 不含 activate），模型调用必须 FORBIDDEN。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openTmp, owner, model, expectCode } from './helpers.ts'

const mk = (l: ReturnType<typeof openTmp>['ledger'], actor: Parameters<typeof l.create>[0]) =>
  l.create(actor, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })

test('W1: model 建任务受上限约束（默认 4），owner 不受限', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    for (let i = 0; i < 4; i++) {
      const t = mk(l, model(`s-${i}`))
      assert.equal(t.phase, 'draft', '新建任务应停在 draft')
    }
    // 第 5 个：模型侧必须被拒
    expectCode(() => mk(l, model('s-over')), 'TASK_LIMIT')
    // owner 不受上限约束
    const ow = mk(l, owner)
    assert.equal(ow.phase, 'draft')
    assert.equal(l.list().length, 5, 'owner 那一条应当建成')
  } finally { c.cleanup() }
})

test('W1: activate 只由 owner 执行，model 调用 FORBIDDEN', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = mk(l, model('s'))
    expectCode(() => l.activate(model('s'), { id: t.id, revision: t.revision }), 'FORBIDDEN')
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    assert.equal(a.phase, 'active')
  } finally { c.cleanup() }
})

test('W1: 上限统计的是未结任务，cancel 之后模型可以再建', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(mk(l, model(`s-${i}`)).id)
    expectCode(() => mk(l, model('s-over')), 'TASK_LIMIT')
    // 取消一个 → 腾出名额
    const first = l.get(ids[0] as never)
    l.cancel(owner, { id: first.id, revision: first.revision })
    const again = mk(l, model('s-again'))
    assert.equal(again.phase, 'draft')
  } finally { c.cleanup() }
})
