/**
 * 画像写入路径（Wave A）。
 *
 * 背景：`mem_profiles` 此前**只有检索没有写入**——建表、FTS、独立名额、向量路全都就绪，
 * 但 `src/` 下一次 INSERT 都没有，只有测试用裸 SQL 造数据。这一组用例钉住新加的三件事：
 * 写入、origin 隔离、旧库迁移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('W1 写入的画像能被 bm25 路检索到（FTS 与主表同事务同步）', () => {
  const t = makeTmp('prts-mem-profile-write-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.putProfile({
      subject: 'user', aspect: 'camera_gear',
      profileText: 'The user shoots with a Sony A7R IV and prefers Sony-compatible accessories.',
    })
    assert.equal(m.countProfiles(), 1)

    const hits = m.search({ text: 'Sony accessories', limit: 5, profileQuota: 3 })
    const prof = hits.filter((h) => h.kind === 'profile')
    assert.equal(prof.length, 1, `画像应被检索到，实际 ${prof.length}`)
    assert.match(prof[0].text, /Sony A7R IV/)
  } finally {
    t.cleanup(m)
  }
})

test('W2 同一 profileId 重写是覆盖而非堆积，且 FTS 跟着更新', () => {
  const t = makeTmp('prts-mem-profile-idem-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const id = m.putProfile({
      profileId: 'p-1', subject: 'user', aspect: 'diet',
      profileText: 'The user follows a keto diet.',
    })
    m.putProfile({
      profileId: 'p-1', subject: 'user', aspect: 'diet',
      profileText: 'The user follows a vegetarian diet.',
    })
    assert.equal(m.countProfiles(), 1, '同一 id 不应产生第二条')

    // 旧内容查不到、新内容查得到——否则是 FTS 没同步
    const stale = m.search({ text: 'keto', limit: 5, profileQuota: 3 }).filter((h) => h.kind === 'profile')
    assert.equal(stale.length, 0, `旧的 keto 内容不该还在索引里，实际 ${JSON.stringify(stale.map((h) => h.text))}`)
    const fresh = m.search({ text: 'vegetarian', limit: 5, profileQuota: 3 }).filter((h) => h.kind === 'profile')
    assert.equal(fresh.length, 1, '新内容应可检索')
    assert.equal(fresh[0].id, `profile-${id}`)
  } finally {
    t.cleanup(m)
  }
})

test('W3 origin 隔离：benchmark 画像不进 live 检索', () => {
  const t = makeTmp('prts-mem-profile-origin-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.putProfile({ subject: 'user', aspect: 'a', profileText: 'The user prefers Sony cameras.', origin: 'live' })
    m.putProfile({ subject: 'user', aspect: 'b', profileText: 'The user prefers Sony cameras in the benchmark set.', origin: 'benchmark' })
    assert.equal(m.countProfiles(), 2)
    assert.equal(m.countProfiles({ origin: 'live' }), 1)
    assert.equal(m.countProfiles({ origin: 'benchmark' }), 1)

    const live = m.search({ text: 'Sony cameras', limit: 5, profileQuota: 5 })
    assert.equal(live.filter((h) => h.kind === 'profile').length, 1, '默认只该看到 live 画像')

    const both = m.search({ text: 'Sony cameras', limit: 5, profileQuota: 5, includeOrigin: ['live', 'benchmark'] })
    assert.equal(both.filter((h) => h.kind === 'profile').length, 2, '显式包含 benchmark 时两条都在')
  } finally {
    t.cleanup(m)
  }
})

test('W4 旧库迁移：没有 origin 列的 mem_profiles 打开后自动补列且默认 live', () => {
  const t = makeTmp('prts-mem-profile-migrate-')
  const path = t.db('memory.sqlite')
  const first = MemoryStore.open(path)
  first.close()

  // 模拟这次改动之前的旧表结构
  const raw = new DatabaseSync(path)
  raw.exec('DROP TABLE IF EXISTS mem_fts_profiles; DROP TABLE IF EXISTS mem_profiles')
  raw.exec(`CREATE TABLE mem_profiles (
    profile_id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'prts', subject TEXT NOT NULL,
    aspect TEXT NOT NULL, profile_body TEXT NOT NULL, evidence_fact_ids TEXT,
    confidence REAL NOT NULL DEFAULT 0.5, updated_at_ms INTEGER NOT NULL, deleted_at_ms INTEGER
  )`)
  raw.prepare(
    `INSERT INTO mem_profiles (profile_id, scope, subject, aspect, profile_body, confidence, updated_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('old-1', 'prts', 'user', 'legacy', 'The user has a legacy profile row.', 0.8, Date.now())
  raw.close()

  const m = MemoryStore.open(path)
  try {
    assert.equal(m.countProfiles(), 1, '旧行应保留')
    assert.equal(m.countProfiles({ origin: 'live' }), 1, '旧行应回填为 live')
  } finally {
    t.cleanup(m)
  }
})
