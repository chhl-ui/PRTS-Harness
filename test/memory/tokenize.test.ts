import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, tokenize } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M8b 自然语言问题必须分词召回——整串 LIKE 会零命中', () => {
  const t = makeTmp('prts-memory-token-')
  const m = MemoryStore.open(t.db())
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'I mostly shoot with my 50mm prime lens.',
      origin: 'benchmark',
    })

    // 整串匹配：问题原句在 turn 里当然不存在
    // 分词后：「lens」能命中
    const hits = m.search({ text: 'What lens do I prefer?', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1, '分词后 lens 应命中；整串匹配会是 0')
  } finally {
    t.cleanup(m)
  }
})

test('M8c tokenize：英文按词去停用词、中文按连续段 + 长串拆 2-gram', () => {
  // what / do / i 是停用词——不滤掉它们会让 LIKE OR 被噪音淹没
  assert.deepEqual(tokenize('What lens do I prefer?'), ['lens', 'prefer'])
  // 中文：连续段整体保留（给 FTS trigram），≥4 字的长串额外拆 2-gram（给 LIKE 兜底）。
  // 只留整串的话，整句问句「我之前说过的光学偏好是什么」是一个 13 字 token，
  // FTS 与 LIKE 都命中不了——真机上等于中文检索全失效。
  assert.deepEqual(tokenize('光学镜头设计'), ['光学镜头设计', '光学', '学镜', '镜头', '头设', '设计'])
  assert.deepEqual(tokenize('a b c'), [], '单字符词全部丢掉')
  assert.deepEqual(tokenize(''), [])
})

test('M8f 虚词 2-gram 被过滤，实义 2-gram 保留', () => {
  const toks = tokenize('我的意思是什么')
  assert.ok(!toks.includes('我的'), '含「我」的二元组不该当检索词')
  assert.ok(!toks.includes('是什'), '含「是」的二元组不该当检索词')
  assert.ok(!toks.includes('什么'), '含「什/么」的二元组不该当检索词')
  assert.ok(toks.includes('意思'), '实义二元组要保留')
})

test('M8e 中文整句查询能命中相关事实（回归：整句是一个 token 时零命中）', () => {
  const t = makeTmp('prts-memory-cjk-')
  const m = MemoryStore.open(t.db())
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    // 整句没有任何分隔符——修复前 tokenize 只产出这一个长 token，检索为 0
    const hits = m.search({ text: '我之前说过的光学偏好是什么？' })
    assert.ok(hits.length >= 1, `中文整句应命中，实际 ${hits.length} 条`)
    assert.equal(hits[0]?.text, '光学镜头设计')
  } finally {
    t.cleanup(m)
  }
})

test('M8d 命中词多的排在前面（分词给了相关度的代理）', () => {
  const t = makeTmp('prts-memory-rank-')
  const m = MemoryStore.open(t.db())
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'The lens is fine.', origin: 'benchmark',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user',
      text: 'The lens calibration is done and the lens cap is here.', origin: 'benchmark',
    })

    const hits = m.search({ text: 'lens calibration cap', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 2)
    assert.equal(hits[0]!.turnIndex, 1, '命中 3 个词的应排在命中 1 个词的前面')
  } finally {
    t.cleanup(m)
  }
})
