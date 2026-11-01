import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('M2 删除一条事实后检索不到，其余不受影响', () => {
  const t = makeTmp('prts-memory-del-')
  const m = MemoryStore.open(t.db())
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学仪器校准',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.equal(m.search({ text: '光学' }).length, 2)

    const target = m.search({ text: '光学镜头设计' })[0]
    assert.ok(target)
    m.deleteFact({ actor: 'owner', factId: target.id })

    const after = m.search({ text: '光学' })
    assert.equal(after.length, 1, '删掉一条，另一条保留')
    assert.notEqual(after[0]?.id, target.id)
  } finally {
    t.cleanup(m)
  }
})

test('M2b 正文在 mem_bodies 里被置 NULL —— 不走检索路径的直接查表', () => {
  const t = makeTmp('prts-memory-delbody-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const before = new DatabaseSync(dbPath)
    let bodyRef: string
    try {
      const row = before.prepare('SELECT body_ref FROM mem_facts WHERE fact_id = ?').get(id) as { body_ref: string }
      bodyRef = row.body_ref
      const b = before.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?').get(bodyRef) as { body: string | null }
      assert.equal(b.body, '光学镜头设计')
    } finally {
      before.close()
    }

    const deletionId = m.deleteFact({ actor: 'owner', factId: id })

    const after = new DatabaseSync(dbPath)
    try {
      const b = after.prepare('SELECT body FROM mem_bodies WHERE body_ref = ?').get(bodyRef) as { body: string | null }
      assert.equal(b.body, null, '正文必须被清空——这是删除生效的实体证据')

      const d = after.prepare(
        'SELECT state, completed, completed_scope, completed_at FROM mem_deletions WHERE deletion_id = ?',
      ).get(deletionId) as {
        state: string; completed: number; completed_scope: string | null; completed_at: number | null
      }
      assert.equal(d.state, 'completed')
      assert.equal(d.completed, 1)
      assert.equal(d.completed_scope, 'local-only')
      assert.ok(d.completed_at !== null)
    } finally {
      after.close()
    }
  } finally {
    t.cleanup(m)
  }
})

test('删除后链仍完整（删除是追加事件，不是改历史）', () => {
  const t = makeTmp('prts-memory-delchain-')
  const m = MemoryStore.open(t.db())
  try {
    const id = m.assertFact({
      actor: 'owner', subject: 'A', predicate: 'p', object: 'o',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.deleteFact({ actor: 'owner', factId: id })
    const v = m.verifyChain()
    assert.equal(v.ok, true)
    if (v.ok) assert.equal(v.events, 3, 'fact.asserted + memory.deleted + deletion.derivative-done')
  } finally {
    t.cleanup(m)
  }
})

test('M13 删除后 rebuildProjections 仍是已删，正文不复活', () => {
  const t = makeTmp('prts-memory-rebuild-')
  const m = MemoryStore.open(t.db())
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.deleteFact({ actor: 'owner', factId: id })
    assert.equal(m.search({ text: '光学' }).length, 0)

    m.rebuildProjections()

    assert.equal(m.search({ text: '光学' }).length, 0, 'rebuild 不得复活已删条目')
    const v = m.verifyChain()
    assert.equal(v.ok, true)
  } finally {
    t.cleanup(m)
  }
})

test('M14 事件 payload 里没有正文，只有 ref 与 sha256', () => {
  const t = makeTmp('prts-memory-nobody-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const raw = new DatabaseSync(dbPath)
    try {
      const rows = raw.prepare('SELECT kind, payload_json FROM memory_events')
        .all() as unknown as Array<{ kind: string; payload_json: string }>
      assert.ok(rows.length > 0)
      for (const r of rows) {
        assert.ok(
          !r.payload_json.includes('光学镜头设计'),
          `事件 ${r.kind} 的 payload 泄漏了正文——违反设计稿 §八 不变量 9`,
        )
      }
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})
