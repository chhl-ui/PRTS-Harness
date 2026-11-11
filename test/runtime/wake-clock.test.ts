/**
 * §G2 ① 时钟（自主唤醒）—— 组件单元测试。
 *
 * 方案 B（离屏自主）：时钟不依赖任何活跃会话，自己起一个离屏会话把话说出来。
 * 因此这里测的是**调度策略**，不是投递实现：`deliver` 被注入成 fake，
 * 断言「什么时候投递、什么时候不投递、失败怎么收敛」。
 *
 * 真实投递（agents.create → followup → whenIdle → dispose）由
 * `test/runtime/wake-clock-live.test.ts` 覆盖——两层的假度不同，不能互相替代。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachWakeClock, type WakeReason } from '../../src/runtime/wake-clock.ts'

const reason = (id = 'r1'): WakeReason => ({ kind: 'intent', text: '该吃药了', refId: id })

interface Rig {
  clock: ReturnType<typeof attachWakeClock>
  delivered: WakeReason[]
  fired: WakeReason[]
  failures: unknown[]
  stopped: string[]
  setDue(items: WakeReason[]): void
  setNow(ms: number): void
  /** 让 deliver 抛错的次数（-1 = 永久抛错） */
  failTimes(n: number): void
}

function rig(overrides: Partial<Parameters<typeof attachWakeClock>[0]> = {}): Rig {
  const delivered: WakeReason[] = []
  const fired: WakeReason[] = []
  const failures: unknown[] = []
  const stopped: string[] = []
  let due: WakeReason[] = []
  let now = 1_000_000
  let failRemaining = 0

  const clock = attachWakeClock({
    collectDue: () => due,
    deliver: async (r) => {
      if (failRemaining === -1 || failRemaining > 0) {
        if (failRemaining > 0) failRemaining -= 1
        throw new Error('deliver boom')
      }
      delivered.push(r)
    },
    onFired: (r) => { fired.push(r) },
    onFailure: (e) => { failures.push(e) },
    onStopped: (why) => { stopped.push(why) },
    now: () => now,
    log: () => { /* 测试里静音 */ },
    ...overrides,
  })

  return {
    clock,
    delivered,
    fired,
    failures,
    stopped,
    setDue: (items) => { due = items },
    setNow: (ms) => { now = ms },
    failTimes: (n) => { failRemaining = n },
  }
}

test('W1 到期且有投递能力 → 投递一次并留痕', async () => {
  const r = rig()
  r.setDue([reason('a')])
  const got = await r.clock.tick()
  assert.equal(got.length, 1)
  assert.deepEqual(r.delivered.map((x) => x.refId), ['a'])
  assert.deepEqual(r.fired.map((x) => x.refId), ['a'])
  assert.equal(r.clock.stats().fired, 1)
})

test('W2 没有到期项 → 不投递、不失败', async () => {
  const r = rig()
  const got = await r.clock.tick()
  assert.deepEqual(got, [])
  assert.equal(r.delivered.length, 0)
  assert.equal(r.failures.length, 0)
})

test('W3 minGap 内第二次不投递（防打扰）', async () => {
  const r = rig({ minGapMs: 60_000 })
  r.setDue([reason('a')])
  await r.clock.tick()
  r.setNow(1_000_000 + 30_000)      // 只过了 30s
  const second = await r.clock.tick()
  assert.deepEqual(second, [])
  assert.equal(r.delivered.length, 1)
  assert.equal(r.clock.stats().skipped, 1)
})

test('W4 过了 minGap 可以再投递，但 dailyCap 到顶后停', async () => {
  const r = rig({ minGapMs: 1_000, dailyCap: 2 })
  r.setDue([reason('a')])
  await r.clock.tick()
  r.setNow(1_000_000 + 2_000)
  await r.clock.tick()
  assert.equal(r.delivered.length, 2)
  r.setNow(1_000_000 + 4_000)
  const third = await r.clock.tick()
  assert.deepEqual(third, [])
  assert.equal(r.delivered.length, 2, 'dailyCap 到顶后不得再投递')
})

test('W5 投递连续失败 maxFailures 次 → 自停且不再调用 deliver', async () => {
  const r = rig({ maxFailures: 3, minGapMs: 0 })
  r.setDue([reason('a')])
  r.failTimes(-1)
  for (let i = 0; i < 3; i++) {
    r.setNow(1_000_000 + i * 1_000)
    await r.clock.tick()
  }
  assert.equal(r.failures.length, 3)
  assert.equal(r.stopped.length, 1, '自停必须留一次痕')
  assert.equal(r.clock.stats().stopped, true)

  // 停了之后即使有到期也不得再投递——不能靠 deliver 自己失败来「表现正常」
  r.setDue([reason('b')])
  r.setNow(1_000_000 + 10_000)
  const after = await r.clock.tick()
  assert.deepEqual(after, [])
  assert.equal(r.failures.length, 3, '自停后不应再产生失败')
})

test('W6 失败一次后成功 → 失败计数归零，不误停', async () => {
  const r = rig({ maxFailures: 2, minGapMs: 0 })
  r.setDue([reason('a')])
  r.failTimes(1)
  await r.clock.tick()
  assert.equal(r.failures.length, 1)
  r.setNow(1_000_000 + 1_000)
  await r.clock.tick()
  assert.equal(r.delivered.length, 1)
  assert.equal(r.clock.stats().failures, 0, '成功后失败计数必须归零')

  // 再失败一次不应触发自停（阈值 2，但已归零）
  r.failTimes(1)
  r.setNow(1_000_000 + 2_000)
  await r.clock.tick()
  assert.equal(r.clock.stats().stopped, false)
})

test('W7 stop() 之后 tick 是空操作', async () => {
  const r = rig()
  r.setDue([reason('a')])
  r.clock.stop()
  const got = await r.clock.tick()
  assert.deepEqual(got, [])
  assert.equal(r.delivered.length, 0)
})

test('W8 一次 tick 只投递一条（多条到期不合并成一堵墙）', async () => {
  const r = rig()
  r.setDue([reason('a'), reason('b'), reason('c')])
  const got = await r.clock.tick()
  assert.equal(got.length, 1)
  assert.equal(r.delivered.length, 1)
})

test('W9 collectDue 抛错不进 deliver、计入失败（不能把库故障当成「没有到期」）', async () => {
  const r = rig({
    collectDue: () => { throw new Error('db boom') },
  })
  const got = await r.clock.tick()
  assert.deepEqual(got, [])
  assert.equal(r.delivered.length, 0)
  assert.equal(r.failures.length, 1)
})

test('W10 说话闸门（minGap/dailyCap）不挡 onTick：情绪不是说话', async () => {
  const ticks: number[] = []
  const r = rig({
    minGapMs: 60_000, dailyCap: 1,
    onTick: (at) => { ticks.push(at) },
  })
  r.setDue([reason('a')])
  await r.clock.tick() // 投递一条，dailyCap 用满
  r.setNow(1_000_000 + 1_000) // minGap 内 + cap 已满，双重闸门
  const second = await r.clock.tick()
  assert.deepEqual(second, [])
  assert.equal(r.delivered.length, 1)
  assert.deepEqual(ticks, [1_000_000, 1_001_000], '两次 tick 都必须跑系统侧检查')
})

test('W11 onTick 抛错只 log：不计投递失败、不触自停、不挡投递', async () => {
  const r = rig({
    maxFailures: 1,
    onTick: () => { throw new Error('emotion boom') },
  })
  r.setDue([reason('a')])
  const got = await r.clock.tick()
  assert.equal(got.length, 1, '检查失败不能挡住说话')
  assert.equal(r.failures.length, 0)
  assert.equal(r.clock.stats().failures, 0)
  assert.equal(r.clock.stats().stopped, false)
  assert.equal(r.stopped.length, 0)
})

test('W12 守卫优先于 onTick：closed / 自停 / 重入时不跑检查', async () => {
  // closed：stop() 之后手动 tick 也不跑检查
  let callsA = 0
  const a = rig({ onTick: () => { callsA += 1 } })
  a.clock.stop()
  await a.clock.tick()
  assert.equal(callsA, 0)

  // 自停：失败那次检查跑过，自停后的 tick 不再跑
  let callsB = 0
  const b = rig({ maxFailures: 1, onTick: () => { callsB += 1 } })
  b.setDue([reason('a')])
  b.failTimes(-1)
  await b.clock.tick()
  assert.equal(b.clock.stats().stopped, true)
  await b.clock.tick()
  assert.equal(callsB, 1, '自停后的 tick 不得再跑检查')

  // 重入：deliver 等待期间又来一个 tick，内层被守卫跳过
  let callsC = 0
  let clockC: ReturnType<typeof attachWakeClock> | undefined
  const c = rig({
    onTick: () => { callsC += 1 },
    deliver: async () => { await clockC?.tick() },
  })
  clockC = c.clock
  c.setDue([reason('a')])
  await c.clock.tick()
  assert.equal(callsC, 1, '重入的 tick 被守卫跳过，检查不重复跑')
  assert.equal(c.fired.length, 1)
})
