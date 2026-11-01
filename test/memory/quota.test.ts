/**
 * fact 与 turn 的分组名额（议事会要求的前置）。
 *
 * 现状问题：`search()` 把 fact 与 turn 放进同一个 RRF 池按 `rrf × hit.score` 排序，
 * 而 fact 独享 `(0.5 + importance)` 乘子、turn 没有——同一批候选里 fact 系统性占优。
 * 这在 fact 库为空时看不出来（benchmark 库一直是空的），一旦写时抽取上线，
 * turn 会被 fact 挤干净，且**无法归因**：分不清分数变化来自抽取质量还是挤出效应。
 *
 * 这里钉住的是：名额是**上限不是固定值**——fact 不够时 turn 补足，
 * fact 为空时行为与现在完全一致（不能破坏现有 38.8% 的基线）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

function seedBoth(m: MemoryStore): void {
  for (let i = 0; i < 5; i++) {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: i,
      speaker: 'user', text: `turn 片段 ${i}：光学镜头的校准记录`,
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: `偏好项 ${i}`,
      object: `光学镜头参数 ${i}`,
      provenance: 'stated', confirmationBasis: 'owner-stated',
      importance: 0.9,
    })
  }
}

test('G1 fact 与 turn 各占名额，不由一方挤满', () => {
  const t = makeTmp('prts-mem-quota-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedBoth(m)
    const hits = m.search({ text: '光学镜头', limit: 4 })
    assert.equal(hits.length, 4)

    const factCount = hits.filter((h) => h.kind === 'fact').length
    const turnCount = hits.filter((h) => h.kind === 'turn').length
    assert.ok(factCount >= 1, `fact 必须有名额，实际 ${factCount}`)
    assert.ok(turnCount >= 1, `turn 必须有名额，实际 ${turnCount}（否则抽取上线后无法归因）`)
  } finally {
    t.cleanup(m)
  }
})

test('G2 fact 为空时，名额全部给 turn——现有基线不得改变', () => {
  const t = makeTmp('prts-mem-quota-empty-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    for (let i = 0; i < 5; i++) {
      m.recordTurn({
        actor: 'system', sessionId: 's1', turnIndex: i,
        speaker: 'user', text: `turn 片段 ${i}：光学镜头的校准记录`,
      })
    }
    const hits = m.search({ text: '光学镜头', limit: 4 })
    assert.equal(hits.length, 4, 'fact 库为空时不能浪费名额')
    assert.ok(hits.every((h) => h.kind === 'turn'), '全部名额都应给 turn')
  } finally {
    t.cleanup(m)
  }
})

test('G3 fact 不足配额时，缺口由 turn 补足', () => {
  const t = makeTmp('prts-mem-quota-fill-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    for (let i = 0; i < 5; i++) {
      m.recordTurn({
        actor: 'system', sessionId: 's1', turnIndex: i,
        speaker: 'user', text: `turn 片段 ${i}：光学镜头的校准记录`,
      })
    }
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头参数',
      provenance: 'stated', confirmationBasis: 'owner-stated', importance: 0.9,
    })

    const hits = m.search({ text: '光学镜头', limit: 4 })
    assert.equal(hits.length, 4, '只有 1 条 fact 时，剩余 3 个名额必须被 turn 填满')
    assert.equal(hits.filter((h) => h.kind === 'fact').length, 1)
    assert.equal(hits.filter((h) => h.kind === 'turn').length, 3)
  } finally {
    t.cleanup(m)
  }
})
