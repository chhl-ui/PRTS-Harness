/**
 * `/clock log` 的边界面：任务原文写明「库缺 / 表空 → 如实说还没有」「limit 10」
 * 「只读打开失败一律当作没有记录」，CLK10—CLK12 只钉了库缺与有记录两条。
 * 这里补的是同一入口的其余分支——不修改已有测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import { AuditLog } from '../../src/audit/audit.ts'
import type { WakeClock, WakeClockStats } from '../../src/runtime/wake-clock.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** 与 clock-command.test.ts 同一构造：`/clock log` 不真正驱动 agent。 */
const fakeCtx = {
  get(name: string): unknown {
    if (name !== 'agents') return undefined
    const agent = {
      status: 'idle',
      followup(): void { /* /clock 不投递消息 */ },
      session: { id: 'sess-clock-log', append(): void { /* 不写会话事件 */ } },
    }
    return {
      list: () => [{ session: { id: 'sess-clock-log' } }],
      get: (id: string) => (id === 'sess-clock-log' ? agent : undefined),
      async create(): Promise<unknown> {
        return { agent, dispose: async (): Promise<void> => { /* noop */ } }
      },
    }
  },
  on: () => () => {},
} as unknown as Context

function fakeClock(): WakeClock {
  const stats: WakeClockStats = {
    ticks: 0, fired: 0, skipped: 0, failures: 0, unanswered: 0, stopped: false,
    lastFiredAtMs: null, lastReason: null,
  }
  return {
    start(): void { /* 测试不启定时器 */ },
    stop(): void { /* 同上 */ },
    async tick(): Promise<[]> { return [] },
    stats: () => ({ ...stats }),
  }
}

/** 默认带 dbPath（core.sqlite 位于 dataRoot 下）；`/clock log` 读的就是它。 */
async function chatLog(dataRoot: string): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx,
    lines: lines('/clock log', '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    dbPath: join(dataRoot, 'core.sqlite'),
    clock: fakeClock(),
  })
  return printed.join('')
}

test('CLK13 库存在但表空（从未有过 clock.fired）→ 如实说还没有，不报错', async () => {
  const t = makeTmp('prts-clock-log-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    // 非只读打开会建 schema：库与表都在，只是没有任何事件。
    AuditLog.open(join(dataRoot, 'core.sqlite')).close()
    const text = await chatLog(dataRoot)
    assert.match(text, /还没有主动开口的记录/)
  } finally { t.cleanup() }
})

test('CLK14 库里有其它审计事件、没有 clock.fired → 不误报成开口记录', async () => {
  const t = makeTmp('prts-clock-log-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const audit = AuditLog.open(join(dataRoot, 'core.sqlite'))
    try {
      audit.append({ kind: 'system', component: 'clock' }, {
        kind: 'clock.stopped', consecutive: 3, why: '连续失败',
      })
    } finally { audit.close() }
    const text = await chatLog(dataRoot)
    assert.match(text, /还没有主动开口的记录/)
    // 唯一一条非 fired 事件不该被当成记录打出来。
    assert.doesNotMatch(text, /连续失败/)
  } finally { t.cleanup() }
})

test('CLK15 limit 10：12 条开口只显示最近 10 条，最早两条不出现', async () => {
  const t = makeTmp('prts-clock-log-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const audit = AuditLog.open(join(dataRoot, 'core.sqlite'))
    try {
      for (let i = 1; i <= 12; i += 1) {
        audit.append({ kind: 'system', component: 'clock' }, {
          kind: 'clock.fired',
          sessionId: 'prts-clock-x',
          reasonKind: 'intent',
          refId: `i${i}`,
          text: `开口${String(i).padStart(2, '0')}`,
        })
      }
    } finally { audit.close() }
    const text = await chatLog(dataRoot)
    assert.match(text, /开口12/, '最近一条必须在')
    assert.match(text, /开口03/, '第 3 条是窗口内最早的一条')
    assert.doesNotMatch(text, /开口02/, '第 2 条超出 limit 10')
    assert.doesNotMatch(text, /开口01/, '第 1 条超出 limit 10')
  } finally { t.cleanup() }
})

test('CLK16 每条带时间戳与理由类型（不只正文）', async () => {
  const t = makeTmp('prts-clock-log-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    const fixed = Date.UTC(2026, 10, 11, 12, 0, 0)
    const audit = AuditLog.open(join(dataRoot, 'core.sqlite'), { now: () => fixed })
    try {
      audit.append({ kind: 'system', component: 'clock' }, {
        kind: 'clock.fired', reasonKind: 'stale-task', refId: 'task-1', text: '那个任务还挂着',
      })
    } finally { audit.close() }
    const text = await chatLog(dataRoot)
    assert.match(text, /2026/, '时间要能看见（不是只有正文）')
    assert.match(text, /stale-task/)
    assert.match(text, /那个任务还挂着/)
  } finally { t.cleanup() }
})

test('CLK17 core.sqlite 不是合法 SQLite（只读打开/查询失败）→ 按没有记录处理，不打崩 REPL', async () => {
  const t = makeTmp('prts-clock-log-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })
    writeFileSync(join(dataRoot, 'core.sqlite'), 'this is not a sqlite database\n')
    const text = await chatLog(dataRoot)
    assert.match(text, /还没有主动开口的记录/)
  } finally { t.cleanup() }
})
