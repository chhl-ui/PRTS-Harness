/**
 * 「阅读」阶段（`src/memory/reading.ts`，roadmap P1）的组织与渲染测试。
 *
 * 钉住的核心承诺：命中按主题/会话归组成卡、组内时间升序并标「最新」；
 * 分不出组时输出与旧平铺逐字一致（评测口径不变）；「最新/较早」只陈述
 * 时间，同槽并存事实不判对错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { MemoryStore, organizeReading, renderReading } from '../../src/memory/index.ts'
import type { FactMeta, MemoryHit, TurnEntityMention } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const T0 = 1_700_000_000_000 // 2023-11-14T22:13:20Z

function turn(id: string, text: string, atMs: number | null, sessionId = 's-old'): MemoryHit {
  return {
    kind: 'turn', id, score: 1, origin: 'live', sessionId,
    ...(atMs === null ? {} : { occurredAtMs: atMs }),
    text, recallPath: 'like',
  }
}

function fact(id: string, text: string): MemoryHit {
  return { kind: 'fact', id, score: 1, origin: 'live', text, recallPath: 'fts-trigram', provenance: 'stated' }
}

function meta(slot: string | null, recordedAtMs: number, sourceTurnIds: string[] = []): FactMeta {
  return {
    subject: '博士', predicate: '偏好', slot,
    validFromMs: null, recordedAtMs, sourceTurnIds,
  }
}

test('R1 共享实体的两条 turn 归成主题卡，时间升序并标「最新/较早」', () => {
  const hits = [
    turn('t-new', '主力相机换成了 Sony A7C2', T0 + 86_400_000),
    turn('t-old', '我买了富士 X-T5 当主力机', T0),
  ]
  const entities = new Map<string, TurnEntityMention[]>([
    ['t-new', [{ key: '相机', name: '相机', mentionCount: 5 }]],
    ['t-old', [{ key: '相机', name: '相机', mentionCount: 5 }]],
  ])
  const cards = organizeReading(hits, { turnEntities: entities })
  assert.equal(cards.length, 1)
  assert.equal(cards[0].kind, 'topic')
  assert.equal(cards[0].title, '相机')
  assert.deepEqual(cards[0].hits.map((h) => h.id), ['t-old', 't-new'], '组内时间升序')

  const r = renderReading(hits, { turnEntities: entities })
  assert.equal(r.grouped, true)
  assert.match(r.body, /【相机】/)
  assert.match(r.body, /· 较早 — 我买了富士 X-T5/, '旧值标「较早」')
  assert.match(r.body, /· 最新 — 主力相机换成了 Sony A7C2/, '新值标「最新」')
})

test('R2 fact slot + 正文含 slot 的 turn + 来源 turn 合成一张「咖啡」卡（拿铁场景）', () => {
  // V1-06 的完整形态：旧值 turn（正文含「咖啡」）+ 更正 turn（事实的来源）
  // + 新值 fact（slot=咖啡）。三者零共享检索键之外全靠阅读阶段连起来。
  const hits = [
    turn('t-correct', '更正一下：我最近改喝拿铁了，不再喝美式', T0 + 2 * 86_400_000),
    turn('t-old', '我喜欢美式咖啡，每天一杯', T0),
    fact('f-latte', '拿铁'),
  ]
  const factMeta = new Map<string, FactMeta>([
    ['f-latte', meta('咖啡', T0 + 2 * 86_400_000 + 1000, ['t-correct'])],
  ])
  const cards = organizeReading(hits, { factMeta })
  assert.equal(cards.length, 1, '三条命中应归成一张卡')
  assert.equal(cards[0].title, '咖啡')
  assert.deepEqual(
    cards[0].hits.map((h) => h.id),
    ['t-old', 't-correct', 'f-latte'],
    '旧陈述 → 更正 → 新事实，时间升序',
  )

  const r = renderReading(hits, { factMeta })
  assert.match(r.body, /【咖啡】/)
  assert.match(r.body, /博士·偏好：拿铁/, 'fact 在卡里补主谓展示')
  assert.match(r.body, /· 最新 — 博士·偏好：拿铁/, '最新记录是新事实')
})

test('R3 无共享键时输出与旧平铺格式逐字一致（评测口径不变）', () => {
  const hits = [
    turn('t1', '光学镜头笔记', T0, 's1'),
    fact('f1', '85mm'),
  ]
  const r = renderReading(hits, { factMeta: new Map([['f1', meta(null, T0)]]) })
  assert.equal(r.grouped, false)
  assert.equal(
    r.body,
    `1. [turn] ${new Date(T0).toISOString()} — 光学镜头笔记\n`
    + `2. [fact] ${new Date(T0).toISOString()} — 85mm`,
  )
})

test('R4 没进主题卡的同 session turn 兜底成会话卡', () => {
  const hits = [
    turn('t1', '第一条', T0, 'sess-A'),
    turn('t2', '第二条', T0 + 1000, 'sess-A'),
    turn('t3', '别会话的', T0 + 500, 'sess-B'),
  ]
  const cards = organizeReading(hits)
  assert.equal(cards.length, 2)
  const sessionCard = cards.find((c) => c.hits.length === 2)
  assert.equal(sessionCard?.kind, 'session')
  assert.match(sessionCard?.title ?? '', /同一会话的 2 条记录/)
})

test('R4b 会话卡不标「最新/较早」——同场对话的碎片不是冲突取值', () => {
  const hits = [
    turn('t1', '第一条', T0, 'sess-A'),
    turn('t2', '第二条', T0 + 1000, 'sess-A'),
  ]
  const r = renderReading(hits)
  assert.equal(r.grouped, true)
  assert.match(r.body, /【同一会话的 2 条记录】/)
  assert.equal(r.body.includes('· 最新'), false, '会话卡不应标新旧')
  assert.equal(r.body.includes('· 较早'), false)
})

test('R5 枢纽实体（mentionCount 超限）不做聚合键', () => {
  const hits = [
    turn('t1', '第一条提到 Python', T0, 's1'),
    turn('t2', '第二条也提到 Python', T0 + 1000, 's2'),
  ]
  const entities = new Map<string, TurnEntityMention[]>([
    ['t1', [{ key: 'python', name: 'Python', mentionCount: 5000 }]],
    ['t2', [{ key: 'python', name: 'Python', mentionCount: 5000 }]],
  ])
  const cards = organizeReading(hits, { turnEntities: entities, hubMentionLimit: 64 })
  assert.equal(cards.every((c) => c.hits.length === 1), true, '枢纽实体不应聚卡')
})

test('R6 同 slot 两条在役 fact 归卡（同槽并存合法，标记只陈述时间）', () => {
  const hits = [fact('f1', '富士 X-T5'), fact('f2', '索尼 A7C2')]
  const factMeta = new Map<string, FactMeta>([
    ['f1', meta('相机', T0)],
    ['f2', meta('相机', T0 + 86_400_000)],
  ])
  const r = renderReading(hits, { factMeta })
  assert.equal(r.grouped, true)
  assert.match(r.body, /【相机】/)
  assert.match(r.body, /· 较早 — 博士·偏好：富士 X-T5/)
  assert.match(r.body, /· 最新 — 博士·偏好：索尼 A7C2/)
})

test('R7 卡片 + 散件并存时散件走「其他命中」编号尾巴', () => {
  const hits = [
    turn('t1', '提到相机的第一条', T0, 's1'),
    turn('t2', '提到相机的第二条', T0 + 1000, 's2'),
    turn('t3', '完全无关的一条', T0 + 500, 's3'),
  ]
  const entities = new Map<string, TurnEntityMention[]>([
    ['t1', [{ key: '相机', name: '相机', mentionCount: 3 }]],
    ['t2', [{ key: '相机', name: '相机', mentionCount: 3 }]],
  ])
  const r = renderReading(hits, { turnEntities: entities })
  assert.equal(r.grouped, true)
  assert.match(r.body, /【相机】/)
  assert.match(r.body, /其他命中：\n1\. \[turn\].+完全无关/s, '散件保持编号列表')
})

test('R8 时间全部未知时不标「最新」——未知时间不许冒称', () => {
  const hits = [turn('t1', 'A', null, 's1'), turn('t2', 'B', null, 's2')]
  const entities = new Map<string, TurnEntityMention[]>([
    ['t1', [{ key: 'x', name: 'X', mentionCount: 3 }]],
    ['t2', [{ key: 'x', name: 'X', mentionCount: 3 }]],
  ])
  const r = renderReading(hits, { turnEntities: entities })
  assert.equal(r.grouped, true)
  assert.equal(r.body.includes('· 最新'), false)
  assert.equal(r.body.includes('· 较早'), false)
})

test('R9 store 层补查：factMeta / turnEntities 返回真实投影数据', () => {
  const t = makeTmp('prts-read-meta-')
  const store = MemoryStore.open(t.db())
  try {
    const tid = store.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: '我买了 Godox V1 闪光灯', occurredAtMs: T0,
    })
    const fid = store.assertFact({
      actor: 'model', subject: '博士', predicate: '使用', object: 'Godox V1',
      provenance: 'inferred', confirmationBasis: 'model-inferred',
      slot: '闪光灯', sourceTurnIds: [tid],
    })
    const fm = store.factMeta([fid]).get(fid)
    assert.equal(fm?.slot, '闪光灯')
    assert.equal(fm?.subject, '博士')
    assert.deepEqual(fm?.sourceTurnIds, [tid])

    // mem_mentions 由规则巩固写：直接补一行验证 turnEntities 的联查。
    const db = (store as unknown as { db: DatabaseSync }).db
    db.prepare(`INSERT INTO mem_entities (entity_key, scope, name, kind, mention_count, first_seen_ms, last_seen_ms)
                VALUES ('godox v1', 'prts', 'Godox V1', 'proper', 2, 1, 1)`).run()
    db.prepare('INSERT INTO mem_mentions (entity_key, turn_id) VALUES (?,?)').run('godox v1', tid)
    const ents = store.turnEntities([tid]).get(tid)
    assert.equal(ents?.length, 1)
    assert.equal(ents[0].key, 'godox v1')
    assert.equal(ents[0].name, 'Godox V1')
    assert.equal(ents[0].mentionCount, 2)
  } finally {
    t.cleanup(store)
  }
})

test('R10 空 deps 时一切退回平铺（缺数据不是错）', () => {
  const hits = [turn('t1', 'A', T0, 's1'), turn('t2', 'B', T0 + 1, 's2')]
  const r = renderReading(hits)
  assert.equal(r.grouped, false)
  assert.match(r.body, /^1\. \[turn\]/)
})
