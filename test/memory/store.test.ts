import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M1 写入事实后重开库仍能检索到，provenance 与 origin 保持', () => {
  const t = makeTmp('prts-memory-')
  let m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.assertFact({
      actor: 'owner',
      subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'model',
      subject: '博士', predicate: '在研', object: '统计分析方法',
      provenance: 'inferred', confirmationBasis: 'model-inferred',
    })
  } finally {
    m.close()
  }

  m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const a = m.search({ text: '光学' })
    assert.equal(a.length, 1)
    assert.equal(a[0]?.kind, 'fact')
    assert.equal(a[0]?.provenance, 'stated')
    assert.equal(a[0]?.origin, 'live')

    const b = m.search({ text: '统计' })
    assert.equal(b.length, 1)
    assert.equal(b[0]?.provenance, 'inferred')
  } finally {
    t.cleanup(m)
  }
})
