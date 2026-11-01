/**
 * 检索质量回归：候选截断不得丢掉高命中行。
 *
 * 起因（2026-11-01 探针，`.scratch/probe-recall-decompose.mjs`）：
 * `search()` 的 SQL 用 `LIMIT limit*4` 截候选但**没有 ORDER BY**，SQLite 于是
 * 按扫描顺序返回任意 `limit*4` 行。LongMemEval 全库口径下平均每题有 4113 行
 * 满足 `LIKE` 条件，截断只留 80 行 → 证据 turn 落进候选的概率约 2%；
 * 实测 R@8 = 2.1%，去掉截断后升到 43.4%。这 41 个百分点是截断造成的，与
 * 「LIKE 没有语义」无关。
 *
 * 这两个用例钉住修好之后的契约：**命中词数高的行必须在候选里，且排在前面**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M-R1 候选超过 limit*4 时，turn 的多词命中行不能被截断丢掉', () => {
  const t = makeTmp('prts-memory-recall-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    // 200 条只命中 'alpha' 的填充行，插在前面。
    for (let i = 0; i < 200; i++) {
      m.recordTurn({
        actor: 'system', sessionId: 'filler', turnIndex: i,
        speaker: 'user', text: `filler alpha text number ${i}`,
      })
    }
    // 唯一同时命中两个词的行，插在扫描顺序的最后——截断最先丢掉它。
    const targetId = m.recordTurn({
      actor: 'system', sessionId: 'target', turnIndex: 0,
      speaker: 'user', text: 'alpha zebra is the rare conjunction',
    })

    const hits = m.search({ text: 'alpha zebra', limit: 8 })
    assert.ok(hits.length > 0, '应至少召回一条')
    assert.equal(hits[0]?.id, targetId, '两词命中的 turn 必须排第一')
  } finally {
    t.cleanup(m)
  }
})

test('M-R2 候选超过 limit*4 时，fact 的多词命中行不能被截断丢掉', () => {
  const t = makeTmp('prts-memory-recall-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    for (let i = 0; i < 200; i++) {
      m.assertFact({
        actor: 'owner', subject: '博士', predicate: '标签',
        object: `filler alpha note ${i}`,
        provenance: 'stated', confirmationBasis: 'owner-stated',
      })
    }
    const targetId = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '标签',
      object: 'alpha zebra is the rare conjunction',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const hits = m.search({ text: 'alpha zebra', limit: 8 })
    assert.ok(hits.length > 0, '应至少召回一条')
    assert.equal(hits[0]?.id, targetId, '两词命中的 fact 必须排第一')
  } finally {
    t.cleanup(m)
  }
})
