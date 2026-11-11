/**
 * `/clock` 的边界形态（CLK1—CLK4 之外的补充，不改既有测试）。
 *
 * 钉住四件事：
 * - 只读视图**不隐式 tick**（`/clock` 只是观察位，不能顺手改变时钟状态）；
 * - `tick` 返回空 ≠ 坏了（闸门/节流/日上限照常生效），文案要说清这层歧义；
 * - 未自停时不得出现「已自停」字样（否则博士会以为时钟停了）；
 * - `tick()` 抛错不能把 REPL 打崩，且后续命令照常可用；
 * - 三条命令都不得进入模型回合（`agent.followup` 零调用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import type { WakeClock, WakeClockStats, WakeReason } from '../../src/runtime/wake-clock.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** `agent.followup` 计数即「有没有进模型回合」的判据（chat.ts 的回合起点）。 */
function fakeCtx(): { ctx: Context; turns: { followup: number } } {
  const turns = { followup: 0 }
  const agent = {
    status: 'idle',
    followup(): void { turns.followup += 1 },
    session: { id: 'sess-clock', append(): void { /* 不写会话事件 */ } },
  }
  const ctx = {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        list: () => [{ session: { id: 'sess-clock' } }],
        get: (id: string) => (id === 'sess-clock' ? agent : undefined),
        async create(): Promise<unknown> {
          return { agent, dispose: async (): Promise<void> => { /* noop */ } }
        },
      }
    },
    on: () => () => {},
  } as unknown as Context
  return { ctx, turns }
}

function fakeClock(opts: {
  stats?: Partial<WakeClockStats>
  tick?: () => Promise<WakeReason[]>
} = {}): { clock: WakeClock; calls: { tick: number } } {
  const calls = { tick: 0 }
  const stats: WakeClockStats = {
    ticks: 0, fired: 0, skipped: 0, failures: 0, unanswered: 0, stopped: false,
    lastFiredAtMs: null, lastReason: null,
    ...opts.stats,
  }
  return {
    calls,
    clock: {
      start(): void { /* 测试不启定时器 */ },
      stop(): void { /* 同上 */ },
      async tick(): Promise<WakeReason[]> {
        calls.tick += 1
        return opts.tick === undefined ? [] : await opts.tick()
      },
      stats: () => ({ ...stats }),
    },
  }
}

async function chat(
  dataRoot: string,
  clock: WakeClock | undefined,
  cmds: string[],
): Promise<{ text: string; followup: number }> {
  const printed: string[] = []
  const { ctx, turns } = fakeCtx()
  await runChat({
    ctx,
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    ...(clock === undefined ? {} : { clock }),
  })
  return { text: printed.join(''), followup: turns.followup }
}

test('CLK5 `/clock` 是只读视图：不隐式 tick，lastReason 为 null 时不打理由行', async () => {
  const t = makeTmp('prts-clock-cli-cases-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock, calls } = fakeClock({ stats: { ticks: 5, fired: 2, skipped: 3 } })
    const { text } = await chat(dataRoot, clock, ['/clock'])
    assert.equal(calls.tick, 0, '查看统计不得触发 tick')
    assert.match(text, /tick 5/)
    assert.match(text, /上次开口：从未/)
    assert.doesNotMatch(text, /上次理由/, '没有上次理由时不能凭空打一行')
  } finally { t.cleanup() }
})

test('CLK6 未自停时不得出现「已自停」，失败数照实显示', async () => {
  const t = makeTmp('prts-clock-cli-cases-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock } = fakeClock({ stats: { failures: 1, stopped: false } })
    const { text } = await chat(dataRoot, clock, ['/clock'])
    assert.match(text, /失败 1/)
    assert.doesNotMatch(text, /已自停/, '运行中的时钟不能被描述成已自停')
  } finally { t.cleanup() }
})

test('CLK7 `/clock tick` 空结果：说明可能被节流/闸门挡住，不当作故障', async () => {
  const t = makeTmp('prts-clock-cli-cases-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock, calls } = fakeClock({ tick: async () => [] })
    const { text } = await chat(dataRoot, clock, ['/clock tick'])
    assert.equal(calls.tick, 1)
    assert.match(text, /没有可投递的到期项/)
    assert.match(text, /节流|闸门/)
  } finally { t.cleanup() }
})

test('CLK8 tick 抛错不崩 REPL：报失败，后续命令仍可用', async () => {
  const t = makeTmp('prts-clock-cli-cases-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock, calls } = fakeClock({
      stats: { ticks: 7 },
      tick: async () => { throw new Error('collectDue 炸了') },
    })
    const { text } = await chat(dataRoot, clock, ['/clock tick', '/clock'])
    assert.equal(calls.tick, 1)
    assert.match(text, /手动 tick 失败：collectDue 炸了/)
    assert.match(text, /tick 7/, '失败后 REPL 必须还在，下一条命令照常执行')
  } finally { t.cleanup() }
})

test('CLK9 三条 `/clock` 命令都不进入模型回合', async () => {
  const t = makeTmp('prts-clock-cli-cases-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock } = fakeClock({ tick: async () => [] })
    const { followup } = await chat(dataRoot, clock, ['/clock', '/clock tick', '/clock 随便什么'])
    assert.equal(followup, 0, 'host 命令必须 continue 掉，不能投给模型')
  } finally { t.cleanup() }
})
