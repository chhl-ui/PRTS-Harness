/**
 * Wave 5：生命周期（重要性衰减 / 退役 / 恢复）。
 *
 * 判定依据是折算后的有效重要性，而衰减是纯函数——因此这里大量用「把 nowMs 推到
 * 未来」来构造老年事实，而不是改库里的 `recorded_at_ms`：后者会让投影与事件链
 * 不一致，测出来的结论不可复现（`rebuildProjections` 会把时间改回去）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, decayedImportance, shouldRetire,
  IMPORTANCE_HALF_LIFE_DAYS,
} from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const DAY = 86_400_000

test('L1 衰减是纯函数：半衰期整数倍后恰好减半，未来时间不放大', () => {
  const t0 = 1_700_000_000_000
  assert.equal(decayedImportance(0.5, t0, t0), 0.5)
  assert.ok(Math.abs(decayedImportance(0.5, t0, t0 + 180 * DAY) - 0.25) < 1e-12)
  assert.ok(Math.abs(decayedImportance(0.5, t0, t0 + 2 * 180 * DAY) - 0.125) < 1e-12)
  // 时钟回拨（写入时间在未来）不得放大权重——否则一次时间错乱会造出超强记忆
  assert.equal(decayedImportance(0.5, t0 + 10 * DAY, t0), 0.5)
  // 非法输入按 0 处理，不当作「很重要」
  assert.equal(decayedImportance(Number.NaN, t0, t0 + 365 * DAY), 0)
  assert.equal(IMPORTANCE_HALF_LIFE_DAYS, 180)
})

test('L2 年龄门槛独立于阈值：刚写入的低重要度事实不退役', () => {
  const t = makeTmp('prts-mem-life-age-')
  const m = MemoryStore.open(t.db())
  try {
    // 显式给一个低于阈值的 importance，若只看阈值会立刻误杀
    m.assertFact({
      actor: 'model', subject: '博士', predicate: '也许喜欢', object: '光学涂层',
      provenance: 'inferred', confirmationBasis: 'model-inferred', importance: 0.01,
    })
    const r = m.retireFacts({ nowMs: Date.now() + 10 * DAY })
    assert.equal(r.retired.length, 0, '10 天远不足最短保留期 90 天')
    assert.equal(m.search({ text: '光学' }).length, 1)
  } finally {
    t.cleanup(m)
  }
})

test('L3 淡忘后退役：检索不再返回，投影置位，链完整', () => {
  const t = makeTmp('prts-mem-life-retire-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    const r = m.retireFacts({ actor: 'system', nowMs: later })
    assert.deepEqual(r.retired, [id])
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 0, '退役项默认不进检索')

    const raw = new DatabaseSync(dbPath)
    try {
      const row = raw.prepare('SELECT retired_at_ms, importance FROM mem_facts WHERE fact_id = ?')
        .get(id) as { retired_at_ms: number | null; importance: number }
      assert.equal(row.retired_at_ms, later, '退役时间必须落在事件时间上，不是当前墙钟')
      assert.equal(row.importance, 0.5, 'importance 是写入时强度，衰减不写回')
      const ev = raw.prepare("SELECT count(*) c FROM memory_events WHERE kind = 'fact.retired'")
        .get() as { c: number }
      assert.equal(ev.c, 1)
    } finally {
      raw.close()
    }
    assert.equal(m.verifyChain().ok, true)
  } finally {
    t.cleanup(m)
  }
})

test('L4 permanent 永不退役，benchmark 不被生产作业改写', () => {
  const t = makeTmp('prts-mem-life-skip-')
  const m = MemoryStore.open(t.db())
  try {
    const permanentId = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '是', object: 'PRTS 的所有者',
      provenance: 'stated', confirmationBasis: 'owner-stated', retentionClass: 'permanent',
    })
    const benchId = m.assertFact({
      actor: 'system', subject: '基准', predicate: '含', object: '光学仪器校准',
      provenance: 'stated', confirmationBasis: 'owner-stated', origin: 'benchmark',
    })
    const r = m.retireFacts({ nowMs: Date.now() + 900 * DAY })
    assert.equal(r.retired.length, 0)
    assert.notEqual(permanentId, benchId)
    assert.equal(m.search({ text: 'PRTS', nowMs: Date.now() + 900 * DAY }).length, 1)
    assert.equal(m.search({ text: '光学', nowMs: Date.now() + 900 * DAY }).length, 0,
      'benchmark 默认不进检索（origin 过滤），与退役无关')
  } finally {
    t.cleanup(m)
  }
})

test('L5 退役幂等：连跑两次只追加一条事件', () => {
  const t = makeTmp('prts-mem-life-idem-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    assert.equal(m.retireFacts({ nowMs: later }).retired.length, 1)
    const second = m.retireFacts({ nowMs: later + DAY })
    assert.equal(second.retired.length, 0, '已退役的行不在候选里')
    assert.equal(second.scanned, 0)

    const raw = new DatabaseSync(dbPath)
    try {
      const ev = raw.prepare("SELECT count(*) c FROM memory_events WHERE kind = 'fact.retired'")
        .get() as { c: number }
      assert.equal(ev.c, 1)
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})

test('L6 dryRun 只算不写：候选可见但检索行为不变', () => {
  const t = makeTmp('prts-mem-life-dry-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    const r = m.retireFacts({ nowMs: later, dryRun: true })
    assert.equal(r.retired.length, 0)
    assert.deepEqual(r.candidates.map((c) => c.factId), [id])
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 1, 'dryRun 不得改变检索可见性')

    const raw = new DatabaseSync(dbPath)
    try {
      const ev = raw.prepare("SELECT count(*) c FROM memory_events WHERE kind = 'fact.retired'")
        .get() as { c: number }
      assert.equal(ev.c, 0)
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})

test('L7 恢复可逆：退役 → 恢复 → 检索回来；重复恢复返回 0', () => {
  const t = makeTmp('prts-mem-life-restore-')
  const m = MemoryStore.open(t.db())
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    m.retireFacts({ nowMs: later })
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 0)

    assert.equal(m.restoreFacts({ actor: 'owner', factIds: [id], reason: 'test' }), 1)
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 1, '恢复后立即可检索（索引未动）')
    assert.equal(m.restoreFacts({ actor: 'owner', factIds: [id] }), 0, '未退役的行不计入')
    // 不存在的 id 也不计入
    assert.equal(m.restoreFacts({ actor: 'owner', factIds: ['fact-nope'] }), 0)
    assert.equal(m.verifyChain().ok, true)
  } finally {
    t.cleanup(m)
  }
})

test('L8 重建一致：退役状态由事件重放得出，不是投影上的偶然值', () => {
  const t = makeTmp('prts-mem-life-rebuild-')
  const m = MemoryStore.open(t.db())
  try {
    const id = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    m.retireFacts({ nowMs: later })
    m.rebuildProjections()
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 0)
    // 重建用的是事件里的 recorded_at_ms，必须是退役时刻而不是「重建这天的墙钟」
    const r = m.lifecycleStats(later)
    assert.equal(r.retired, 1)
    assert.equal(r.live, 0)
  } finally {
    t.cleanup(m)
  }
})

test('L9 lifecycleStats 暴露分桶与最近候选', () => {
  const t = makeTmp('prts-mem-life-stats-')
  const m = MemoryStore.open(t.db())
  try {
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '是', object: 'PRTS 的所有者',
      provenance: 'stated', confirmationBasis: 'owner-stated', retentionClass: 'permanent',
    })
    m.assertFact({
      actor: 'owner', subject: '博士', predicate: '曾提到', object: '一次性光学实验',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    const before = m.lifecycleStats(later)
    assert.equal(before.live, 2)
    assert.equal(before.permanentLive, 1)
    assert.equal(before.retired, 0)
    assert.ok(before.nearestCandidate !== null)
    assert.ok(before.nearestCandidate.effective < 0.5, '老年事实的有效重要性应已衰减')

    m.retireFacts({ nowMs: later })
    const after = m.lifecycleStats(later)
    assert.equal(after.live, 1, '只剩 permanent')
    assert.equal(after.retired, 1)
    assert.equal(after.nearestCandidate, null, 'permanent 永不是退役候选，候选表应为空')
  } finally {
    t.cleanup(m)
  }
})

test('L10 shouldRetire 的判定：阈值按折算值比较，permanent 恒不退役', () => {
  const now = 1_700_000_000_000
  const recorded = now - 365 * DAY
  // 写入时 0.05 的事实，一年后只剩 0.0123 —— 低于阈值，进候选
  const decayed = shouldRetire(
    { factId: 'f1', importance: 0.05, recordedAtMs: recorded, retentionClass: 'clearable' },
    now,
    { minAgeDays: 0, halfLifeDays: 180 },
  )
  assert.ok(decayed !== null)
  assert.ok(Math.abs(decayed.effective - 0.05 * Math.pow(2, -365 / 180)) < 1e-12)
  const below = shouldRetire(
    { factId: 'f2', importance: 0.01, recordedAtMs: recorded, retentionClass: 'clearable' },
    now,
    { minAgeDays: 0 },
  )
  assert.ok(below !== null)
  assert.ok(below.effective < decayed.effective)
  assert.equal(
    shouldRetire({ factId: 'f3', importance: 0.0001, recordedAtMs: recorded, retentionClass: 'permanent' }, now),
    null,
  )
  // 年龄门槛与阈值是两个独立条件：再低的权重，写入不足 minAgeDays 也不进候选
  assert.equal(
    shouldRetire({ factId: 'f4', importance: 0.0001, recordedAtMs: now - DAY, retentionClass: 'clearable' }, now),
    null,
  )
})

test('L11 重新陈述已淡忘的事实 → 重新记住（退役行不算去重命中）', () => {
  const t = makeTmp('prts-mem-life-relearn-')
  const dbPath = t.db()
  const m = MemoryStore.open(dbPath)
  try {
    const first = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const later = Date.now() + 700 * DAY
    m.retireFacts({ nowMs: later })
    assert.equal(m.search({ text: '光学', nowMs: later }).length, 0)

    const again = m.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    assert.notEqual(again, first, '必须是一条新事实：旧行带旧的写入时间与强度')
    const hits = m.search({ text: '光学', nowMs: later })
    assert.equal(hits.length, 1, '重新陈述后应重新可见')
    assert.equal(hits[0]?.id, again)

    const raw = new DatabaseSync(dbPath)
    try {
      // 旧行仍在，保持退役历史——不是覆盖，是新增
      const old = raw.prepare('SELECT retired_at_ms FROM mem_facts WHERE fact_id = ?')
        .get(first) as { retired_at_ms: number | null }
      assert.equal(old.retired_at_ms, later)
      const total = raw.prepare('SELECT count(*) c FROM mem_facts').get() as { c: number }
      assert.equal(total.c, 2)
    } finally {
      raw.close()
    }
    assert.equal(m.verifyChain().ok, true)
  } finally {
    t.cleanup(m)
  }
})
