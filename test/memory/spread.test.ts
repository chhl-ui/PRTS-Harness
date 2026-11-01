/**
 * 扩散激活（Wave 4）。
 *
 * 测的是接线，不是效果：图里实体相邻的 turn 能不能被召回、会不会越跳、
 * 关掉时行为是否一字不变。**效果（any@8 升还是降）由评测集量，不在单测里断言**
 * ——单测断言的是机制，效果要几百道题才说得清。
 *
 * 场景用真实的「同 turn 共现」形态构造：A 同时提到 godox 与 gitzo，于是这两个
 * 实体在图里相连；B 只提 gitzo。查 godox 时，bm25 命不中 B，扩散应当能把它带出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const seed = (m: MemoryStore): void => {
  // 种子 turn 只含 godox + sony；gitzo 只出现在第二条里、与 sony 相连。
  // 这样才是真正的扩散：「godox → 邻居 gitzo → 含 gitzo 的另一条 turn」，
  // 而不是把种子 turn 自己的实体再召回一遍（那种情况下邻居集恰好等于种子集，
  // 会被剔除种子逻辑清空——第一版测试就是这么假通过的）。
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
    text: 'The Godox V1 flash works well with the Sony A7R IV body.',
  })
  m.recordTurn({
    actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user',
    text: 'The Sony A7R IV pairs nicely with a Gitzo tripod.',
  })
  m.recordTurn({
    actor: 'system', sessionId: 's2', turnIndex: 0, speaker: 'user',
    text: 'The user is planning a trip to Kyoto in March.',
  })
  m.consolidateRules({ maxTurns: 100 })
}

const sources = (h: { recallPath: string; recallPaths?: string[] }): string[] =>
  h.recallPaths ?? [h.recallPath]

test('S1 默认关闭：spreadHops 未给时结果里不出现 spread 召回', () => {
  const t = makeTmp('prts-mem-spread-off-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const hits = m.search({ text: 'Godox flash', limit: 10 })
    assert.equal(
      hits.filter((h) => sources(h).includes('spread')).length, 0,
      '默认关闭时不能有任何扩散召回',
    )
  } finally {
    t.cleanup(m)
  }
})

test('S2 一跳扩散：实体相邻的 turn 被召回，且标记来源为 spread', () => {
  const t = makeTmp('prts-mem-spread-on-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)

    const off = m.search({ text: 'Godox flash', limit: 10 })
    const offIds = off.map((h) => h.id)

    const on = m.search({ text: 'Godox flash', limit: 10, spreadHops: 1, spreadMinWeight: 1 })
    const onSpread = on.filter((h) => sources(h).includes('spread'))

    assert.ok(onSpread.length >= 1, `应产生扩散候选，实际 ${onSpread.length}`)
    const spreadIds = onSpread.map((h) => h.id)
    const added = spreadIds.filter((id) => !offIds.includes(id))
    assert.ok(
      added.length >= 1,
      `扩散必须带来关闭时没有的候选。关闭=${JSON.stringify(offIds)} 扩散=${JSON.stringify(spreadIds)}`,
    )
    // 新增的那条应当是含 Gitzo 的 turn
    const gitzoTurn = on.find((h) => h.id === added[0])
    assert.ok(gitzoTurn !== undefined && /Gitzo/i.test(gitzoTurn.text), '扩散应召回含 Gitzo 的 turn')
  } finally {
    t.cleanup(m)
  }
})

test('S3 只扩一跳，不越两跳', () => {
  const t = makeTmp('prts-mem-spread-hops-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    // 链条：godox — gitzo — manfrotto — really right stuff。
    // 种子是 {godox, gitzo}，1 跳邻居是 {manfrotto}；really right stuff 属两跳，
    // 只出现在第三条 turn 里，不能被抓回来。
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'The user pairs a Godox V1 flash with a Gitzo tripod.',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user',
      text: 'The Gitzo tripod holds a Manfrotto head.',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's2', turnIndex: 0, speaker: 'user',
      text: 'The Manfrotto head carries a Really Right Stuff plate.',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's2', turnIndex: 1, speaker: 'user',
      text: 'The Really Right Stuff plate is expensive.',
    })
    m.consolidateRules({ maxTurns: 100 })

    const hits = m.search({ text: 'Godox V1 flash', limit: 10, spreadHops: 1, spreadMinWeight: 1 })
    // 两跳之外的判定：只含 Really Right Stuff、不含 Manfrotto 的那条
    const twoHopOnly = hits.filter((h) => /Really Right Stuff/i.test(h.text) && !/Manfrotto/i.test(h.text))
    assert.equal(
      twoHopOnly.length, 0,
      `两跳之外（只含 really right stuff 的 turn）不该被扩散到，实际 ${JSON.stringify(twoHopOnly.map((h) => h.text))}`,
    )
  } finally {
    t.cleanup(m)
  }
})

test('S4 无图时不报错：库里没有任何实体/边，扩散路安静退化为空', () => {
  const t = makeTmp('prts-mem-spread-empty-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'The user likes Godox flashes.',
    })
    // 故意不跑巩固：图是空的
    const hits = m.search({ text: 'Godox', limit: 5, spreadHops: 1 })
    assert.ok(Array.isArray(hits), '无图时不能抛错')
    assert.equal(hits.filter((h) => sources(h).includes('spread')).length, 0, '无图时没有扩散候选')
  } finally {
    t.cleanup(m)
  }
})

test('S5 边权重下限生效：共现一次（weight=1）的邻居默认不扩散', () => {
  const t = makeTmp('prts-mem-spread-weight-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m) // 三个实体在同一 turn 共现一次 → 边权都是 1

    const loose = m.search({ text: 'Godox flash', limit: 10, spreadHops: 1, spreadMinWeight: 1 })
    const strict = m.search({ text: 'Godox flash', limit: 10, spreadHops: 1 }) // 默认权重 2
    assert.ok(
      loose.filter((h) => sources(h).includes('spread')).length
      >= strict.filter((h) => sources(h).includes('spread')).length,
      '降低权重门槛不应减少扩散候选',
    )
    assert.equal(
      strict.filter((h) => sources(h).includes('spread')).length, 0,
      '共现仅一次时默认门槛（2）应把邻居全部挡住',
    )
  } finally {
    t.cleanup(m)
  }
})

test('S6 扩散候选不走 fact/profile 路，只召回 turn', () => {
  const t = makeTmp('prts-mem-spread-kind-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(m)
    const hits = m.search({ text: 'Godox flash', limit: 10, spreadHops: 1, spreadMinWeight: 1 })
    for (const h of hits.filter((x) => sources(x).includes('spread'))) {
      assert.equal(h.kind, 'turn', `扩散只应产出 turn，实际 ${h.kind}`)
    }
  } finally {
    t.cleanup(m)
  }
})
