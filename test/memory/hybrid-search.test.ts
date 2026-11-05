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
import { DatabaseSync } from 'node:sqlite'

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

test('H7 旧库升级自愈：FTS 为空但投影有数据时，打开即重建索引', () => {
  const t = makeTmp('prts-mem-hybrid-migrate-')
  const path = t.db('memory.sqlite')

  // 1) 正常写入，让投影与索引都有数据
  let m = MemoryStore.open(path)
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
    text: 'I preferred the 50mm prime lens',
  })
  m.close()

  // 2) 模拟 v2.6 之前的旧库：FTS 表存在但为空（历史行不会重走 fold）
  const raw = new DatabaseSync(path)
  raw.exec('DELETE FROM mem_fts_turns')
  raw.close()

  // 3) 重新打开必须自愈——否则检索会静默退化成全表 LIKE（实测 10,960 turn 的
  //    旧库打开后 recallPath 全是 'like'，无任何报错）
  m = MemoryStore.open(path)
  try {
    const hits = m.search({ text: 'preferred' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.recallPath, 'fts-trigram', '打开时应重建索引，而不是静默退回 LIKE')
  } finally {
    t.cleanup(m)
  }
})

test('H7 英文短词不得在 FTS 已命中时再跑 LIKE 兜底（V1-16 延迟回归）', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'I set up the ledger module',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's2', turnIndex: 0, speaker: 'user',
      text: 'the backup battery is dead',
    })
    // 'up' 是 2 字符英文词（不在停用词表里），trigram 索引不到；LIKE '%up%' 在
    // 24.6 万行的基准库上要 914ms、命中 87,837 行（实测）。FTS 既然已用 'ledger'
    // 命中目标，这条 LIKE 只会把无关记录（backup）带进结果并吃掉一题 60% 的时间。
    const hits = m.search({ text: 'ledger up' })
    assert.equal(hits.length, 1, "'up' 不得在 FTS 已命中时把无关记录带进来")
    assert.equal(hits[0]?.recallPath, 'fts-trigram')
  } finally {
    t.cleanup(m)
  }
})

test('H8 纯短词查询在 FTS 颗粒无收时仍走 LIKE 兜底（英文 2 字符缩写）', () => {
  const t = makeTmp('prts-mem-hybrid-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'the AI paper is on my desk',
    })
    // 'AI' 只有 2 字符，trigram 搜不到；FTS 无结果时必须回落到 LIKE，
    // 否则 2 字符缩写类查询会静默检索不到任何东西。
    const hits = m.search({ text: 'AI' })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.recallPath, 'like')
  } finally {
    t.cleanup(m)
  }
})
