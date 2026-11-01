import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, escapeLike } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M4b origin=benchmark 的条目默认不进检索结果', () => {
  const t = makeTmp('prts-memory-origin-')
  const m = MemoryStore.open(t.db())
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'system', subject: '基准', predicate: '含', object: '光学仪器校准',
      provenance: 'stated', confirmationBasis: 'owner-stated', origin: 'benchmark',
    })

    assert.equal(m.search({ text: '光学' }).length, 1, '默认只应看到 live')
    const all = m.search({ text: '光学', includeOrigin: ['live', 'benchmark'] })
    assert.equal(all.length, 2)
    assert.deepEqual(all.map((h) => h.origin).sort(), ['benchmark', 'live'])
  } finally {
    t.cleanup(m)
  }
})

test('LIKE 转义：查询含 % 不会命中全表', () => {
  const t = makeTmp('prts-memory-escape-')
  const m = MemoryStore.open(t.db())
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    assert.equal(m.search({ text: '%' }).length, 0, '% 未转义会命中全表')
    assert.equal(m.search({ text: '_' }).length, 0, '_ 未转义会匹配任意单字符')
    assert.equal(m.search({ text: '\\' }).length, 0)
    assert.equal(escapeLike('50%'), '50\\%')
  } finally {
    t.cleanup(m)
  }
})

test('M10 链完整性：篡改 memory_events 的 payload 后 verifyChain 报断点', () => {
  const t = makeTmp('prts-memory-chain-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    m.assertFact({
      actor: 'owner', subject: 'A', predicate: 'p', object: 'o1',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: 'B', predicate: 'p', object: 'o2',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const before = m.verifyChain()
    assert.equal(before.ok, true)

    const raw = new DatabaseSync(dbPath)
    try {
      raw.exec("UPDATE memory_events SET payload_json = '{\"evil\":1}' WHERE seq = 2")
    } finally {
      raw.close()
    }

    const after = m.verifyChain()
    assert.equal(after.ok, false)
    if (!after.ok) assert.equal(after.brokenAtSeq, 2)
  } finally {
    t.cleanup(m)
  }
})

test('CHECK 约束：stated + model-inferred 的组合被库拒绝', () => {
  const t = makeTmp('prts-memory-check-')
  const m = MemoryStore.open(t.db())
  try {
    assert.throws(() => {
      m.assertFact({
        actor: 'model', subject: 'X', predicate: 'p', object: 'o',
        // 不能声称「博士明说」却由模型推断确认（设计稿 §八 第 14 条）
        provenance: 'stated', confirmationBasis: 'model-inferred',
      })
    })
    // 抛错后不应留下半条投影
    assert.equal(m.search({ text: 'o' }).length, 0)
  } finally {
    t.cleanup(m)
  }
})

test('删除态：deleted_at_ms 非空的行不进检索', () => {
  const t = makeTmp('prts-memory-deleted-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.equal(m.search({ text: '光学' }).length, 1)

    // 第一版尚未实现删除事件，直接改投影验证检索侧的过滤条件生效
    const raw = new DatabaseSync(dbPath)
    try {
      raw.prepare('UPDATE mem_facts SET deleted_at_ms = ? WHERE fact_id = ?').run(Date.now(), id)
    } finally {
      raw.close()
    }
    assert.equal(m.search({ text: '光学' }).length, 0)
  } finally {
    t.cleanup(m)
  }
})
