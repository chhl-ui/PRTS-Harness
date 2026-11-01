/**
 * 旧库迁移。
 *
 * 由来（2026-11-01）：加 `identity_key` 列时，我把它的索引写进了 `SCHEMA` 字符串。
 * 新库没问题（建表时就带列），但**旧库会炸**——`db.exec(SCHEMA)` 先于 ALTER 执行，
 * 建索引时列还不存在，直接抛 `no such column: identity_key`，迁移函数根本没机会跑。
 *
 * 这个 bug 逃过了全套测试，因为所有用例都用新库；它是在 246,750 turn 的真实旧库
 * （memory-s.sqlite）上跑基准时才暴露的。所以这里补一条**真的把列删掉再打开**的用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('G4 旧库（缺 identity_key 列）打开时自动迁移，且能正常读写', () => {
  const t = makeTmp('prts-mem-migrate-')
  const path = t.db('memory.sqlite')

  // 1) 先用当前版本建库并写入，确认基线可用
  let m = MemoryStore.open(path)
  m.assertFact({
    actor: 'owner', subject: '博士', predicate: '偏好镜头', object: '50mm 定焦',
    provenance: 'stated', confirmationBasis: 'owner-stated',
  })
  m.close()

  // 2) 把库**退回旧形态**：删索引、删列（模拟 v2.9 之前的库）
  const raw = new DatabaseSync(path)
  raw.exec('DROP INDEX IF EXISTS idx_facts_identity')
  raw.exec('ALTER TABLE mem_facts DROP COLUMN identity_key')
  const cols = (raw.prepare('PRAGMA table_info(mem_facts)').all() as Array<{ name: string }>).map((c) => c.name)
  raw.close()
  assert.ok(!cols.includes('identity_key'), '前置：列必须真的被删掉，否则这条用例测不到迁移')

  // 3) 重新打开必须自愈——不能抛 no such column
  m = MemoryStore.open(path)
  try {
    const hits = m.search({ text: '定焦' })
    assert.equal(hits.length, 1, '旧库迁移后必须还能检索到原有事实')

    // 4) 迁移后的库要能继续写入，且身份键生效（同一事实重复写只留一条）
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头', object: '85mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好镜头', object: '85mm 定焦',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.equal(m.search({ text: '定焦' }).length, 2, '老事实 1 条 + 新事实 1 条，重复写入不产生第三条')
  } finally {
    t.cleanup(m)
  }
})
