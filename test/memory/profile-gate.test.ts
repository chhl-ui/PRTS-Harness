/**
 * 画像闸门（Wave 0 失败的直接修复）。
 *
 * Wave 0 实测（3 题，0/3）：每题生成 **37–43 条**画像，全部塞进 `mem_facts`，
 * 而 top-8 里 fact 只占 4 个名额（`factQuota = ceil(8/2)`）——37 条里选 4 条，
 * 无关画像（"已婚"、"社区剧院"）靠字面匹配挤掉相关画像。
 *
 * 闸门两条，缺一不可：
 *   1. **身份独立**：画像有自己的表与 FTS，不再和普通 fact 混池；
 *   2. **名额独立**：检索按 kind 分组，画像有单独配额，不被 turn/fact 挤掉。
 *
 * 注意：闸门只解决"选不中"的问题，不解决"生成太多"——后者要靠归纳侧的质量闸门
 * （Wave 3），本文件不涉及。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const seedProfiles = (path: string, n: number): void => {
  const raw = new DatabaseSync(path)
  for (let i = 0; i < n; i++) {
    raw.prepare(
      `INSERT INTO mem_profiles (profile_id, scope, subject, aspect, profile_body, confidence, updated_at_ms)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(`prof-${i}`, 'prts', 'user', 'photography', `The user prefers camera gear ${i} compatible with Sony bodies.`, 0.8, Date.now())
  }
  raw.exec(`INSERT INTO mem_fts_profiles(rowid, body) SELECT rowid, profile_body FROM mem_profiles`)
  raw.close()
}

test('P1 画像有独立名额：不被 turn 挤掉', () => {
  const t = makeTmp('prts-mem-profile-quota-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    for (let i = 0; i < 10; i++) {
      m.recordTurn({
        actor: 'system', sessionId: 's1', turnIndex: i,
        speaker: 'user', text: `camera gear turn ${i} for Sony bodies preference`,
      })
    }
    seedProfiles(path, 3)

    const hits = m.search({ text: 'camera gear Sony', limit: 6, profileQuota: 2 })
    const profiles = hits.filter((h) => h.kind === 'profile')
    const turns = hits.filter((h) => h.kind === 'turn')
    assert.ok(profiles.length >= 1, `画像必须有独立名额，实际 ${profiles.length}`)
    assert.ok(turns.length >= 1, `turn 不能被画像挤光，实际 ${turns.length}`)
  } finally {
    t.cleanup(m)
  }
})

test('P2 profileQuota=0 时画像不进结果（默认关闭，不改变现有基线）', () => {
  const t = makeTmp('prts-mem-profile-off-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'camera gear Sony preference' })
    seedProfiles(path, 3)

    const hits = m.search({ text: 'camera gear Sony', limit: 6 })
    assert.equal(hits.filter((h) => h.kind === 'profile').length, 0, '默认不开画像路，基线不受影响')
    assert.ok(hits.length >= 1, 'turn 仍能检索到')
  } finally {
    t.cleanup(m)
  }
})

test('P3 记忆库重建投影后，画像索引仍可用', () => {
  const t = makeTmp('prts-mem-profile-rebuild-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'camera gear' })
    seedProfiles(path, 2)

    // 画像是由巩固写入的派生项，不属于事件链重放范内——重建后应保留
    m.rebuildProjections()

    const hits = m.search({ text: 'Sony compatible camera', limit: 6, profileQuota: 2 })
    assert.ok(hits.filter((h) => h.kind === 'profile').length >= 1, '重建后画像仍可检索')
  } finally {
    t.cleanup(m)
  }
})
