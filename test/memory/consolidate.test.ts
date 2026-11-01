/**
 * 巩固管线（Wave 2，规则部分）。
 *
 * 三条硬不变量的测试逐条对应，不合并成一个大用例——合并后失败只能看到「巩固有 bug」，
 * 分不清是幂等破了还是游标越界。
 *
 * 全部离线：本层不调模型，测试也不该有任何网络依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, extractEntities } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

/** 造 n 条带专名的 turn。正文故意互不相同，避免被误判成重复。 */
const seedTurns = (m: MemoryStore, n: number, tag = 'Sony A7R IV'): void => {
  for (let i = 0; i < n; i++) {
    m.recordTurn({
      actor: 'system', sessionId: `s-${i % 3}`, turnIndex: i,
      speaker: 'user',
      text: `Turn ${i}: the user compares ${tag} against a Nikon Z6 body and asks about Godox V1 flash number${i}.`,
    })
  }
}

test('C1 实体抽取：专名/引号/数量/缩写，且句首普通词不进图', () => {
  const got = extractEntities(
    'The user enjoys using Adobe Premiere Pro and prefers the Lumetri Color Panel. '
    + 'She reads "Nature Medicine" weekly and rates ISO at 5:30 pm with a 16GB card.',
  )
  const keys = got.map((e) => e.key)
  assert.ok(keys.includes('adobe premiere pro'), `应抽到专名，实际 ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('lumetri color panel'), `应抽到专名，实际 ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('nature medicine'), `应抽到引号短语，实际 ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('iso'), `应抽到缩写，实际 ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('16gb'), `应抽到数量+单位，实际 ${JSON.stringify(keys)}`)
  // 句首 "The" / "She" 是普通词，不能因为大写就进图
  assert.ok(!keys.includes('the'), ' 句首冠词不该进图')
  assert.ok(!keys.includes('she'), '句首代词不该进图')
})

test('C2 罗马数字不当缩写收——型号里的 IV 不是独立实体', () => {
  const keys = extractEntities('The user shoots with a Sony A7R IV and a Godox V1 flash.').map((e) => e.key)
  assert.ok(!keys.includes('iv'), `IV 不该作为缩写进图，实际 ${JSON.stringify(keys)}`)
  assert.ok(keys.includes('sony a7r iv'), '但整个型号序列要保留')
})

test('C3 基本巩固：实体/边/主题有产出，游标推进到末尾', () => {
  const t = makeTmp('prts-mem-consolidate-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 5)
    const r = m.consolidateRules({ maxTurns: 1000 })
    assert.equal(r.turns, 5, '应处理 5 条 turn')
    assert.equal(r.stopped, 'done', '没有更多 turn 时应报 done')

    const st = m.consolidationStats()
    assert.ok(st.entities > 0, `应产出实体，实际 ${st.entities}`)
    assert.ok(st.links > 0, `应产出共现边，实际 ${st.links}`)
    assert.ok(st.topics > 0, `应产出主题计数，实际 ${st.topics}`)
    assert.equal(st.cursor, st.maxRowid, '处理完全部后游标应等于最大 rowid')
  } finally {
    t.cleanup(m)
  }
})

test('C4 幂等：重复跑不改变任何计数（第二次没有可处理的 turn）', () => {
  const t = makeTmp('prts-mem-consolidate-idem-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 6)
    m.consolidateRules()
    const first = m.consolidationStats()

    const again = m.consolidateRules()
    assert.equal(again.turns, 0, '第二次没有新 turn 可处理')
    const second = m.consolidationStats()
    assert.deepEqual(
      { e: second.entities, l: second.links, t: second.topics, c: second.cursor },
      { e: first.entities, l: first.links, t: first.topics, c: first.cursor },
      '重复巩固不能让计数漂移',
    )
  } finally {
    t.cleanup(m)
  }
})

test('C5 分两批跑的结果 == 一次跑完的结果（游标衔接不丢不重）', () => {
  const once = makeTmp('prts-mem-consolidate-once-')
  const twice = makeTmp('prts-mem-consolidate-twice-')
  const m1 = MemoryStore.open(once.db('memory.sqlite'))
  const m2 = MemoryStore.open(twice.db('memory.sqlite'))
  try {
    seedTurns(m1, 25)
    seedTurns(m2, 25)

    const single = m1.consolidateRules({ batchTurns: 100, maxTurns: 1000 })
    assert.equal(single.turns, 25)

    // 每次只给 10 条预算，迫使分三批
    let budgetRuns = 0
    for (;;) {
      const r = m2.consolidateRules({ batchTurns: 7, maxTurns: 10 })
      budgetRuns++
      if (r.stopped !== 'budget') break
      assert.ok(budgetRuns < 20, '不应无限循环')
    }

    const s1 = m1.consolidationStats()
    const s2 = m2.consolidationStats()
    assert.deepEqual(
      { e: s2.entities, l: s2.links, t: s2.topics },
      { e: s1.entities, l: s1.links, t: s1.topics },
      `分批巩固必须与一次跑完等价：单批=${JSON.stringify(s1)} 分批=${JSON.stringify(s2)}`,
    )
    assert.equal(s2.cursor, s2.maxRowid, '分批跑完游标也要到末尾')
  } finally {
    once.cleanup(m1)
    twice.cleanup(m2)
  }
})

test('C6 取消不写半成品：中断后游标与已写数据严格对应', () => {
  const t = makeTmp('prts-mem-consolidate-cancel-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 250)
    // 第一次检查放行（跑一批），第二次检查返回 true（在第二批开始前取消）
    let checks = 0
    const signal = { get aborted(): boolean { checks++; return checks > 1 } } as unknown as AbortSignal

    const r = m.consolidateRules({ batchTurns: 100, maxTurns: 1000, signal })
    assert.equal(r.stopped, 'cancelled', '应报 cancelled')
    assert.equal(r.turns, 100, `只应完成一整批，实际 ${r.turns}`)

    const mid = m.consolidationStats()
    assert.equal(mid.cursor, 100, '游标必须停在整批边界')

    // 关键断言：游标之后的内容一条都没写进去
    const raw = new DatabaseSync(t.db('memory.sqlite'), { readOnly: true })
    const written = (raw.prepare(
      `SELECT COUNT(*) AS c FROM mem_entities e
        WHERE NOT EXISTS (SELECT 1 FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
                           WHERE t.rowid > ? AND b.body LIKE '%' || e.name || '%')`,
    ).get(mid.cursor) as { c: number }).c
    raw.close()
    assert.equal(written, 0, `取消后不应存在只由未处理 turn 引入的实体，实际 ${written} 条`)

    // 恢复后接着跑，总量必须与一次跑完一致
    const rest = m.consolidateRules({ batchTurns: 100, maxTurns: 1000 })
    assert.equal(rest.turns, 150, '剩余 150 条')
    assert.equal(m.consolidationStats().cursor, 250, '恢复后游标到末尾')
  } finally {
    t.cleanup(m)
  }
})

test('C7 水位线不越界：游标永远不超过 mem_turns 的最大 rowid', () => {
  const t = makeTmp('prts-mem-consolidate-cursor-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 12)
    m.consolidateRules({ batchTurns: 5, maxTurns: 5 })
    const afterFirst = m.consolidationStats()
    assert.ok(afterFirst.cursor <= afterFirst.maxRowid, `游标 ${afterFirst.cursor} 越过了 maxRowid ${afterFirst.maxRowid}`)

    // 预算耗尽时游标应停在第 5 条，而不是跳到末尾
    assert.equal(afterFirst.cursor, 5, 'batchTurns=5 时游标应正好停在第 5 行')
    assert.ok(afterFirst.cursor < afterFirst.maxRowid, '此时还有剩余未处理')
  } finally {
    t.cleanup(m)
  }
})

test('C8 共现边无向且只存一份：A–B 不会变成两条边', () => {
  const t = makeTmp('prts-mem-consolidate-undirected-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    // 同一对实体在正反顺序里各出现一次
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: 'The user pairs Adobe Premiere Pro with a Sony A7R IV body.',
    })
    m.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user',
      text: 'The user pairs Sony A7R IV with Adobe Premiere Pro again.',
    })
    m.consolidateRules()

    const raw = new DatabaseSync(t.db('memory.sqlite'), { readOnly: true })
    const rows = raw.prepare(
      `SELECT from_key, to_key, weight FROM mem_links
        WHERE kind = 'cooccur'
          AND (from_key LIKE '%adobe premiere pro%' OR to_key LIKE '%adobe premiere pro%')`,
    ).all() as Array<{ from_key: string; to_key: string; weight: number }>
    raw.close()

    const pair = rows.filter((r) => r.from_key.includes('adobe') !== r.to_key.includes('adobe'))
    assert.equal(pair.length, 1, `同一对实体只应有一条边，实际 ${JSON.stringify(rows)}`)
    assert.equal(pair[0].weight, 2, '两次共现应累加权重')
    assert.ok(pair[0].from_key < pair[0].to_key, '方向必须规范化')
  } finally {
    t.cleanup(m)
  }
})

test('C9 删除的 turn 被跳过，不影响游标推进', () => {
  const t = makeTmp('prts-mem-consolidate-deleted-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 5)
    const raw = new DatabaseSync(t.db('memory.sqlite'))
    // 直接置删除标记，模拟已删除的 turn（正文被清空）
    raw.exec(`UPDATE mem_turns SET deleted_at_ms = ${Date.now()}, body_ref = NULL WHERE rowid IN (2, 3)`)
    raw.close()

    const r = m.consolidateRules({ batchTurns: 100, maxTurns: 1000 })
    assert.equal(r.turns, 3, `被删除的 turn 应跳过，实际处理 ${r.turns}`)
    assert.equal(r.stopped, 'done')
    assert.equal(m.consolidationStats().cursor, 5, '游标仍应推进到末尾')
  } finally {
    t.cleanup(m)
  }
})

test('C10 旧库自愈：缺少巩固三张表的库打开后表自动补上且可用', () => {
  const t = makeTmp('prts-mem-consolidate-migrate-')
  const path = t.db('memory.sqlite')
  const first = MemoryStore.open(path)
  first.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'Sony A7R IV body.' })
  first.close()

  // 抹掉三张新表，模拟这次改动之前的旧库
  const raw = new DatabaseSync(path)
  raw.exec('DROP TABLE IF EXISTS mem_links; DROP TABLE IF EXISTS mem_entities; DROP TABLE IF EXISTS mem_consolidation')
  raw.close()

  const m = MemoryStore.open(path)
  try {
    const r = m.consolidateRules()
    assert.equal(r.turns, 1, '旧库升级后应能正常巩固')
    assert.ok(m.consolidationStats().entities > 0, '实体表应可用')
  } finally {
    t.cleanup(m)
  }
})

test('C11 重建投影不清空巩固产物（它们是链外派生项）', () => {
  const t = makeTmp('prts-mem-consolidate-rebuild-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seedTurns(m, 4)
    m.consolidateRules()
    const before = m.consolidationStats()

    m.rebuildProjections()

    const after = m.consolidationStats()
    assert.equal(after.entities, before.entities, '实体不该被重放清空')
    assert.equal(after.links, before.links, '边不该被重放清空')
    assert.equal(after.topics, before.topics, '主题不该被重放清空——否则游标不重置，永久丢失')
    assert.equal(after.cursor, before.cursor, '游标不该被重放重置')
  } finally {
    t.cleanup(m)
  }
})
