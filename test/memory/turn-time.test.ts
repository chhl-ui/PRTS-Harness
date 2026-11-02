/** P0-1：recordTurn 的 occurredAtMs 投影与校验。 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/store.ts'
import { makeTmp } from '../support/tmp.ts'

const tmps: ReturnType<typeof makeTmp>[] = []
const stores: MemoryStore[] = []
after(() => {
  for (const s of stores) { try { s.close() } catch { /* 已关 */ } }
  for (const t of tmps) t.cleanup()
})
const open = () => {
  const t = makeTmp('prts-mtt-'); tmps.push(t)
  const dbPath = join(t.dir, 'memory.sqlite')
  const s = MemoryStore.open(dbPath); stores.push(s)
  const ro = () => new DatabaseSync(dbPath, { readOnly: true })
  return { s, ro }
}

test('occurredAtMs 传入 → occurred_at_ms 相等、occurred_raw 为 ISO', () => {
  const { s, ro } = open()
  const ms = 1730000000000
  const id = s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 't', occurredAtMs: ms })
  const raw = ro(); const row = raw.prepare('SELECT occurred_at_ms, occurred_raw FROM mem_turns WHERE turn_id = ?').get(id) as { occurred_at_ms: number | null; occurred_raw: string | null }; raw.close()
  assert.equal(row.occurred_at_ms, ms)
  assert.equal(row.occurred_raw, new Date(ms).toISOString())
  s.close()
})

test('occurredAtMs 非有限数 → throw，不落 NULL', () => {
  const { s } = open()
  assert.throws(() => s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 't', occurredAtMs: Number.NaN }))
  assert.throws(() => s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 't', occurredAtMs: Number.POSITIVE_INFINITY }))
  s.close()
})

test('occurredAtMs 与 occurredRaw 同传：ms 为准、raw 原样保留', () => {
  const { s, ro } = open()
  const id = s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 't', occurredAtMs: 1700000000000, occurredRaw: '去年冬天' })
  const raw = ro(); const row = raw.prepare('SELECT occurred_at_ms, occurred_raw FROM mem_turns WHERE turn_id = ?').get(id) as { occurred_at_ms: number; occurred_raw: string }; raw.close()
  assert.equal(row.occurred_at_ms, 1700000000000)
  assert.equal(row.occurred_raw, '去年冬天')
  s.close()
})

test('rebuildProjections 后时间保持；search 命中 occurredAtMs 非 null', () => {
  const { s, ro } = open()
  const ms = 1730000000000
  s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '独一关键词 雪豹快门', occurredAtMs: ms })
  s.rebuildProjections()
  const raw = ro(); const row = raw.prepare('SELECT occurred_at_ms FROM mem_turns').get() as { occurred_at_ms: number }; raw.close()
  assert.equal(row.occurred_at_ms, ms)
  const hits = s.search({ text: '雪豹快门', limit: 5 })
  const turn = hits.find(h => h.kind === 'turn')
  assert.ok(turn, '应命中 turn')
  assert.equal(turn.occurredAtMs, ms)
  s.close()
})
