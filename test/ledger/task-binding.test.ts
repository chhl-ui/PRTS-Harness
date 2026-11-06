/**
 * W2：session ↔ task 绑定必须落在账本里，不能放 runtime 内存 Map。
 *
 * 关键断言是「跨实例可见」——同一 sqlite 另开一个 Ledger 能看到绑定，
 * 等价于进程重启后的情形。内存方案在这里必然失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Ledger } from '../../src/ledger/index.ts'
import { makeTmp } from '../support/tmp.ts'
import { openTmp, owner, model, expectCode } from './helpers.ts'

const mk = (l: Ledger, actor: Parameters<Ledger['create']>[0], title = 'T') =>
  l.create(actor, { title, objective: 'O', acceptance: { kind: 'owner-confirm' } })

test('W2: bindSession 后 taskForSession 能查到；跨实例（模拟重启）仍能查到', () => {
  const td = makeTmp('prts-bind-')
  const db = join(td.dir, 'ledger.sqlite')
  const l1 = Ledger.open(db)
  const l2 = Ledger.open(db)
  try {
    const t = mk(l1, owner)
    l1.bindSession(owner, { id: t.id, revision: t.revision }, 'sess-1')

    const found = l1.taskForSession('sess-1')
    assert.ok(found, '本实例查不到刚建立的绑定')
    assert.equal(found.id, t.id)

    // 另一个 Ledger 实例（等价于进程重启后新起的 runtime）必须也能看到
    const other = l2.taskForSession('sess-1')
    assert.ok(other, '跨实例查不到绑定——说明绑定没落账本')
    assert.equal(other.id, t.id)

    assert.equal(l1.taskForSession('nobody'), undefined)
  } finally { td.cleanup(l1, l2) }
})

test('W2: 一个 session 不能同时绑两个未结任务', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const a = mk(l, owner, 'A')
    const b = mk(l, owner, 'B')
    l.bindSession(owner, { id: a.id, revision: a.revision }, 'sess-1')
    expectCode(() => l.bindSession(owner, { id: b.id, revision: b.revision }, 'sess-1'), 'INVALID_TRANSITION')

    // 同一任务重复绑定是幂等的，不报错
    const again = l.bindSession(owner, { id: a.id, revision: l.get(a.id).revision }, 'sess-1')
    assert.equal(again.id, a.id)
  } finally { c.cleanup() }
})

test('W2: 任务终结后 taskForSession 不再返回它', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = mk(l, owner)
    l.bindSession(owner, { id: t.id, revision: t.revision }, 'sess-1')
    l.cancel(owner, { id: t.id, revision: l.get(t.id).revision })
    assert.equal(l.taskForSession('sess-1'), undefined, '已取消的任务不该再被查出来')
  } finally { c.cleanup() }
})

test('W2: 绑定能随导出文档重放——kind 不是孤事件', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = mk(l, owner)
    l.bindSession(owner, { id: t.id, revision: t.revision }, 'sess-1')
    const doc = l.exportDoc()
    assert.ok(doc.events.some((e) => e.kind === 'task.session-bound'), '导出里没有绑定事件')

    const td = makeTmp('prts-bind-replay-')
    try {
      const fresh = Ledger.importDoc(td.db('r.sqlite'), doc)
      const found = fresh.taskForSession('sess-1')
      assert.ok(found, '重放后查不到绑定——fold 没处理这个 kind')
      assert.equal(found.id, t.id)
      fresh.close()
    } finally { td.cleanup() }
  } finally { c.cleanup() }
})

/**
 * 「模型永不绑定」这条不变量此前只在工具面成立：`prts_task_*` 没暴露绑定，
 * 但库层 `MODEL_OPS` 里有 `bindSession`（`ledger.ts:123`）。任何新工具或内部
 * 调用只要用 model actor 走到这里，不变量就静默失效。
 *
 * 本用例钉库层这一侧：model 调 bindSession 必须 FORBIDDEN，owner 通道不受影响。
 */
test('W2: model actor 不能 bindSession——不变量在库层也成立', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = mk(l, model(), 'M')

    expectCode(
      () => l.bindSession(model(), { id: t.id, revision: l.get(t.id).revision }, 'sess-model'),
      'FORBIDDEN',
    )
    assert.equal(l.taskForSession('sess-model'), undefined, 'model 的绑定竟然落库了')

    // owner 通道照旧可用：收紧只针对 model，不伤所有者
    const bound = l.bindSession(owner, { id: t.id, revision: l.get(t.id).revision }, 'sess-owner')
    assert.equal(bound.id, t.id)
    assert.equal(l.taskForSession('sess-owner')?.id, t.id)
  } finally { c.cleanup() }
})
