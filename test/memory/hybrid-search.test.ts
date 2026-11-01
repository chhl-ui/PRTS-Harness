/**
 * 混合检索的契约（RED 先行）。
 *
 * 背景（2026-11-01 实测，.scratch/probe-s-retrieval.mjs 与 /tmp/fts-quality.mjs）：
 * s_cleaned（每题中位 491 turn、246,750 turn 总计）上，纯 `LIKE` 的 any@8 = 19.6%、
 * 3,125 ms/题（超 V1-16 的 1 秒预算三倍）。FTS5 `trigram` 是 any@8 = 45.1%、96 ms/题；
 * 但它对中文 2 字（"镜头"）恒为 0，`unicode61` / `porter` 连中文 3 字都是 0。
 *
 * 所以定的是混合：`trigram` 主索引（中英长串）+ `LIKE` 兜底（仅 2 字及以下的中文词）。
 * 这个文件钉住的正是"两路各自的行为"与"合并后的行为"，避免实现时把中文弄丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

function seed(m: MemoryStore): void {
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
    text: 'I preferred the 50mm prime lens for portraits',
  })
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user',
    text: '光学镜头设计的论文今天看完了',
  })
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 2, speaker: 'user',
    text: 'tomorrow I will refactor the ledger module',
  })
}

test('H1 英文子串检索：查询词是文档词的子串时命中（trigram 的行为）', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const hits = m.search({ text: 'prefer' })
    assert.equal(hits.length, 1)
    assert.match(hits[0]?.text ?? '', /preferred/)
    assert.equal(hits[0]?.recallPath, 'fts-trigram')
  } finally {
    t.cleanup(m)
  }
})

test('H2 中文 3 字检索：走 trigram（这是 unicode61/porter 做不到的）', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const hits = m.search({ text: '光学镜' })
    assert.equal(hits.length, 1)
    assert.match(hits[0]?.text ?? '', /光学镜头/)
    assert.equal(hits[0]?.recallPath, 'fts-trigram')
  } finally {
    t.cleanup(m)
  }
})

test('H3 中文 2 字检索：trigram 恒为 0，必须由 LIKE 兜底命中', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const hits = m.search({ text: '镜头' })
    assert.equal(hits.length, 1)
    assert.match(hits[0]?.text ?? '', /镜头/)
    assert.equal(hits[0]?.recallPath, 'like')
  } finally {
    t.cleanup(m)
  }
})

test('H4 中英混合查询：两路都跑，结果合并且不重复', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    // 'ledger' 走 trigram；'镜头' 是 2 字走 LIKE
    const hits = m.search({ text: 'ledger 镜头' })
    assert.equal(hits.length, 2)
    const ids = new Set(hits.map((h) => h.id))
    assert.equal(ids.size, hits.length, '同一 turn 不得因两路命中而出现两次')
    const paths = new Set(hits.map((h) => h.recallPath))
    assert.ok(paths.has('fts-trigram') && paths.has('like'), '两路各自都要有贡献')
  } finally {
    t.cleanup(m)
  }
})

test('H5 索引随投影同步：删除后不再被检索到', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const factId = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '在研', object: '光学镜头设计方法',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.equal(m.search({ text: '光学镜' }).length, 2, '前置：turn 与 fact 各一条')

    m.deleteFact({ actor: 'owner', factId })
    const after = m.search({ text: '光学镜' })
    assert.equal(after.length, 1)
    assert.equal(after[0]?.kind, 'turn', '剩下的必须是 turn，fact 已从索引里消失')
  } finally {
    t.cleanup(m)
  }
})

test('H6 重建投影后 FTS 索引仍可用（rebuild 不得让全文索引变空）', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    assert.ok(m.search({ text: 'prefer' }).length > 0, '前置：重建前能搜到')

    m.rebuildProjections()

    const hits = m.search({ text: 'prefer' })
    assert.equal(hits.length, 1, '重建后全文索引必须仍然有内容')
    assert.equal(hits[0]?.recallPath, 'fts-trigram')
  } finally {
    t.cleanup(m)
  }
})
