/**
 * 同槽取代（`supersedeSameSlot`）：更正标记 turn 触发同 subject|predicate 旧事实退役。
 *
 * 钉住的边界全是「不许误伤」：
 * - 同槽同文的重抽不能把在役当前值退役（F10 修复的回归点）；
 * - model-inferred 不许取代 owner-stated / verifier；
 * - 默认关闭时同槽并存不互删；
 * - 重放 rebuild 与增量写入得到同一投影。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type TextGenerator } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const openDb = (m: MemoryStore): DatabaseSync => (m as unknown as { db: DatabaseSync }).db

interface FactRow { fact_id: string; retired_at_ms: number | null; superseded_by: string | null; body: string | null }
function facts(m: MemoryStore): FactRow[] {
  return openDb(m).prepare(
    `SELECT f.fact_id, f.retired_at_ms, f.superseded_by, b.body
       FROM mem_facts f LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref`,
  ).all() as unknown as FactRow[]
}

const stated = { provenance: 'stated', confirmationBasis: 'owner-stated' } as const
const inferred = { provenance: 'inferred', confirmationBasis: 'model-inferred' } as const

test('SS1 开启后同槽旧值退役并记 superseded_by；默认检索只剩新值', () => {
  const t = makeTmp('prts-ss1-'); const m = MemoryStore.open(t.db())
  try {
    const old = m.assertFact({ actor: 'system', subject: '博士', predicate: '饮品偏好', object: '美式', slot: '咖啡', ...inferred })
    const nu = m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    const rows = facts(m)
    const oldRow = rows.find(r => r.fact_id === old)!
    assert.ok(oldRow.retired_at_ms !== null, '旧值应退役')
    assert.equal(oldRow.superseded_by, nu, '旧值应指向新值')
    assert.equal(rows.find(r => r.fact_id === nu)!.retired_at_ms, null, '新值在役')

    const hits = m.search({ text: '饮品偏好', limit: 10 })
    assert.equal(hits.filter(h => h.id === old).length, 0, '退役旧值默认不进检索')
    assert.ok(hits.some(h => h.id === nu), '新值可检索')
    const all = m.search({ text: '饮品偏好', limit: 10, includeRetired: true })
    assert.ok(all.some(h => h.id === old), '所有者视图能找回旧值')
  } finally { t.cleanup(m) }
})

test('SS2 默认关闭：同槽并存不互删', () => {
  const t = makeTmp('prts-ss2-'); const m = MemoryStore.open(t.db())
  try {
    m.assertFact({ actor: 'system', subject: '博士', predicate: '相机', object: '富士 X-T5', slot: '相机', ...inferred })
    m.assertFact({ actor: 'system', subject: '博士', predicate: '相机', object: '索尼 A7C2', slot: '相机', ...inferred })
    const live = facts(m).filter(r => r.retired_at_ms === null)
    assert.equal(live.length, 2, '不开开关时两台相机并存——并存与取代字符串层分不出来')
  } finally { t.cleanup(m) }
})

test('SS3 同槽同文重抽：在役同文行是当前值本身，不得被退役', () => {
  const t = makeTmp('prts-ss3-'); const m = MemoryStore.open(t.db())
  try {
    m.assertFact({ actor: 'system', subject: '博士', predicate: '饮品偏好', object: '美式', slot: '咖啡', ...inferred })
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    // 同一更正被第二次抽取：新写一行同文 dup 被拒后，不得在役「拿铁」行被自己的取代误伤
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    const live = facts(m).filter(r => r.retired_at_ms === null)
    assert.equal(live.length, 1, `应只剩在役「拿铁」：${JSON.stringify(live)}`)
    assert.equal(live[0]!.body, '拿铁')
  } finally { t.cleanup(m) }
})

test('SS4 model-inferred 不许取代 owner-stated；owner-stated 可取代 model-inferred', () => {
  const t = makeTmp('prts-ss4-'); const m = MemoryStore.open(t.db())
  try {
    const owner = m.assertFact({ actor: 'owner', subject: '博士', predicate: '饮品偏好', object: '美式', slot: '咖啡', ...stated })
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    assert.equal(facts(m).find(r => r.fact_id === owner)!.retired_at_ms, null,
      '模型抽出的新值不许顶掉主人明说的事实')

    const nu = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '饮品偏好', object: '澳白', slot: '咖啡',
      ...stated, supersedeSameSlot: true,
    })
    const rows = facts(m)
    const retired = rows.filter(r => r.retired_at_ms !== null && r.superseded_by === nu)
    assert.equal(retired.length, 2, 'owner-stated 新值应取代全部同槽在役行（含 owner-stated 与 model-inferred）')
  } finally { t.cleanup(m) }
})

test('SS5 consolidateFacts 端到端：更正标记 turn 的抽取触发取代，普通 turn 不触发', async () => {
  const t = makeTmp('prts-ss5-'); const m = MemoryStore.open(t.db())
  try {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '我喝咖啡只喝美式，不加糖。' })
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user', text: '我最近改喝拿铁了，不再喝美式。' })
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 2, speaker: 'user', text: '实验室在 B 楼 417 室。' })
    // 假生成器按 source_index 回指：0/1 两条饮品事实分属两条来源 turn
    const gen: TextGenerator = {
      model: 'fake',
      async generate() {
        return JSON.stringify([
          { subject: '博士', predicate: '饮品偏好', object: '美式', slot: '咖啡', source_index: 0 },
          { subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡', source_index: 1 },
          { subject: '博士', predicate: '实验室', object: 'B 楼 417 室', source_index: 2 },
        ])
      },
    }
    const r = await m.consolidateFacts({ generator: gen, limit: 10, batchSize: 10 })
    assert.equal(r.added, 3)
    const rows = facts(m)
    const americano = rows.find(r => r.body === '美式')!
    const latte = rows.find(r => r.body === '拿铁')!
    const lab = rows.find(r => r.body === 'B 楼 417 室')!
    assert.ok(americano.retired_at_ms !== null, '更正 turn 抽出的拿铁应取代美式')
    assert.equal(americano.superseded_by, latte.fact_id)
    assert.equal(lab.retired_at_ms, null, '无更正标记的 turn 不触发取代')
  } finally { t.cleanup(m) }
})

test('SS6 重放 rebuild 与增量写入投影一致', () => {
  const t = makeTmp('prts-ss6-'); const m = MemoryStore.open(t.db())
  try {
    const old = m.assertFact({ actor: 'system', subject: '博士', predicate: '饮品偏好', object: '美式', slot: '咖啡', ...inferred })
    const nu = m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    m.rebuildProjections()
    const rows = facts(m)
    const oldRow = rows.find(r => r.fact_id === old)!
    assert.ok(oldRow.retired_at_ms !== null, '重建后旧值仍应退役')
    assert.equal(oldRow.superseded_by, nu, '重建后 superseded_by 不丢')
    assert.equal(rows.find(r => r.fact_id === nu)!.retired_at_ms, null)
  } finally { t.cleanup(m) }
})

test('SS7 泛谓词不连坐：同 predicate 不同 slot 的并存事实不得退役（polars 事故回归）', () => {
  const t = makeTmp('prts-ss7-'); const m = MemoryStore.open(t.db())
  try {
    // 真机形态：polars 与美式咖啡同为「偏好」谓词但不同主题——拿铁更正只许退役咖啡槽
    m.assertFact({ actor: 'system', subject: '博士', predicate: '偏好', object: 'Python 的 polars', slot: '数据处理库', ...inferred })
    m.assertFact({ actor: 'system', subject: '博士', predicate: '偏好', object: '美式', slot: '咖啡', ...inferred })
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '偏好', object: '拿铁', slot: '咖啡',
      ...inferred, supersedeSameSlot: true,
    })
    const rows = facts(m)
    assert.equal(rows.find(r => r.body === 'Python 的 polars')!.retired_at_ms, null,
      '不同 slot 的同谓词事实不得被连坐退役')
    assert.ok(rows.find(r => r.body === '美式')!.retired_at_ms !== null, '同槽旧值应退役')
    assert.equal(rows.find(r => r.body === '拿铁')!.retired_at_ms, null)
  } finally { t.cleanup(m) }
})

test('SS8 措辞漂移不挡道：不同 predicate 同 slot 的旧值仍退役（实验室事故回归）', () => {
  const t = makeTmp('prts-ss8-'); const m = MemoryStore.open(t.db())
  try {
    m.assertFact({ actor: 'system', subject: '博士', predicate: '拥有', object: '实验室在 B 楼 417 室', slot: '实验室', ...inferred })
    const nu = m.assertFact({
      actor: 'system', subject: '博士', predicate: '住在', object: 'C 楼 203 室', slot: '实验室',
      ...inferred, supersedeSameSlot: true,
    })
    const old = facts(m).find(r => r.body === '实验室在 B 楼 417 室')!
    assert.ok(old.retired_at_ms !== null, '同 slot 不同谓词的旧值应退役')
    assert.equal(old.superseded_by, nu)
  } finally { t.cleanup(m) }
})

test('SS9 无 slot 放弃取代：宁漏勿滥，绝不退回谓词匹配', () => {
  const t = makeTmp('prts-ss9-'); const m = MemoryStore.open(t.db())
  try {
    m.assertFact({ actor: 'system', subject: '博士', predicate: '饮品偏好', object: '美式', ...inferred })
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '拿铁',
      ...inferred, supersedeSameSlot: true, // 无 slot
    })
    const live = facts(m).filter(r => r.retired_at_ms === null)
    assert.equal(live.length, 2, '无 slot 的更正不触发任何退役')
    // 空串 slot 同样不触发
    m.assertFact({
      actor: 'system', subject: '博士', predicate: '饮品偏好', object: '澳白', slot: '  ',
      ...inferred, supersedeSameSlot: true,
    })
    assert.equal(facts(m).filter(r => r.retired_at_ms === null).length, 3)
  } finally { t.cleanup(m) }
})
