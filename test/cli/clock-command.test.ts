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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runChat } from '../../src/cli/chat.ts'
import { AuditLog } from '../../src/audit/audit.ts'
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

async function chat(
  dataRoot: string,
  clock: WakeClock | undefined,
  cmds: string[] = ['/clock'],
  withDbPath = true,
): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx,
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    ...(withDbPath ? { dbPath: join(dataRoot, 'core.sqlite') } : {}),
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

// ---------------------------------------------------------------- `/clock log`（观察位的历史面）
//
// stats() 只有当前进程的数：重启一次，「她昨天自动说了什么」就没了。
// 审计链里其实一直存着（`clock.fired`），只差一个读的入口。

test('CLK10 /clock log 读审计链，显示最近的主动开口', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const audit = AuditLog.open(join(dataRoot, 'core.sqlite'))
    try {
      audit.append({ kind: 'system', component: 'clock' }, {
        kind: 'clock.fired', sessionId: 'prts-clock-x', reasonKind: 'intent', refId: 'i1', text: '该吃药了',
      })
    } finally { audit.close() }

    const { clock } = fakeClock()
    const text = await chat(dataRoot, clock, ['/clock log'])
    assert.match(text, /该吃药了/, '历史里说过的话必须能看见')
    assert.match(text, /intent/)
  } finally { t.cleanup() }
})

test('CLK11 没有记录（库缺 / 表空）→ 如实说「还没有」，不报错也不编造', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const { clock } = fakeClock()
    const text = await chat(join(t.dir, 'data'), clock, ['/clock log'])
    assert.match(text, /还没有主动开口的记录/)
  } finally { t.cleanup() }
})

test('CLK12 未配置 core.sqlite → 明确报读不到历史', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const { clock } = fakeClock()
    const text = await chat(join(t.dir, 'data'), clock, ['/clock log'], false)
    assert.match(text, /读不到时钟历史/)
  } finally { t.cleanup() }
})

test('CLK18 时钟未启用也能读历史：/clock log 不依赖进程内时钟', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const audit = AuditLog.open(join(dataRoot, 'core.sqlite'))
    try {
      audit.append({ kind: 'system', component: 'clock' }, {
        kind: 'clock.fired', sessionId: 'prts-clock-x', reasonKind: 'fact', refId: 'f1', text: '惦记的事',
      })
    } finally { audit.close() }

    // 不注入 clock：PRTS_CLOCK=off / 记忆库未打开的场景。
    const text = await chat(dataRoot, undefined, ['/clock log'])
    assert.match(text, /惦记的事/, '历史面在时钟关闭时恰恰最有用')
  } finally { t.cleanup() }
})

test('CLK19 脏 payload（event 为 null）不崩、不冒充记录', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const dbPath = join(dataRoot, 'core.sqlite')
    const init = AuditLog.open(dbPath)
    init.close()
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare('INSERT INTO audit_events (seq,kind,actor_json,payload_json,ts,prev_hash,hash) VALUES (?,?,?,?,?,?,?)')
        .run(1, 'clock.fired', '{"kind":"system","component":"clock"}', 'null', Date.now(), '0'.repeat(64), 'a'.repeat(64))
    } finally { db.close() }

    const { clock } = fakeClock()
    const text = await chat(dataRoot, clock, ['/clock log'])
    assert.match(text, /还没有主动开口的记录/, '一条脏记录不该冒充一条正常记录')
  } finally { t.cleanup() }
})

test('CLK20 usage 行提到 /clock log（新面必须可发现）', async () => {
  const t = makeTmp('prts-clock-cli-')
  try {
    const { clock } = fakeClock()
    const text = await chat(join(t.dir, 'data'), clock)
    assert.match(text, /\/clock log/)
  } finally { t.cleanup() }
})
