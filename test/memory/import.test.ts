import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

function loadFixture(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'locomo-mini.json'), 'utf8'))
}

test('M5d importLoCoMo 把 session/turn 导入为 benchmark 条目，dia_id 保留', () => {
  const t = makeTmp('prts-memory-import-')
  const m = MemoryStore.open(t.db())
  try {
    const stats = m.importLoCoMo(loadFixture())
    assert.equal(stats.sessions, 2)
    assert.equal(stats.turns, 3)
    assert.equal(stats.unparsedTime, 0)

    const hits = m.search({ text: 'optics workshop', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1)
    const h = hits[0]!
    assert.equal(h.kind, 'turn')
    assert.equal(h.sessionId, 'conv-mini-1/session_1')
    assert.equal(h.turnIndex, 1)
    assert.equal(h.externalId, 'D1:2')
    assert.equal(h.origin, 'benchmark')
  } finally {
    t.cleanup(m)
  }
})

test('M5e 重复导入幂等：不会写出重复 turn', () => {
  const t = makeTmp('prts-memory-import-idem-')
  const m = MemoryStore.open(t.db())
  try {
    m.importLoCoMo(loadFixture())
    m.importLoCoMo(loadFixture())

    const hits = m.search({ text: 'optics workshop', includeOrigin: ['benchmark'] })
    assert.equal(hits.length, 1, '同一 sample/session/turnIndex 只应有一条')

    const v = m.verifyChain()
    assert.equal(v.ok, true)
  } finally {
    t.cleanup(m)
  }
})

test('M5f 导入的 turn 默认不进 live 检索路径', () => {
  const t = makeTmp('prts-memory-import-origin-')
  const m = MemoryStore.open(t.db())
  try {
    m.importLoCoMo(loadFixture())
    assert.equal(m.search({ text: 'optics workshop' }).length, 0)
  } finally {
    t.cleanup(m)
  }
})
