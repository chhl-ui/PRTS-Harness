/**
 * 模型巩固（Wave C）。
 *
 * 全部用假 generator（返回固定 JSON），不连模型——否则测试要起一个 27B 模型，
 * 变成不可跑。测的是**机制**：游标独立、失败不推进、幂等、产物落库可检索。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, consolidateProfiles, readConsolidationCursor, runConsolidation, type TextGenerator,
} from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

/** 固定输出的假生成器：每批固定返回两条画像。 */
const fakeGen = (profiles = 2, model = 'fake-gen'): TextGenerator => ({
  model,
  async generate(): Promise<string> {
    const arr = Array.from({ length: profiles }, (_, i) => ({
      subject: 'user', aspect: `topic_${i}`, profile: `The user prefers synthetic option ${i} for testing.`,
    }))
    return JSON.stringify(arr)
  },
})

const failingGen = (): TextGenerator => ({
  model: 'failing',
  async generate(): Promise<string> { throw new Error('model down') },
})

const seed = (m: MemoryStore, n = 5): void => {
  for (let i = 0; i < n; i++) {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: i, speaker: 'user', text: `turn ${i} about camera gear` })
  }
}

const openDb = (m: MemoryStore): DatabaseSync => {
  // 只需一个能跑 consolidateProfiles 的句柄；用 MemoryStore 同一个库文件
  const db = (m as unknown as { db: DatabaseSync }).db
  return db
}

test('M1 模型巩固产出画像，且能通过 profile 路检索到', async () => {
  const t = makeTmp('prts-mem-consolidate-model-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 5)
    const r = await consolidateProfiles(openDb(m), { generator: fakeGen(2), maxTurns: 100 })
    assert.equal(r.turns, 5, '应处理 5 条 turn')
    assert.equal(r.profiles, 2, '应写入 2 条画像')
    assert.equal(r.stopped, 'done')
    assert.equal(m.countProfiles(), 2)

    const hits = m.search({ text: 'synthetic option', limit: 5, profileQuota: 3 })
    assert.ok(hits.filter((h) => h.kind === 'profile').length >= 1, '画像应可检索')
  } finally {
    t.cleanup(m)
  }
})

test('M2 模型调用失败不推进游标（下次重跑同一批）', async () => {
  const t = makeTmp('prts-mem-consolidate-fail-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 5)
    const db = openDb(m)
    const before = readConsolidationCursor(db, 'prts:profile')

    const r = await consolidateProfiles(db, { generator: failingGen(), maxTurns: 100 })
    assert.equal(r.stopped, 'failed', '应报 failed')
    assert.equal(r.profiles, 0)
    assert.equal(r.failed, 5)
    assert.equal(readConsolidationCursor(db, 'prts:profile'), before, '失败的批次不能让游标前进')

    // 换好的生成器重跑，同一批 turn 应被重新处理
    const r2 = await consolidateProfiles(db, { generator: fakeGen(2), maxTurns: 100 })
    assert.equal(r2.turns, 5, '失败后重跑应重新覆盖同一批')
    assert.equal(m.countProfiles(), 2)
  } finally {
    t.cleanup(m)
  }
})

test('M3 模型游标与规则巩固的游标互相独立', async () => {
  const t = makeTmp('prts-mem-consolidate-scope-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 6)
    const db = openDb(m)

    // 规则巩固先把 'prts' 游标推到末尾
    runConsolidation(db, { maxTurns: 100 })
    const ruleCursor = readConsolidationCursor(db, 'prts')
    assert.ok(ruleCursor > 0)

    // 模型巩固用自己的 scope，不该被规则游标挡住
    const r = await consolidateProfiles(db, { generator: fakeGen(1), maxTurns: 100 })
    assert.equal(r.turns, 6, `模型游标应独立，实际处理 ${r.turns} 条`)
    // 注意不能断言两个游标的**值**不等——它们恰好都会停在最后一行的 rowid 上，
    // 那不代表独立。独立性由「规则已经跑到末尾、模型仍能处理 6 条」证明。
    assert.ok(readConsolidationCursor(db, 'prts:profile') > 0, '模型游标应存在')
  } finally {
    t.cleanup(m)
  }
})

test('M4 幂等：跑完再跑不再处理（游标已到末尾）', async () => {
  const t = makeTmp('prts-mem-consolidate-midem-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 4)
    const db = openDb(m)
    await consolidateProfiles(db, { generator: fakeGen(2), maxTurns: 100 })
    const first = m.countProfiles()

    const again = await consolidateProfiles(db, { generator: fakeGen(2), maxTurns: 100 })
    assert.equal(again.turns, 0, '第二次没有新 turn')
    assert.equal(m.countProfiles(), first, '画像数不该增长')
  } finally {
    t.cleanup(m)
  }
})

test('M6 生成器收到的 prompt 含指令与 turn 正文（防空壳 prompt 回归）', async () => {
  const t = makeTmp('prts-mem-consolidate-prompt-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 3)
    const seen: string[] = []
    const spy: TextGenerator = {
      model: 'spy',
      async generate(p: string) { seen.push(p); return '[]' },
    }
    await consolidateProfiles(openDb(m), { generator: spy, maxTurns: 100 })
    assert.equal(seen.length, 1, '一批一次调用')
    assert.ok(seen[0]!.includes('durable preferences'), `prompt 必须含画像指令：${seen[0]!.slice(0, 120)}`)
    assert.ok(seen[0]!.includes('turn 0 about camera gear'), `prompt 必须含 turn 正文：${seen[0]!.slice(0, 200)}`)
  } finally {
    t.cleanup(m)
  }
})

test('M5 生成器输出非 JSON 时不崩，也不写垃圾画像', async () => {
  const t = makeTmp('prts-mem-consolidate-garbage-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m, 3)
    const bad: TextGenerator = { model: 'bad', async generate() { return 'sorry, I cannot help with that.' } }
    const r = await consolidateProfiles(openDb(m), { generator: bad, maxTurns: 100 })
    assert.equal(r.profiles, 0, '解析不出数组时不该写画像')
    assert.equal(r.turns, 3, '但游标仍应推进——这批确实处理过了，重跑也是同样的垃圾输出')
    assert.equal(m.countProfiles(), 0)
  } finally {
    t.cleanup(m)
  }
})
