/**
 * 时钟第三路数据源：`MemoryStore.lonelyFacts` —— 惦记着的事。
 *
 * 这一路与前两路的区别是**不看时间截止**：到期意图看 `fire_at_ms`、停滞任务看
 * `updatedAt`，这里看 `importance` + `last_access_ms`。同一个定时器，读的东西
 * 不一样，说出来的话才不一样。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const DAY = 86_400_000

function open(prefix: string): { store: MemoryStore; cleanup: () => void } {
  const t = makeTmp(prefix)
  const store = MemoryStore.open(t.db())
  return { store, cleanup: () => t.cleanup(store) }
}

function addFact(
  store: MemoryStore,
  opts: { object: string; importance?: number; predicate?: string },
): string {
  return store.assertFact({
    actor: 'system',
    subject: '博士',
    predicate: opts.predicate ?? '说过',
    object: opts.object,
    provenance: 'stated',
    confirmationBasis: 'owner-stated',
    origin: 'live',
    ...(opts.importance === undefined ? {} : { importance: opts.importance }),
  })
}

test('L1 重要性高于阈值、且从未被提起 → 命中', () => {
  const { store, cleanup } = open('prts-lonely-l1-')
  try {
    const id = addFact(store, { object: '想去看一次极光', importance: 0.9 })
    const got = store.lonelyFacts({ nowMs: Date.now() })
    assert.equal(got.length, 1)
    assert.equal(got[0]?.factId, id)
    assert.equal(got[0]?.text, '想去看一次极光')
    assert.equal(got[0]?.lastAccessMs, null)
  } finally {
    cleanup()
  }
})

test('L2 重要性只有基线（0.5）→ 不命中：普通旧事不该被念叨', () => {
  const { store, cleanup } = open('prts-lonely-l2-')
  try {
    addFact(store, { object: '今天吃了面' }) // 落 0.5 兜底
    assert.deepEqual(store.lonelyFacts({ nowMs: Date.now() }), [])
  } finally {
    cleanup()
  }
})

test('L3 刚被检索强化过 → 不命中（14 天内提过就闭嘴）', () => {
  const { store, cleanup } = open('prts-lonely-l3-')
  try {
    const id = addFact(store, { object: '答应过要整理参考库', importance: 0.9 })
    const now = Date.now()
    store.reinforceFacts({ factIds: [id], nowMs: now })
    assert.equal(store.lonelyFacts({ nowMs: now }).length, 0, '刚提过的不该再提')

    // 过了 15 天再查，它重新浮出来——冷却不是遗忘。
    assert.equal(store.lonelyFacts({ nowMs: now + 15 * DAY }).length, 1)
  } finally {
    cleanup()
  }
})

test('L4 排序：重要性高的优先，同等重要性时更久没碰的优先', () => {
  const { store, cleanup } = open('prts-lonely-l4-')
  try {
    const now = Date.now()
    const low = addFact(store, { object: '低', predicate: 'p1', importance: 0.7 })
    const hiA = addFact(store, { object: '高A', predicate: 'p2', importance: 0.9 })
    const hiB = addFact(store, { object: '高B', predicate: 'p3', importance: 0.9 })
    // hiA 在 30 天前被碰过，hiB 从未被碰过 → hiB 更「久」
    store.reinforceFacts({ factIds: [hiA], nowMs: now - 30 * DAY })

    const got = store.lonelyFacts({ nowMs: now })
    assert.deepEqual(got.map((g) => g.text), ['高B', '高A', '低'])
  } finally {
    cleanup()
  }
})

test('L5 阈值与条数可调：minImportance 抬高后 0.7 也进不来', () => {
  const { store, cleanup } = open('prts-lonely-l5-')
  try {
    addFact(store, { object: '中等重要', importance: 0.7 })
    const now = Date.now()
    assert.equal(store.lonelyFacts({ nowMs: now, minImportance: 0.75 }).length, 0)
    assert.equal(store.lonelyFacts({ nowMs: now, minImportance: 0.65 }).length, 1)
    assert.equal(store.lonelyFacts({ nowMs: now, limit: 1 }).length, 1)
  } finally {
    cleanup()
  }
})

test('L6 边界：importance 恰好等于阈值也算命中（>= 不是 >）', () => {
  const { store, cleanup } = open('prts-lonely-l6-')
  try {
    addFact(store, { object: '刚好够格', importance: 0.6 })
    assert.equal(store.lonelyFacts({ nowMs: Date.now() }).length, 1)
    assert.equal(store.lonelyFacts({ nowMs: Date.now(), minImportance: 0.61 }).length, 0)
  } finally {
    cleanup()
  }
})
