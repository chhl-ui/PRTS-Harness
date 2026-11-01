import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'longmemeval-mini.json'), 'utf8'),
  )
}

test('M5g importLongMemEval：has_answer 记为 is_evidence，日期按会话对应', () => {
  const t = makeTmp('prts-memory-lme-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const stats = m.importLongMemEval(loadFixture())
    assert.equal(stats.sessions, 2)
    assert.equal(stats.turns, 3)
    assert.equal(stats.evidence, 1, '只有标了 has_answer 的 turn 算证据')
    assert.equal(stats.unparsedTime, 0)

    const hits = m.search({ text: '50mm prime', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.sessionId, 'q-mini-1/s1')
    assert.equal(hits[0]!.turnIndex, 0)

    const raw = new DatabaseSync(dbPath)
    try {
      const rows = raw.prepare(
        'SELECT session_id, turn_index, is_evidence, occurred_at_ms FROM mem_turns ORDER BY session_id, turn_index',
      ).all() as unknown as Array<{
        session_id: string; turn_index: number; is_evidence: number; occurred_at_ms: number | null
      }>
      assert.equal(rows.length, 3)
      assert.equal(rows[0]!.session_id, 'q-mini-1/s1')
      assert.equal(rows[0]!.is_evidence, 1)
      assert.equal(rows[0]!.occurred_at_ms, Date.UTC(2023, 4, 8))
      assert.equal(rows[1]!.is_evidence, 0)
      // s2 的日期是 LoCoMo 风格自由文本，解析器也要认
      assert.equal(rows[2]!.occurred_at_ms, Date.UTC(2023, 4, 9, 13, 56))
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})

test('M5h 重复导入幂等，且默认不进 live 检索', () => {
  const t = makeTmp('prts-memory-lme-idem-')
  const m = MemoryStore.open(t.db())
  try {
    m.importLongMemEval(loadFixture())
    m.importLongMemEval(loadFixture())

    assert.equal(m.search({ text: '50mm prime', includeOrigin: ['benchmark'] }).length, 1)
    assert.equal(m.search({ text: '50mm prime' }).length, 0, 'benchmark 默认不可见')
    assert.equal(m.verifyChain().ok, true)
  } finally {
    t.cleanup(m)
  }
})
