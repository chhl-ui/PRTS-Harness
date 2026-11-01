/**
 * 摘要写入与检索（Wave B）。
 *
 * 背景：`mem_summaries` 此前是**零写入**——表建了、`rebuildProjections` 里会清它，
 * 但全仓没有一处往里写，检索侧也没有 summary 路。这一组用例钉住新加的三件事：
 * 写入、独立名额、默认关闭。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('U1 写入的摘要可被检索到，且只有在开 summaryQuota 时才出现', () => {
  const t = makeTmp('prts-mem-summary-write-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.putSummary({
      subjectKind: 'session', subjectId: 's1',
      text: 'The user discussed switching from Nikon to a Sony A7R IV for low-light work.',
    })
    assert.equal(m.countSummaries(), 1)

    const off = m.search({ text: 'Sony A7R IV low-light', limit: 5 })
    assert.equal(off.filter((h) => h.kind === 'summary').length, 0, '默认关闭时摘要不该出现')

    const on = m.search({ text: 'Sony A7R IV low-light', limit: 5, summaryQuota: 2 })
    const s = on.filter((h) => h.kind === 'summary')
    assert.equal(s.length, 1, `摘要应被检索到，实际 ${s.length}`)
    assert.match(s[0].text, /A7R IV/)
  } finally {
    t.cleanup(m)
  }
})

test('U2 同一 summaryId 重写是覆盖，旧正文与旧索引都清掉', () => {
  const t = makeTmp('prts-mem-summary-idem-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const id = m.putSummary({ summaryId: 'sum-1', subjectKind: 'session', subjectId: 's1', text: 'The user owns a Nikon Z6.' })
    m.putSummary({ summaryId: 'sum-1', subjectKind: 'session', subjectId: 's1', text: 'The user owns a Fujifilm X-T5.' })
    assert.equal(m.countSummaries(), 1, '同一 id 不应产生第二条')

    const stale = m.search({ text: 'Nikon Z6', limit: 5, summaryQuota: 2 }).filter((h) => h.kind === 'summary')
    assert.equal(stale.length, 0, `旧正文不该还在索引里，实际 ${JSON.stringify(stale.map((h) => h.text))}`)
    const fresh = m.search({ text: 'Fujifilm X-T5', limit: 5, summaryQuota: 2 }).filter((h) => h.kind === 'summary')
    assert.equal(fresh.length, 1)
    assert.equal(fresh[0].id, `summary-${id}`)
  } finally {
    t.cleanup(m)
  }
})

test('U3 origin 隔离：benchmark 摘要不进 live 检索', () => {
  const t = makeTmp('prts-mem-summary-origin-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.putSummary({ subjectKind: 'session', subjectId: 's1', text: 'The user prefers Sony bodies for portraits.', origin: 'live' })
    m.putSummary({ subjectKind: 'session', subjectId: 's2', text: 'The user prefers Sony bodies for portraits, benchmark copy.', origin: 'benchmark' })
    assert.equal(m.countSummaries(), 2)
    assert.equal(m.countSummaries({ origin: 'benchmark' }), 1)

    const live = m.search({ text: 'Sony bodies portraits', limit: 5, summaryQuota: 5 })
    assert.equal(live.filter((h) => h.kind === 'summary').length, 1, '默认只该看到 live 摘要')

    const both = m.search({ text: 'Sony bodies portraits', limit: 5, summaryQuota: 5, includeOrigin: ['live', 'benchmark'] })
    assert.equal(both.filter((h) => h.kind === 'summary').length, 2)
  } finally {
    t.cleanup(m)
  }
})

test('U4 摘要占独立名额，不与 turn 互相挤光', () => {
  const t = makeTmp('prts-mem-summary-quota-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    for (let i = 0; i < 8; i++) {
      m.recordTurn({
        actor: 'system', sessionId: 's1', turnIndex: i, speaker: 'user',
        text: `camera gear turn ${i} about Sony bodies and lens choices`,
      })
    }
    m.putSummary({ subjectKind: 'session', subjectId: 's1', text: 'The user is comparing Sony camera bodies and lens choices.' })

    const hits = m.search({ text: 'Sony bodies lens choices', limit: 6, summaryQuota: 1 })
    assert.equal(hits.filter((h) => h.kind === 'summary').length, 1, '摘要应有 1 个名额')
    assert.ok(hits.filter((h) => h.kind === 'turn').length >= 1, 'turn 不能被摘要挤光')
  } finally {
    t.cleanup(m)
  }
})

test('U5 重建投影后摘要保留（与 profile 同类，是链外派生项）', () => {
  const t = makeTmp('prts-mem-summary-rebuild-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'hello' })
    m.putSummary({ subjectKind: 'session', subjectId: 's1', text: 'The user greeted the assistant.' })
    m.rebuildProjections()
    // 摘要由模型巩固写入、依赖链外正文，无法从事件链重放——与 mem_profiles 同类。
    // 若它被重建清空而游标不重置，会永久丢失且无报错（profile 踩过同一个坑）。
    assert.equal(m.countSummaries(), 1, '摘要不该被重放清空')
  } finally {
    t.cleanup(m)
  }
})
