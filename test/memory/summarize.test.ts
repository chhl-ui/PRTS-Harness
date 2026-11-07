import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { summarizeSession } from '../../src/memory/summarize.ts'
import { makeTmp } from '../support/tmp.ts'

/** 假生成器：不调模型，直接返回预设摘要。 */
const fakeGenerator = (text: string) => ({
  model: 'fake',
  generate: async () => text,
})

test('SM1 摘要：一个会话的 turn 压成一条可检索的摘要', async () => {
  const t = makeTmp('prts-memory-sum-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'owner', sessionId: 'sess-1', turnIndex: 0, speaker: 'owner',
      text: '给 task-c729fa72 补登记证据',
    })
    m.recordTurn({
      actor: 'model', sessionId: 'sess-1', turnIndex: 1, speaker: 'model',
      text: '两份证据已登记，任务进入 verifying，等你 /accept',
    })
    m.recordTurn({
      actor: 'model', sessionId: 'sess-1', turnIndex: 2, speaker: 'model',
      text: 'audit.md、table-for-docs.md 都在 C:\\prts-workspace\\reference-audit',
    })

    const result = await summarizeSession(
      { store: m, generator: fakeGenerator('任务 task-c729fa72 证据已登记，产物在 reference-audit/audit.md，状态 verifying，等 /accept。') },
      { sessionId: 'sess-1' },
    )

    assert.ok(result !== null, '有 turn 时应产出摘要')
    assert.equal(result.turnCount, 3)
    assert.equal(m.countSummaries(), 1, '摘要应落库')

    // 摘要必须能被检索到——否则和没写一样。
    // 注意：`search` 的 summaryQuota 默认是 0（store.ts:1190「不开摘要路时基线一字不变」），
    // 不显式传就永远搜不到摘要。这是摘要路的第二个开关，不是写入失败。
    const hits = m.search({ text: 'task-c729fa72', summaryQuota: 5 })
    assert.ok(
      hits.some((h) => h.kind === 'summary'),
      `检索应命中摘要，实际 kinds=${hits.map((h) => h.kind).join(',')}`,
    )
  } finally {
    t.cleanup(m)
  }
})

test('SM2 摘要：会话没有 turn 时返回 null，不写空摘要', async () => {
  const t = makeTmp('prts-memory-sum-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const result = await summarizeSession(
      { store: m, generator: fakeGenerator('不该被调用') },
      { sessionId: 'sess-empty' },
    )
    assert.equal(result, null)
    assert.equal(m.countSummaries(), 0, '空会话不应产生摘要')
  } finally {
    t.cleanup(m)
  }
})

test('SM3 摘要：生成器返回空串时不写库', async () => {
  const t = makeTmp('prts-memory-sum-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'owner', sessionId: 'sess-2', turnIndex: 0, speaker: 'owner', text: '你好',
    })
    const result = await summarizeSession(
      { store: m, generator: fakeGenerator('   ') },
      { sessionId: 'sess-2' },
    )
    assert.equal(result, null, '空摘要不写')
    assert.equal(m.countSummaries(), 0)
  } finally {
    t.cleanup(m)
  }
})

test('SM4 摘要：sourceTurnIds 记录来源，可追溯到具体轮次', async () => {
  const t = makeTmp('prts-memory-sum-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const id0 = m.recordTurn({
      actor: 'owner', sessionId: 'sess-3', turnIndex: 0, speaker: 'owner', text: '第一轮',
    })
    const id1 = m.recordTurn({
      actor: 'model', sessionId: 'sess-3', turnIndex: 1, speaker: 'model', text: '第二轮',
    })
    const result = await summarizeSession(
      { store: m, generator: fakeGenerator('两轮对话的摘要') },
      { sessionId: 'sess-3' },
    )
    assert.ok(result !== null)
    const sources = m.summarySourceTurns(result.summaryId)
    assert.deepEqual(sources.sort(), [id0, id1].sort(), '来源轮次应完整记录')
  } finally {
    t.cleanup(m)
  }
})
