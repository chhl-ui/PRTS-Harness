/**
 * §G2 ② 第一处：情绪效价 → 事实初始重要性。
 *
 * 在此之前 `mem_facts.importance` 没有任何赋值者，生产库 9 条事实全落 0.5
 * （`assertFact` 的 `input.importance ?? 0.5` 兜底）。全库同等重要 = 系统眼里
 * 没有「什么值得想起」，于是任何「主动」都只能读到期清单——那是闹钟，不是人。
 *
 * 判据直接抄 `docs/TODO.md` §G2 ②：
 * 「同一段记忆在负效价下写入时重要性低于平静时」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type TextGenerator } from '../../src/memory/index.ts'
import { importanceFromValence } from '../../src/memory/lifecycle.ts'
import { makeTmp } from '../support/tmp.ts'

// ---------------------------------------------------------------- 纯函数

test('P1 无情绪知识 → 0.5（与旧兜底一致，不假装有情绪）', () => {
  assert.equal(importanceFromValence(undefined), 0.5)
  assert.equal(importanceFromValence(Number.NaN), 0.5)
  assert.equal(importanceFromValence(0), 0.5)
})

test('P2 正效价更重、负效价更轻，且不对称封顶', () => {
  // 浮点：0.5 + 0.35 * (-1) 实际是 0.15000000000000002，按近似比较，
  // 不为好断言去 round 实现（round 会把真实的浮点行为藏起来）。
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9
  assert.ok(near(importanceFromValence(1), 0.85), `实际 ${importanceFromValence(1)}`)
  assert.ok(near(importanceFromValence(-1), 0.15), `实际 ${importanceFromValence(-1)}`)
  assert.ok(importanceFromValence(0.5) > 0.5)
  assert.ok(importanceFromValence(-0.5) < 0.5)
})

test('P3 越界值夹到 -1..1，不会算出 >0.95 或 <0.1', () => {
  assert.equal(importanceFromValence(9), importanceFromValence(1))
  assert.equal(importanceFromValence(-9), importanceFromValence(-1))
  assert.ok(importanceFromValence(9) <= 0.95)
  assert.ok(importanceFromValence(-9) >= 0.1)
})

// ---------------------------------------------------------------- 端到端

function fakeGen(replies: string[]): TextGenerator {
  let i = 0
  return {
    model: 'fake-1',
    async generate(): Promise<string> {
      const reply = replies[Math.min(i, replies.length - 1)]
      i++
      return reply ?? '[]'
    },
  }
}

function open(prefix: string): { store: MemoryStore; dbPath: string; cleanup: () => void } {
  const t = makeTmp(prefix)
  const dbPath = t.db()
  const store = MemoryStore.open(dbPath)
  return { store, dbPath, cleanup: () => t.cleanup(store) }
}

function seedTurns(store: MemoryStore, texts: string[]): void {
  texts.forEach((text, i) => {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: i, speaker: 'user', text })
  })
}

const FACT_REPLY = JSON.stringify([
  { subject: '博士', predicate: '偏好', object: '光学镜头设计', source_index: 0 },
])

async function consolidatedImportance(opts: {
  prefix: string
  valence?: number | (() => number | undefined)
}): Promise<number> {
  const { store, dbPath, cleanup } = open(opts.prefix)
  try {
    seedTurns(store, ['我偏好光学镜头设计'])
    const valence = typeof opts.valence === 'function'
      ? opts.valence
      : (opts.valence === undefined ? undefined : () => opts.valence as number)
    await store.consolidateFacts({
      generator: fakeGen([FACT_REPLY]),
      limit: 10,
      batchSize: 5,
      ...(valence === undefined ? {} : { emotionValence: valence }),
    })
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare(
        "SELECT importance FROM mem_facts WHERE predicate = '偏好'",
      ).get() as { importance: number } | undefined
      assert.ok(row !== undefined, '事实必须已写入')
      return row.importance
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
}

test('E1 负效价下写入的事实，重要性低于平静时（TODO §G2 ② 的判据）', async () => {
  const calm = await consolidatedImportance({ prefix: 'prts-imp-e1a-', valence: 0 })
  const low = await consolidatedImportance({ prefix: 'prts-imp-e1b-', valence: -1 })
  assert.equal(calm, 0.5, '平静时保持旧基准')
  // 不能只断「方向对」：权重被写成 0.001 时 0.4999 < 0.5 也绿，那是假绿。
  // 偏离至少 0.2（valence=±1 的实际偏离是 0.35，留余量）。
  assert.ok(low < calm, `负效价应当更轻，实际 calm=${calm} low=${low}`)
  assert.ok(calm - low >= 0.2, `负效价必须**明显**更轻，实际差额只有 ${calm - low}`)
})

test('E2 正效价下写入的事实，重要性高于平静时', async () => {
  const calm = await consolidatedImportance({ prefix: 'prts-imp-e2a-', valence: 0 })
  const high = await consolidatedImportance({ prefix: 'prts-imp-e2b-', valence: 1 })
  assert.ok(high > calm, `正效价应当更重，实际 calm=${calm} high=${high}`)
  assert.ok(high - calm >= 0.2, `正效价必须**明显**更重，实际差额只有 ${high - calm}`)
})

test('E3 不传 emotionValence → 落 0.5（旧行为不变，没有情绪层时不假装）', async () => {
  const none = await consolidatedImportance({ prefix: 'prts-imp-e3-' })
  assert.equal(none, 0.5)
})

test('E4 情绪读取抛错 → 巩固照常完成，事实落 0.5（情绪故障不拖垮记忆）', async () => {
  const none = await consolidatedImportance({
    prefix: 'prts-imp-e4-',
    valence: () => { throw new Error('emotion db unavailable') },
  })
  assert.equal(none, 0.5, '读不到情绪不是失败，是「没有情绪知识」')
})
