/**
 * §G2 ① 时钟 · 应答闸门（DESIGN-09）—— 默认值与配置面。
 *
 * `wake-clock.test.ts` 的 W13—W17 钉住闸门的**语义**（什么时候挡、博士一开口
 * 就恢复、intent 豁免、没到期项不累积）。这里补那边够不到（或只测了坏的一半）
 * 的三处：
 *
 *  1. **默认值**：不显式传 `silentLimit` 时必须是 `DEFAULT_SILENT_LIMIT`（2）。
 *     默认值错了，生产上闸门等于没接——而单测全都显式传了 2，谁也不会红。
 *  2. **配置解析**：`PRTS_CLOCK_SILENT_LIMIT` 的空值 / 非法值 / `0` 的边界。
 *     `0` 是「关掉」，不是「没填」；复用 `envNum`（要求 `> 0`）会把它静默
 *     回落到 2，主人以为关了闸门，其实没关。
 *  3. **不提供 `lastOwnerTurnAtMs` 时闸门不工作**：无法判断有没有被接住，
 *     就不该猜——猜错的方向是「她莫名其妙不说话了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  attachWakeClock,
  DEFAULT_SILENT_LIMIT,
  parseSilentLimit,
  type WakeReason,
} from '../../src/runtime/wake-clock.ts'

interface Rig {
  clock: ReturnType<typeof attachWakeClock>
  delivered: WakeReason[]
  setDue(items: WakeReason[]): void
  setNow(ms: number): void
}

function rig(overrides: Partial<Parameters<typeof attachWakeClock>[0]> = {}): Rig {
  const delivered: WakeReason[] = []
  let due: WakeReason[] = []
  let now = 1_000_000
  const clock = attachWakeClock({
    collectDue: () => due,
    deliver: async (r) => { delivered.push(r) },
    onFired: () => { /* 这里只关心投递 */ },
    now: () => now,
    log: () => { /* 静音 */ },
    minGapMs: 0,
    dailyCap: 10,
    ...overrides,
  })
  return {
    clock,
    delivered,
    setDue: (items) => { due = items },
    setNow: (ms) => { now = ms },
  }
}

const stale = (): WakeReason => ({ kind: 'stale-task', text: '任务卡住了', refId: 't1' })

test('S1 默认阈值是 DEFAULT_SILENT_LIMIT（2）：不传 silentLimit 也挡得住', async () => {
  assert.equal(DEFAULT_SILENT_LIMIT, 2)

  const r = rig({ lastOwnerTurnAtMs: () => undefined })
  r.setDue([stale()])
  await r.clock.tick() // 第一次开口：上次投递为 null，闸门不判断
  r.setNow(1_010_000)
  await r.clock.tick() // streak=1，仍允许
  r.setNow(1_020_000)
  const third = await r.clock.tick()
  assert.equal(r.delivered.length, 2, '默认值下连续两次无人回应就该闭嘴')
  assert.deepEqual(third, [])
  assert.equal(r.clock.stats().unanswered, 2)
})

test('S2 unanswered 从 0 开始，且只在 tick 判断时变化', async () => {
  const r = rig()
  assert.equal(r.clock.stats().unanswered, 0, '还没开口过，streak 必须是 0')
})

test('S3 不提供 lastOwnerTurnAtMs → 闸门不工作（判断不了就不猜）', async () => {
  const r = rig() // 没有 lastOwnerTurnAtMs
  r.setDue([stale()])
  for (let i = 0; i < 5; i++) {
    r.setNow(1_000_000 + i * 10_000)
    await r.clock.tick()
  }
  assert.equal(r.delivered.length, 5, '没有反馈数据源时不得凭空挡掉提醒')
  assert.equal(r.clock.stats().unanswered, 0, '也不行凭空累积 streak')
})

test('S4 投递成功不清零 streak：连续无人回应时单调增长到阈值', async () => {
  const r = rig({ silentLimit: 3, lastOwnerTurnAtMs: () => undefined })
  r.setDue([{ kind: 'fact', text: '惦记着的事', refId: 'f1' }])

  await r.clock.tick() // lastFiredAtMs=null → 不判断
  assert.equal(r.clock.stats().unanswered, 0)

  r.setNow(1_010_000)
  await r.clock.tick() // 判断：1 > 0，但 1 < 3 → 照投
  assert.equal(r.delivered.length, 2)
  assert.equal(r.clock.stats().unanswered, 1, '投递成功本身不是「被接住」，不得清零')

  r.setNow(1_020_000)
  await r.clock.tick() // 2 < 3 → 照投
  assert.equal(r.delivered.length, 3)
  assert.equal(r.clock.stats().unanswered, 2)

  r.setNow(1_030_000)
  const fourth = await r.clock.tick() // 3 >= 3 → 挡
  assert.deepEqual(fourth, [])
  assert.equal(r.delivered.length, 3)
  assert.equal(r.clock.stats().unanswered, 3)
})

test('S5 silentLimit=0 连 streak 都不判断（关闸门的另一半：不累积）', async () => {
  const r = rig({ silentLimit: 0, lastOwnerTurnAtMs: () => undefined })
  r.setDue([stale()])
  for (let i = 0; i < 3; i++) {
    r.setNow(1_000_000 + i * 10_000)
    await r.clock.tick()
  }
  assert.equal(r.delivered.length, 3)
  assert.equal(r.clock.stats().unanswered, 0, '关掉闸门后不该还在后台数 streak')
})

test('S6 parseSilentLimit：0 是「关掉」，空值/非法值才回落默认', async () => {
  // 回落默认：没填、空白、非数字、负号、小数、无穷
  for (const raw of [undefined, '', '   ', 'abc', 'NaN', '-1', '2.5', 'Infinity']) {
    assert.equal(parseSilentLimit(raw), DEFAULT_SILENT_LIMIT, `raw=${JSON.stringify(raw)} 应回落 2`)
  }
  // 显式取值：0 必须保住 0（envNum 会把它吃掉）
  assert.equal(parseSilentLimit('0'), 0)
  assert.equal(parseSilentLimit('1'), 1)
  assert.equal(parseSilentLimit('5'), 5)
  assert.equal(parseSilentLimit(' 3 '), 3, '环境变量两侧空白不该让配置失效')
  assert.equal(parseSilentLimit('007'), 7)
})
