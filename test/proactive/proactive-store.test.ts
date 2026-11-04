/**
 * V1-07 主动回忆 —— 存储层验收。
 *
 * 架构需求 §7 V1-07：「7 天试用中出现自然提起过去的情况，博士认为恰当的占比
 * 至少 70%；**可以关闭**」。
 *
 * 70% 是人工评价指标，自动化只能钉住它的**前提**：每次主动提起都被如实留痕，
 * 否则事后无法抽样评价。这一层测的就是留痕与冷却这两件可判定的事。
 *
 * 基线预期：`src/proactive/` 尚不存在，本文件 import 失败 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openProactiveStore } from '../../src/proactive/index.ts'
import { makeTmp } from '../support/tmp.ts'

const DAY = 86_400_000

function fresh() {
  const t = makeTmp('prts-proactive-s-')
  const store = openProactiveStore(t.db('proactive.sqlite'))
  return { t, store }
}

test('PS1 空库：没有任何留痕，计数为 0', () => {
  const { t, store } = fresh()
  try {
    assert.deepEqual(store.list(), [])
    assert.equal(store.countBySession('s1'), 0)
    assert.equal(store.isCoolingDown('mem-1', Date.now()), false)
  } finally { store.close(); t.cleanup() }
})

test('PS2 记录一次主动提起：字段完整可查', () => {
  const { t, store } = fresh()
  try {
    const now = 1_700_000_000_000
    store.record({ sessionId: 's1', turn: 3, memoryId: 'mem-1', kind: 'fact', score: 1.25, mentionedAtMs: now })
    const rows = store.list()
    assert.equal(rows.length, 1)
    const r = rows[0]!
    assert.equal(r.sessionId, 's1')
    assert.equal(r.turn, 3)
    assert.equal(r.memoryId, 'mem-1')
    assert.equal(r.kind, 'fact')
    assert.equal(r.score, 1.25)
    assert.equal(r.mentionedAtMs, now)
    assert.equal(typeof r.id, 'number')
  } finally { store.close(); t.cleanup() }
})

test('PS3 冷却：7 天内为 true，7 天后为 false', () => {
  const { t, store } = fresh()
  try {
    const now = 1_700_000_000_000
    store.record({ sessionId: 's1', turn: 1, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: now })
    assert.equal(store.isCoolingDown('mem-1', now + 6 * DAY), true, '第 6 天仍在冷却期')
    assert.equal(store.isCoolingDown('mem-1', now + 7 * DAY + 1), false, '7 天整之后解除')
    assert.equal(store.isCoolingDown('mem-2', now + 6 * DAY), false, '没提过的记忆不冷却')
  } finally { store.close(); t.cleanup() }
})

test('PS4 会话隔离：countBySession 只算本会话', () => {
  const { t, store } = fresh()
  try {
    const now = 1_700_000_000_000
    store.record({ sessionId: 's1', turn: 1, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: now })
    store.record({ sessionId: 's1', turn: 5, memoryId: 'mem-2', kind: 'fact', score: 1, mentionedAtMs: now })
    store.record({ sessionId: 's2', turn: 1, memoryId: 'mem-3', kind: 'fact', score: 1, mentionedAtMs: now })
    assert.equal(store.countBySession('s1'), 2)
    assert.equal(store.countBySession('s2'), 1)
    assert.equal(store.countBySession('s3'), 0)
    assert.equal(store.list({ sessionId: 's2' }).length, 1)
  } finally { store.close(); t.cleanup() }
})

test('PS5 只追加：同一条记忆被记录两次时保留两条历史（轨迹不能被覆盖）', () => {
  const { t, store } = fresh()
  try {
    const now = 1_700_000_000_000
    store.record({ sessionId: 's1', turn: 1, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: now })
    store.record({ sessionId: 's2', turn: 1, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: now + DAY })
    assert.equal(store.list().length, 2, '两次提起是两条事实，不能合成一条')
    assert.equal(store.list().filter((r) => r.memoryId === 'mem-1').length, 2)
  } finally { store.close(); t.cleanup() }
})
