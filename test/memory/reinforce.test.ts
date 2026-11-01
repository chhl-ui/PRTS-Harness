/**
 * 用进废退：检索命中的强化回写。
 *
 * 钉住的不是「计数会增加」，而是四条更硬的性质：
 * 投影能从事件重建（R2）、不强化时行为与旧版完全一致（R3）、
 * 已删除的条目不参与（R4）、检索工具真的会触发强化（R5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, decayedImportance, IMPORTANCE_HALF_LIFE_DAYS,
} from '../../src/memory/index.ts'
import { createMemoryTools } from '../../src/runtime/memory-tools.ts'
import { makeTmp } from '../support/tmp.ts'

const DAY = 86_400_000

function open(prefix: string): { store: MemoryStore; dbPath: string; cleanup: () => void } {
  const t = makeTmp(prefix)
  const dbPath = t.db()
  const store = MemoryStore.open(dbPath)
  return { store, dbPath, cleanup: () => t.cleanup(store) }
}

function accessOf(dbPath: string, factId: string): { access_count: number; last_access_ms: number | null } {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare('SELECT access_count, last_access_ms FROM mem_facts WHERE fact_id = ?')
      .get(factId) as { access_count: number; last_access_ms: number | null }
  } finally {
    db.close()
  }
}

test('R1 强化两次 → access_count=2，事件两条', () => {
  const { store, dbPath, cleanup } = open('prts-mem-reinf-')
  try {
    const id = store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    // node:sqlite 返回的是 null 原型对象，逐个字段断言（deepEqual 会因原型不同而失败）
    const initial = accessOf(dbPath, id)
    assert.equal(initial.access_count, 0, '新事实从未被召回')
    assert.equal(initial.last_access_ms, null)

    const t1 = Date.now() - 1000
    assert.equal(store.reinforceFacts({ actor: 'system', factIds: [id], nowMs: t1 }), 1)
    assert.equal(store.reinforceFacts({ actor: 'system', factIds: [id], nowMs: t1 + 500 }), 1)
    const row = accessOf(dbPath, id)
    assert.equal(row.access_count, 2)
    assert.equal(row.last_access_ms, t1 + 500)

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const ev = db.prepare("SELECT count(*) c FROM memory_events WHERE kind = 'fact.reinforced'")
        .get() as { c: number }
      assert.equal(ev.c, 2)
    } finally {
      db.close()
    }
    assert.equal(store.verifyChain().ok, true)
  } finally {
    cleanup()
  }
})

test('R2 重建一致：access_count 由事件重放得出', () => {
  const { store, dbPath, cleanup } = open('prts-mem-reinf-rebuild-')
  try {
    const id = store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    store.reinforceFacts({ actor: 'system', factIds: [id] })
    store.reinforceFacts({ actor: 'system', factIds: [id] })
    store.rebuildProjections()
    assert.equal(accessOf(dbPath, id).access_count, 2, '重放后必须还原成 2，而不是 0 或 4')
  } finally {
    cleanup()
  }
})

test('R3 decayedImportance：accessCount=0 与旧行为完全一致，强化延长半衰期', () => {
  const t0 = 1_700_000_000_000
  const later = t0 + 2 * 180 * DAY
  const baseline = decayedImportance(0.5, t0, later)
  assert.ok(Math.abs(baseline - 0.125) < 1e-12, '两个半衰期后应剩 1/4')
  // 第五参数缺省 = 0 = 旧行为
  assert.equal(decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS, 0), baseline)

  const reinforced = decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS, 10)
  assert.ok(reinforced > baseline, '被召回 10 次的事实衰减应更慢')
  // 半衰期 × (1 + 10×0.5) = 6 倍 → 360 天后剩 0.125 的量级明显更高
  const sixTimes = decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS * 6, 0)
  assert.ok(Math.abs(reinforced - sixTimes) < 1e-12, '强化等价于把半衰期延长 6 倍')
  // 负数/超大次数被夹住，不产生放大或负半衰期
  assert.equal(decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS, -5), baseline)
  assert.ok(
    Math.abs(decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS, 99)
      - decayedImportance(0.5, t0, later, IMPORTANCE_HALF_LIFE_DAYS, 10)) < 1e-12,
    '超过 10 次按 10 次计',
  )
})

test('R4 已删除的事实不参与强化', () => {
  const { store, dbPath, cleanup } = open('prts-mem-reinf-deleted-')
  try {
    const id = store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    store.deleteFact({ actor: 'owner', factId: id })
    assert.equal(store.reinforceFacts({ actor: 'system', factIds: [id] }), 0)
    assert.equal(accessOf(dbPath, id).access_count, 0)
    assert.equal(store.reinforceFacts({ actor: 'system', factIds: ['fact-nope'] }), 0)
    assert.equal(store.reinforceFacts({ actor: 'system', factIds: [] }), 0)
  } finally {
    cleanup()
  }
})

test('R5 检索工具命中 fact 后触发强化', async () => {
  const { store, dbPath, cleanup } = open('prts-mem-reinf-tool-')
  try {
    const id = store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const defs = new Map<string, { execute: (args: unknown) => Promise<unknown> }>()
    const registry = {
      register(d: unknown): () => void {
        const def = d as { name: string; execute: (args: unknown) => Promise<unknown> }
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    }
    const tools = createMemoryTools(registry, { store })
    try {
      const out = await defs.get('prts_memory_recall')?.execute({ query: '光学' }) as { hits: unknown[] }
      assert.equal(out.hits.length, 1)
      assert.equal(accessOf(dbPath, id).access_count, 1, '命中 fact 后应回写一次强化')
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})
