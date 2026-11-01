/**
 * 检索结果的「时间」契约。
 *
 * 起因（2026-11-01）：`MemoryHit` 此前不携带事件时间，`mem_turns.occurred_at_ms`
 * 只被用来算 score，没进结果。评测端 `buildPrompt` 于是只给模型正文，
 * temporal-reasoning（133/500 题）因「看不到日期」4/4 拒答。
 * 这里钉住：时间必须跟着命中一起出去，原始串与原串解析结果都在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M-R3 turn 命中携带 occurredAtMs 与 occurredRaw', () => {
  const t = makeTmp('prts-memory-hit-time-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'system',
      sessionId: 's1',
      turnIndex: 0,
      speaker: 'user',
      text: 'I mostly shoot with my 50mm prime lens.',
      occurredRaw: '2023/04/10 (Mon) 17:50',
      origin: 'benchmark',
    })

    const hits = m.search({ text: 'prime lens', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.occurredRaw, '2023/04/10 (Mon) 17:50', '原始时间串必须原样带出')
    assert.equal(typeof hits[0]?.occurredAtMs, 'number', '解析后的毫秒也必须带出')
  } finally {
    t.cleanup(m)
  }
})

test('M-R4 无时间串的 turn 命中不伪造时间', () => {
  const t = makeTmp('prts-memory-hit-notime-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0,
      speaker: 'user', text: 'the prime lens arrived today',
      origin: 'benchmark',
    })

    const hits = m.search({ text: 'prime lens', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.occurredAtMs, null)
    assert.equal(hits[0]?.occurredRaw, undefined, '没有原始串就不要产出该字段')
  } finally {
    t.cleanup(m)
  }
})
