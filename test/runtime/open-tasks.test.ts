/**
 * W5：启动时把未结任务列出来作为线索——只列出，不自动恢复。
 *
 * 对应前瞻记忆的「线索触发」：博士看到上次没做完的事，自己决定接不接。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeOpenTasks } from '../../src/cli/chat.ts'
import { openTmp, owner, model } from '../ledger/helpers.ts'

test('W5: 空账本不输出任何东西', () => {
  const c = openTmp()
  try {
    assert.equal(describeOpenTasks(c.ledger), '')
  } finally { c.cleanup() }
})

test('W5: 列出 draft / active / blocked，不列已终结的', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const draft = l.create(model('s'), { title: '草案', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const active = l.create(owner, { title: '进行中', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.activate(owner, { id: active.id, revision: active.revision })
    const blocked = l.create(owner, { title: '被卡住', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const b = l.activate(owner, { id: blocked.id, revision: blocked.revision })
    l.block(owner, { id: blocked.id, revision: b.revision }, { code: 'wait', message: '等博士' })
    const gone = l.create(owner, { title: '已取消', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.cancel(owner, { id: gone.id, revision: gone.revision })

    const text = describeOpenTasks(l)
    console.log('[w5] text =\n' + text)
    assert.ok(text.includes(draft.id), 'draft 没列出来')
    assert.ok(text.includes(active.id), 'active 没列出来')
    assert.ok(text.includes(blocked.id), 'blocked 没列出来')
    assert.ok(!text.includes(gone.id), '已取消的任务不该出现')
    assert.ok(text.includes('draft') && text.includes('active') && text.includes('blocked'), '缺少状态标注')
  } finally { c.cleanup() }
})
