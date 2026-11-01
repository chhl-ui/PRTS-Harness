/**
 * 模型层事实抽取（`MemoryStore.consolidateFacts`）。
 *
 * 用假 generator，不起模型。钉住五件事：写入的正是模型抽的内容、重复抽取不产生
 * 第二条、非法输出不卡住水位线、单条坏数据不拖累整批、只抽 live。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, type TextGenerator } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

function fakeGen(replies: string[]): TextGenerator & { prompts: string[] } {
  const prompts: string[] = []
  let i = 0
  return {
    model: 'fake-1',
    prompts,
    async generate(prompt: string): Promise<string> {
      prompts.push(prompt)
      const reply = replies[Math.min(i, replies.length - 1)]
      i++
      return reply ?? '[]'
    },
  }
}

function open(prefix: string): { store: MemoryStore; dbPath: string; cleanup: () => void } {
  const t = makeTmp(prefix)
  const dbPath = t.db()
  const store = MemoryStore.open(dbPath)
  return { store, dbPath, cleanup: () => t.cleanup(store) }
}

function seedTurns(store: MemoryStore, texts: string[]): void {
  texts.forEach((text, i) => {
    store.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: i, speaker: 'user', text,
    })
  })
}

test('F1 抽取写入事实：字段、来源、provenance 都对', async () => {
  const { store, dbPath, cleanup } = open('prts-facts-f1-')
  try {
    seedTurns(store, ['我偏好光学镜头设计', '我住在杭州'])
    const gen = fakeGen([JSON.stringify([
      { subject: '博士', predicate: '偏好', object: '光学镜头设计', source_index: 0 },
      { subject: '博士', predicate: '住在', object: '杭州', source_index: 1 },
    ])])
    const r = await store.consolidateFacts({ generator: gen, limit: 10, batchSize: 2 })
    assert.equal(r.turns, 2)
    assert.equal(r.extracted, 2)
    assert.equal(r.added, 2)
    assert.equal(r.stop, 'done')
    assert.equal(store.countFacts(), 2)
    assert.equal(gen.prompts.length, 1, '两条 turn 一批只应推理一次')

    // 检索会同时命中 turn（原始对话）与 fact（抽出来的事实），按 kind 分开断言
    const hits = store.search({ text: '光学' })
    const factHits = hits.filter((h) => h.kind === 'fact')
    assert.equal(factHits.length, 1)
    assert.equal(factHits[0]?.text, '光学镜头设计')
    assert.equal(factHits[0]?.provenance, 'inferred')
    assert.ok(hits.some((h) => h.kind === 'turn'), '原始对话本身也应可检索')

    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const row = db.prepare(
        "SELECT provenance, confirmation_basis, origin, source_turn_ids FROM mem_facts WHERE predicate = '偏好'",
      ).get() as { provenance: string; confirmation_basis: string; origin: string; source_turn_ids: string }
      assert.equal(row.provenance, 'inferred')
      assert.equal(row.confirmation_basis, 'model-inferred')
      assert.equal(row.origin, 'live')
      assert.equal(JSON.parse(row.source_turn_ids).length, 1, 'source_index 应被翻译成真实 turn_id')
    } finally {
      db.close()
    }
  } finally {
    cleanup()
  }
})

test('F2 幂等：水位线清零后重抽同一批不新增，但会消耗模型调用', async () => {
  const { store, dbPath, cleanup } = open('prts-facts-f2-')
  try {
    seedTurns(store, ['我偏好光学镜头设计'])
    const reply = JSON.stringify([
      { subject: '博士', predicate: '偏好', object: '光学镜头设计', source_index: 0 },
    ])
    const gen1 = fakeGen([reply])
    await store.consolidateFacts({ generator: gen1, limit: 10 })
    assert.equal(store.countFacts(), 1)

    // 把水位线拨回去，模拟「重跑同一批」
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('UPDATE mem_consolidation SET fact_cursor_turn_rowid = 0')
    } finally {
      db.close()
    }
    const gen2 = fakeGen([reply])
    const r2 = await store.consolidateFacts({ generator: gen2, limit: 10 })
    assert.equal(r2.extracted, 1, '模型仍然抽到了一条')
    assert.equal(r2.added, 0, '但库里不该出现第二条')
    assert.equal(store.countFacts(), 1)
  } finally {
    cleanup()
  }
})

test('F3 模型输出不是 JSON：不写库、水位线照常推进、不卡死', async () => {
  const { store, cleanup } = open('prts-facts-f3-')
  try {
    seedTurns(store, ['我偏好光学镜头设计'])
    const gen = fakeGen(['抱歉，我无法完成这个请求。'])
    const r = await store.consolidateFacts({ generator: gen, limit: 10 })
    assert.equal(r.extracted, 0)
    assert.equal(r.added, 0)
    assert.ok(r.skipped >= 1)
    assert.equal(r.turns, 1, '坏输出也要推进，否则同一批会被无限重试')
    assert.equal(store.countFacts(), 0)
  } finally {
    cleanup()
  }
})

test('F4 单条坏数据不拖累整批', async () => {
  const { store, cleanup } = open('prts-facts-f4-')
  try {
    seedTurns(store, ['我偏好光学镜头设计', '我住在杭州', '我在做 PRTS'])
    const gen = fakeGen([JSON.stringify([
      { subject: '博士', predicate: '偏好', object: '光学镜头设计', source_index: 0 },
      { subject: '博士', predicate: '住在' },
      { subject: '博士', predicate: '正在做', object: 'PRTS', source_index: 2 },
    ])])
    const r = await store.consolidateFacts({ generator: gen, limit: 10 })
    assert.equal(r.extracted, 2)
    assert.equal(r.skipped, 1)
    assert.equal(store.countFacts(), 2)
  } finally {
    cleanup()
  }
})

test('F5 limit 与 budget：取满即报 budget，分批推理', async () => {
  const { store, cleanup } = open('prts-facts-f5-')
  try {
    seedTurns(store, ['a 我偏好光学', 'b 我住在杭州', 'c 我在做 PRTS', 'd 我用 Windows', 'e 我喜欢咖啡'])
    const gen = fakeGen([JSON.stringify([
      { subject: '博士', predicate: '偏好', object: '记录', source_index: 0 },
    ])])
    const r = await store.consolidateFacts({ generator: gen, limit: 2, batchSize: 1 })
    assert.equal(r.turns, 2)
    assert.equal(r.stop, 'budget', '还有未处理的 turn 时必须报 budget')
    assert.equal(gen.prompts.length, 2, 'batchSize=1 时两条 turn 分两次推理')
  } finally {
    cleanup()
  }
})

test('F6 benchmark 对话不抽：只在 live 上工作', async () => {
  const { store, cleanup } = open('prts-facts-f6-')
  try {
    store.recordTurn({
      actor: 'system', sessionId: 'b1', turnIndex: 0, speaker: 'user',
      text: 'benchmark 里的偏好', origin: 'benchmark',
    })
    const gen = fakeGen(['[]'])
    const r = await store.consolidateFacts({ generator: gen, limit: 10 })
    assert.equal(r.turns, 0)
    assert.equal(gen.prompts.length, 0, '没有 live turn 就不该调模型')
  } finally {
    cleanup()
  }
})
