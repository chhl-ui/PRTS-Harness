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

test('M8c tokenize：英文按词去停用词、中文按连续段', () => {
  // what / do / i 是停用词——不滤掉它们会让 LIKE OR 被噪音淹没
  assert.deepEqual(tokenize('What lens do I prefer?'), ['lens', 'prefer'])
  assert.deepEqual(tokenize('光学镜头设计'), ['光学镜头设计'])
  assert.deepEqual(tokenize('a b c'), [], '单字符词全部丢掉')
  assert.deepEqual(tokenize(''), [])
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
