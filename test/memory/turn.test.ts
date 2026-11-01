import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M5 写入 turn 后可按 session + turnIndex + externalId 定位', () => {
  const t = makeTmp('prts-memory-turn-')
  const m = MemoryStore.open(t.db())
  try {
    m.recordTurn({
      actor: 'system',
      sessionId: 'session_1',
      turnIndex: 0,
      externalId: 'D1:1',
      speaker: 'Caroline',
      text: 'Hey Mel! Good to see you!',
      occurredRaw: '1:56 pm on 8 May, 2023',
      origin: 'benchmark',
    })

    const hits = m.search({ text: 'Good to see you', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1)
    const h = hits[0]!
    assert.equal(h.kind, 'turn')
    assert.equal(h.sessionId, 'session_1')
    assert.equal(h.turnIndex, 0)
    assert.equal(h.externalId, 'D1:1')
    assert.equal(h.origin, 'benchmark')
    assert.equal(h.recallPath, 'like')
  } finally {
    t.cleanup(m)
  }
})

test('M5b turn 的 origin 隔离：benchmark 默认不进检索', () => {
  const t = makeTmp('prts-memory-turn-origin-')
  const m = MemoryStore.open(t.db())
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'A',
      text: '光学镜头设计的讨论', origin: 'benchmark',
    })
    m.recordTurn({
      actor: 'owner', sessionId: 'live-1', turnIndex: 0, speaker: '博士',
      text: '光学镜头设计的讨论', origin: 'live',
    })

    assert.equal(m.search({ text: '光学镜头' }).length, 1, '默认只见 live')
    assert.equal(m.search({ text: '光学镜头', includeOrigin: ['live', 'benchmark'] }).length, 2)
  } finally {
    t.cleanup(m)
  }
})

test('M5c 无法解析的时间：occurred_raw 保留，occurred_at_ms 为 null', () => {
  const t = makeTmp('prts-memory-turn-time-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'A',
      text: 'x', occurredRaw: 'sometime last week', origin: 'live',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'A',
      text: 'y', occurredRaw: '1:56 pm on 8 May, 2023', origin: 'live',
    })

    const raw = new DatabaseSync(dbPath)
    try {
      const rows = raw.prepare(
        'SELECT turn_index, occurred_raw, occurred_at_ms FROM mem_turns ORDER BY turn_index',
      ).all() as unknown as Array<{
        turn_index: number; occurred_raw: string; occurred_at_ms: number | null
      }>
      assert.equal(rows.length, 2)
      assert.equal(rows[0]!.occurred_raw, 'sometime last week')
      assert.equal(rows[0]!.occurred_at_ms, null, '解析不了就不填，但不丢原始串')
      assert.equal(rows[1]!.occurred_raw, '1:56 pm on 8 May, 2023')
      assert.equal(rows[1]!.occurred_at_ms, Date.UTC(2023, 4, 8, 13, 56))
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})
