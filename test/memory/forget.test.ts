/** P0-2a 存储层：turn/fact 级联删除、计划只读、事务内重算、纠正。 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const tmps: ReturnType<typeof makeTmp>[] = []
const stores: MemoryStore[] = []
after(() => {
  for (const s of stores) { try { s.close() } catch { /* 已关 */ } }
  for (const t of tmps) t.cleanup()
})
const open = () => {
  const t = makeTmp('prts-forget-'); tmps.push(t)
  const dbPath = join(t.dir, 'memory.sqlite')
  const s = MemoryStore.open(dbPath); stores.push(s)
  return { s, t, dbPath }
}

const SEED = 'ZXQ雪豹7731'

test('F1 turn 级联：正文/FTS/向量/提及/实体/session/物理字节全部清掉，链仍 ok', () => {
  const { s, dbPath } = open()
  const turnId = s.recordTurn({ actor: 'system', sessionId: 'sess1', turnIndex: 0, speaker: 'user', text: `我在研究 ${SEED} 配 Qorvex Halbrand 的离机高速同步`, occurredAtMs: Date.now() })
  s.consolidateRules() // 实体/mention/链接
  // 前置非空：否则下面「已删」的断言是空断言（topic 只收专名/引号短语）
  {
    const pre = new DatabaseSync(dbPath, { readOnly: true })
    const c = (sql: string) => (pre.prepare(sql).get() as { c: number }).c
    assert.ok(c('SELECT count(*) c FROM mem_entities') > 0, '前置：应有实体')
    assert.ok(c('SELECT count(*) c FROM mem_topics') > 0, '前置：应有 topic')
    pre.close()
  }
  const factId = s.assertFact({ actor: 'owner', subject: '博士', predicate: '研究', object: `${SEED} 器材`, provenance: 'stated', confirmationBasis: 'owner-stated', sourceTurnIds: [turnId] })
  const profileId = s.putProfile({ subject: '博士', aspect: '器材', profileText: `${SEED} 方向`, evidenceFactIds: [factId] })
  s.putSummary({ subjectKind: 'session', subjectId: 'sess1', text: `${SEED} 摘要`, sourceTurnIds: [turnId] })
  s.putVectors([
    { ownerKind: 'turn', ownerId: turnId, vector: [0.1, 0.2, 0.3, 0.4] },
    { ownerKind: 'fact', ownerId: factId, vector: [0.1, 0.2, 0.3, 0.4] },
    { ownerKind: 'profile', ownerId: profileId, vector: [0.1, 0.2, 0.3, 0.4] },
  ], 'test-model')

  const plan = s.planForget([turnId])
  assert.ok(plan.facts.includes(factId), 'plan 级联出 fact')
  assert.ok(plan.profiles.includes(profileId), 'plan 级联出 profile')
  assert.equal(plan.summaries.length, 1)
  assert.equal(plan.vectors, 3)
  const r = s.forget([turnId], 'owner')
  assert.equal(r.ok, true)

  const hits = s.search({ text: SEED, limit: 20, includeRetired: true, profileQuota: 5, summaryQuota: 5 })
  assert.equal(hits.length, 0, `search 零命中：${JSON.stringify(hits.map(h => h.id))}`)
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  const counts = (sql: string) => (raw.prepare(sql).get() as { c: number }).c
  assert.equal(counts(`SELECT count(*) c FROM mem_vectors WHERE owner_id IN ('${turnId}','${factId}','${profileId}')`), 0)
  assert.equal(counts(`SELECT count(*) c FROM mem_mentions WHERE turn_id = '${turnId}'`), 0)
  assert.equal(counts(`SELECT count(*) c FROM mem_entities`), 0, '只出现在该 turn 的实体应已删')
  assert.equal(counts(`SELECT count(*) c FROM mem_topics`), 0, '孤儿实体的 topic 行（主键=entity_key）应已删')
  const sess = raw.prepare(`SELECT body FROM mem_sessions WHERE session_id = 'sess1'`).all()
  assert.equal(sess.length, 0, '无剩余 turn → session 行删除')
  raw.close()
  s.close()
  // 物理字节：secure_delete + optimize + checkpoint 后主文件找不到原串
  const needle = Buffer.from(SEED)
  assert.equal(readFileSync(dbPath).includes(needle), false, 'memory.sqlite 字节里不应有原串')
  const wal = `${dbPath}-wal`
  if (existsSync(wal)) assert.equal(readFileSync(wal).includes(needle), false, 'wal 里也不应有原串')
  const s2 = MemoryStore.open(dbPath); stores.push(s2)
  s2.rebuildProjections()
  assert.equal(s2.search({ text: SEED, limit: 20, includeRetired: true }).length, 0, 'rebuild 后仍零命中')
  assert.equal(s2.verifyChain().ok, true)
})

test('F2 删 fact → 级联 profile 删除、源 turn 保留', () => {
  const { s } = open()
  const turnId = s.recordTurn({ actor: 'system', sessionId: 'sess1', turnIndex: 0, speaker: 'user', text: '源 turn 独一关键词 雪绒花9982', occurredAtMs: Date.now() })
  const factId = s.assertFact({ actor: 'owner', subject: '博士', predicate: '偏好', object: '雪绒花9982 器材', provenance: 'stated', confirmationBasis: 'owner-stated', sourceTurnIds: [turnId] })
  const profileId = s.putProfile({ subject: '博士', aspect: '器材', profileText: '雪绒花9982 画像', evidenceFactIds: [factId] })
  const r = s.forget([factId], 'owner')
  assert.equal(r.ok, true)
  assert.ok(r.plan!.profiles.includes(profileId), '级联出 profile')
  const hits = s.search({ text: '雪绒花9982', limit: 20, includeRetired: true, profileQuota: 5 })
  assert.equal(hits.some(h => h.id === turnId), true, `源 turn 应保留：${JSON.stringify(hits.map(h => h.id))}`)
  assert.equal(hits.some(h => h.id === profileId), false, 'profile 已删')
})

test('F3 planForget 只读 + notFound + 空计划拒绝', () => {
  const { s, dbPath } = open()
  const turnId = s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '只读验证 梅花鹿5511', occurredAtMs: Date.now() })
  const before = readFileSync(dbPath).length
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  const cntBefore = (raw.prepare('SELECT (SELECT count(*) FROM mem_turns) + (SELECT count(*) FROM mem_facts) AS c').get() as { c: number }).c
  const plan = s.planForget([turnId, 'turn-noexist', 'fact-noexist'])
  raw.close()
  assert.deepEqual(plan.turns, [turnId])
  assert.deepEqual(plan.notFound.sort(), ['fact-noexist', 'turn-noexist'].sort())
  const raw2 = new DatabaseSync(dbPath, { readOnly: true })
  const cntAfter = (raw2.prepare('SELECT (SELECT count(*) FROM mem_turns) + (SELECT count(*) FROM mem_facts) AS c').get() as { c: number }).c
  raw2.close()
  assert.equal(cntAfter, cntBefore, 'planForget 不得写库')
  assert.equal(readFileSync(dbPath).length, before, '文件字节不变')
  const r = s.forget(['turn-noexist'], 'owner')
  assert.equal(r.ok, false, '全 notFound → forget 拒绝')
})

test('F4 事务内重算：预览后新增的级联 fact 也被删', () => {
  const { s } = open()
  const turnId = s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '重算验证 北极熊4409', occurredAtMs: Date.now() })
  s.planForget([turnId]) // 预览（此刻还没有后加的 fact）
  const lateFact = s.assertFact({ actor: 'owner', subject: '博士', predicate: '研究', object: '北极熊4409', provenance: 'stated', confirmationBasis: 'owner-stated', sourceTurnIds: [turnId] })
  const r = s.forget([turnId], 'owner')
  assert.equal(r.ok, true)
  assert.ok(r.plan!.facts.includes(lateFact), `事务内重算应兜住后加的 fact：${JSON.stringify(r.plan!.facts)}`)
  assert.equal(s.search({ text: '北极熊4409', limit: 10, includeRetired: true }).length, 0)
})

test('C1 纠正：新值可检、旧值退役+superseded、边界全拒', () => {
  const { s, dbPath } = open()
  const old = s.assertFact({ actor: 'owner', subject: '博士', predicate: '偏好', object: '85mm 定焦', provenance: 'stated', confirmationBasis: 'owner-stated' })
  const newId = s.correctFact({ factId: old, object: '50mm 定焦', actor: 'owner' })
  const hits = s.search({ text: '50mm 定焦', limit: 10, includeRetired: true })
  assert.ok(hits.some(h => h.id === newId), `新值可检：${JSON.stringify(hits.map(h => h.id))}`)
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  const row = raw.prepare('SELECT retired_at_ms, superseded_by FROM mem_facts WHERE fact_id = ?').get(old) as { retired_at_ms: number | null; superseded_by: string | null }
  assert.ok(row.retired_at_ms !== null && row.superseded_by === newId, `旧行退役+指向新行：${JSON.stringify(row)}`)
  raw.close()
  assert.equal(s.restoreFacts({ factIds: [old] }), 0, 'superseded 行不参与 restore')
  s.rebuildProjections()
  assert.throws(() => s.correctFact({ factId: old, object: '再纠正' }), /已被 .* 取代/)
  s.deleteFact({ actor: 'owner', factId: newId })
  assert.throws(() => s.correctFact({ factId: newId, object: 'x' }), /已删除|不存在/)
  const turnId = s.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'x' })
  assert.throws(() => s.correctFact({ factId: turnId, object: 'y' }), /只能删除/)

  // 旧库迁移：缺 superseded_by 列打开后自动补上
  const t2 = makeTmp('prts-forget-old-'); tmps.push(t2)
  const oldPath = join(t2.dir, 'old.sqlite')
  {
    const legacy = new DatabaseSync(oldPath)
    legacy.exec(`CREATE TABLE memory_events (event_id TEXT PRIMARY KEY, kind TEXT, occurred_at_ms INTEGER, occurred_raw TEXT, recorded_at_ms INTEGER, actor_kind TEXT, scope TEXT, payload_json TEXT, prev_hash TEXT, hash TEXT, seq INTEGER);
      CREATE TABLE mem_bodies (body_ref TEXT PRIMARY KEY, sha256 TEXT, body TEXT, byte_length INTEGER, written_at_ms INTEGER);
      CREATE TABLE mem_facts (fact_id TEXT PRIMARY KEY, scope TEXT, subject TEXT, predicate TEXT, body_ref TEXT, recorded_at_ms INTEGER, provenance TEXT, confirmation_basis TEXT, origin TEXT, source_turn_ids TEXT, importance REAL, retired_at_ms INTEGER, deleted_at_ms INTEGER);
      CREATE TABLE mem_turns (turn_id TEXT PRIMARY KEY, scope TEXT, session_id TEXT, turn_index INTEGER, speaker TEXT, body_ref TEXT, occurred_at_ms INTEGER, origin TEXT, deleted_at_ms INTEGER);
      CREATE TABLE mem_summaries (summary_id TEXT PRIMARY KEY, scope TEXT, origin TEXT, subject_kind TEXT, subject_id TEXT, body_ref TEXT, source_turn_ids TEXT, generated_at_ms INTEGER, deleted_at_ms INTEGER);
      CREATE TABLE mem_topics (topic TEXT PRIMARY KEY, scope TEXT, entry_count INTEGER, last_seen_ms INTEGER, source_kind TEXT);
      CREATE TABLE mem_deletions (deletion_id TEXT PRIMARY KEY, scope TEXT, target_json TEXT, derivatives_json TEXT, state TEXT, completed_scope TEXT, completed INTEGER, requested_at INTEGER, completed_at INTEGER);
      CREATE TABLE mem_sessions (session_id TEXT PRIMARY KEY, scope TEXT, origin TEXT, body TEXT, turn_count INTEGER, updated_at_ms INTEGER);
      CREATE TABLE mem_profiles (profile_id TEXT PRIMARY KEY, scope TEXT, origin TEXT, subject TEXT, aspect TEXT, profile_body TEXT, evidence_fact_ids TEXT, confidence REAL, updated_at_ms INTEGER, deleted_at_ms INTEGER);
      CREATE TABLE mem_vectors (owner_kind TEXT, owner_id TEXT, model TEXT, dim INTEGER, vector BLOB, updated_at_ms INTEGER, PRIMARY KEY(owner_kind,owner_id));
      CREATE TABLE mem_consolidation (scope TEXT PRIMARY KEY, cursor_turn_rowid INTEGER, cursor_event_seq INTEGER, updated_at_ms INTEGER, budget_spent INTEGER);
      CREATE TABLE mem_entities (entity_key TEXT PRIMARY KEY, scope TEXT, name TEXT, kind TEXT, mention_count INTEGER, first_seen_ms INTEGER, last_seen_ms INTEGER);
      CREATE TABLE mem_links (from_key TEXT, to_key TEXT, kind TEXT, weight REAL, last_seen_ms INTEGER, PRIMARY KEY(from_key,to_key,kind));
      CREATE TABLE mem_mentions (entity_key TEXT, turn_id TEXT, PRIMARY KEY(entity_key,turn_id));`)
    legacy.close()
  }
  const migrated = MemoryStore.open(oldPath); stores.push(migrated)
  const cols = (migrated as unknown as { db: DatabaseSync }).db ?? undefined
  void cols
  const probe = new DatabaseSync(oldPath, { readOnly: true })
  const hasCol = (probe.prepare('PRAGMA table_info(mem_facts)').all() as { name: string }[]).some(c => c.name === 'superseded_by')
  probe.close()
  assert.equal(hasCol, true, '旧库打开后 superseded_by 列应自愈补上')
  migrated.close()
})

test('F1b 多 id：cascade_of 指向自己的触发顶层；derived_purged 只含本顶层派生', () => {
  const { s, dbPath } = open()
  const tA = s.recordTurn({ actor: 'system', sessionId: 'a', turnIndex: 0, speaker: 'user', text: '顶层A 金丝猴1101', occurredAtMs: Date.now() })
  const tB = s.recordTurn({ actor: 'system', sessionId: 'b', turnIndex: 0, speaker: 'user', text: '顶层B 丹顶鹤2202', occurredAtMs: Date.now() })
  const fB = s.assertFact({ actor: 'owner', subject: '博士', predicate: '研究', object: '只源自B的东西', provenance: 'stated', confirmationBasis: 'owner-stated', sourceTurnIds: [tB] })
  const pB = s.putProfile({ subject: '博士', aspect: 'b', profileText: '只源自B的画像', evidenceFactIds: [fB] })
  const r = s.forget([tA, tB], 'owner')
  assert.equal(r.ok, true)
  const raw = new DatabaseSync(dbPath, { readOnly: true })
  const evs = raw.prepare(`SELECT payload_json FROM memory_events WHERE kind = 'memory.deleted' ORDER BY seq`).all() as { payload_json: string }[]
  const byTarget = Object.fromEntries(evs.map(e => {
    const p = JSON.parse(e.payload_json) as { target_id: string; cascade_of?: string; derived_purged?: { profiles: string[] } }
    return [p.target_id, p]
  }))
  raw.close()
  assert.equal(byTarget[fB].cascade_of, tB, `级联 fact 的 cascade_of 应是 ${tB}：${JSON.stringify(byTarget[fB])}`)
  assert.deepEqual(byTarget[tA].derived_purged?.profiles ?? [], [], `turnA 的 derived_purged 不得含 turnB 的 profile ${pB}`)
  assert.deepEqual(byTarget[tB].derived_purged?.profiles ?? [], [pB], `turnB 的 derived_purged 应含 ${pB}`)
  assert.equal(byTarget[tA].cascade_of, undefined, '顶层目标不带 cascade_of')
})
