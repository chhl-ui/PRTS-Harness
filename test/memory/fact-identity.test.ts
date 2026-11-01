/**
 * `mem_facts` 的身份键与冲突语义（RED 先行）。
 *
 * 议事会（2026-11-01，五席）一致指出的结构缺陷：`fold.ts` 的 fact 插入是
 * `ON CONFLICT(fact_id) DO NOTHING`，而 `fact_id = fact-${randomUUID()}`——
 * 同一个 (subject, predicate) 再断言时只会**插入一条新行**，旧的不会被退役，
 * `revision` 列硬编码为 1、永远没有递增路径。
 *
 * 后果：一旦引入写时抽取（同一偏好会在多轮对话里被反复抽到），事实库会堆出
 * 大量互相矛盾的副本，而架构需求 §5.3 要求「冲突保留，不静默覆盖」——
 * 保留不等于堆积，正确形态是「旧行退役 + 新行升版，双方都可查」。
 *
 * 这个文件钉住的是 identity_key 的语义，先于抽取实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('F1 同一 (subject, predicate) 再断言：旧行退役、新行 revision 递增', () => {
  const t = makeTmp('prts-mem-identity-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    const first = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '50mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const second = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '85mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.notEqual(first, second, '两次断言必须是两条独立的事实行')

    // 直接查表：这是投影层的不变量，不走检索路径
    const raw = new DatabaseSync(path, { readOnly: true })
    const rows = raw.prepare(
      `SELECT fact_id, revision, retired_at_ms, deleted_at_ms FROM mem_facts ORDER BY revision`,
    ).all() as Array<{ fact_id: string; revision: number; retired_at_ms: number | null; deleted_at_ms: number | null }>
    raw.close()

    assert.equal(rows.length, 2, '两条都要留着——冲突保留，不静默覆盖')
    const oldRow = rows.find((r) => r.fact_id === first)
    const newRow = rows.find((r) => r.fact_id === second)
    assert.ok(oldRow && newRow, '两条 id 都必须能查到')
    assert.notEqual(oldRow.retired_at_ms, null, '旧的必须退役（默认不参与检索）')
    assert.equal(oldRow.revision, 1)
    assert.equal(newRow.revision, 2, '新的 revision 必须在旧的基础上递增')
    assert.equal(newRow.retired_at_ms, null, '新的不得退役')
  } finally {
    t.cleanup(m)
  }
})

test('F2 退役的事实默认不进检索，但库里的行仍在（可追溯）', () => {
  const t = makeTmp('prts-mem-identity-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '50mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '85mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const hits = m.search({ text: '定焦' })
    const texts = hits.map((h) => h.text)
    assert.equal(hits.length, 1, '只有未退役的那条进检索')
    assert.match(texts[0] ?? '', /85mm/, '检索返回的必须是新值')

    const raw = new DatabaseSync(path, { readOnly: true })
    const total = (raw.prepare('SELECT count(*) c FROM mem_facts').get() as { c: number }).c
    raw.close()
    assert.equal(total, 2, '旧事实仍然留在库里——不静默覆盖')
  } finally {
    t.cleanup(m)
  }
})

test('F3 不同 predicate 不互相退役', () => {
  const t = makeTmp('prts-mem-identity-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头',
      object: '50mm 定焦', provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '在研方向',
      object: '光学设计', provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const hits = m.search({ text: '定焦 光学设计' })
    assert.equal(hits.length, 2, '身份键只看 subject+predicate，不同 predicate 不该互相退役')
  } finally {
    t.cleanup(m)
  }
})
