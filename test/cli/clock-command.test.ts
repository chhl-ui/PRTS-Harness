/**
 * `/clock` 命令：时钟的 owner 侧观察窗（DESIGN-09 的配套）。
 *
 * 为什么需要它：时钟现在会自主开口（c11382d）、会在受限工具面里查和记
 * （3b9d797）、会判断开口有没有被回应（2f5f03f）、连续失败会自停。
 * 这些状态全在进程内（`WakeClockStats`），**没有任何入口能看见**——
 * 博士只能靠「她今天怎么没说话」猜。一个看不见的自主系统，主人不敢放手；
 * 这条命令补的就是那个观察位。
 *
 * 三种状态：未启用 / 查看 / 手动 tick。未启用必须明确报不可用（不静默）。
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

/** runChat 需要一个能 create/get agent 的 agents 服务；`/clock` 不真正驱动它。 */
const fakeCtx = {
  get(name: string): unknown {
    if (name !== 'agents') return undefined
    const agent = {
      status: 'idle',
      followup(): void { /* /clock 不投递消息 */ },
      session: { id: 'sess-clock', append(): void { /* 不写会话事件 */ } },
    }
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

function fakeClock(
  overrides: Partial<WakeClockStats> = {},
  tickResult: WakeReason[] = [],
): { clock: WakeClock; calls: { tick: number } } {
  const calls = { tick: 0 }
  const stats: WakeClockStats = {
    ticks: 0, fired: 0, skipped: 0, failures: 0, unanswered: 0, stopped: false,
    lastFiredAtMs: null, lastReason: null,
    ...overrides,
  }
  return {
    calls,
    clock: {
      start(): void { /* 测试不启定时器 */ },
      stop(): void { /* 同上 */ },
      async tick(): Promise<WakeReason[]> {
        calls.tick += 1
        return tickResult
      },
      stats: () => ({ ...stats }),
    },
  }
}

async function chat(dataRoot: string, clock: WakeClock | undefined, cmds: string[] = ['/clock']): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx,
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    ...(clock === undefined ? {} : { clock }),
  })
  return printed.join('')
}

test('CLK1 /clock 显示统计：tick / 开口 / 跳过 / 连续未回应 / 上次理由', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock } = fakeClock({
      ticks: 12, fired: 3, skipped: 9, unanswered: 2,
      lastFiredAtMs: Date.UTC(2026, 10, 11, 12, 0, 0),
      lastReason: { kind: 'intent', text: '该吃药了', refId: 'i1' },
    })
    const text = await chat(dataRoot, clock)
    assert.match(text, /tick 12/)
    assert.match(text, /开口 3/)
    assert.match(text, /跳过 9/)
    assert.match(text, /连续未回应 2/)
    assert.match(text, /上次理由：intent — 该吃药了/)
    assert.match(text, /\/clock tick/)
  } finally { t.cleanup() }
})

test('CLK2 /clock tick 手动触发一次并报告投递内容', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { clock, calls } = fakeClock({}, [{ kind: 'intent', text: '该吃药了', refId: 'i1' }])
    const text = await chat(dataRoot, clock, ['/clock tick'])
    assert.equal(calls.tick, 1, '手动 tick 必须真的调一次')
    assert.match(text, /已投递：intent — 该吃药了/)
  } finally { t.cleanup() }
})

test('CLK3 未注入时钟 → 明确报不可用（不静默什么都不做）', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const text = await chat(join(t.dir, 'data'), undefined)
    assert.match(text, /时钟未启用/)
  } finally { t.cleanup() }
})

test('CLK4 已自停 → 状态里写清「已自停」而不是当作正常运行', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const { clock } = fakeClock({ stopped: true, failures: 3 })
    const text = await chat(join(t.dir, 'data'), clock)
    assert.match(text, /已自停/)
    assert.match(text, /失败 3/)
  } finally { t.cleanup() }
})
