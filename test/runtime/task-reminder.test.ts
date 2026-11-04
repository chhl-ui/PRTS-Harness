/**
 * W3 任务提醒 —— 注入层验收（设计见 `docs/design-superagent-fusion.md` §三 ③）。
 *
 * 原文：「任务 `blocked` 超过 N 小时、或 `claimDone` 后无人验收超过 N 小时，
 * 主动提醒一次。复用 `intent-trigger.ts` 的既有管道。」
 *
 * 8 条判据：
 *   TR1 blocked 超阈值 → 提醒一次
 *   TR2 同一轮之后不再重复（进程内）
 *   TR3 重启（新 store 实例，同一库文件）仍不重复
 *   TR4 verifying 超阈值 → 提醒
 *   TR5 未超阈值 → 不提醒
 *   TR6 阈值可配
 *   TR7 没有停滞任务 → 不提醒
 *   TR8 多条停滞：只显示 maxVisible 条 + 折叠提示，且被折叠的也算「已提醒」
 *
 * 已知近似：TaskSnapshot 没有「进入 blocked 的时刻」，实现只能用 `updatedAt`。
 * TR5/TR6 按这个口径钉住。
 *
 * 基线预期：`src/reminders/` 与 `src/runtime/task-reminder.ts` 尚不存在 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openReminderStore } from '../../src/reminders/index.ts'
import { attachTaskReminder } from '../../src/runtime/task-reminder.ts'
import { makeTmp } from '../support/tmp.ts'
import type { TaskId, TaskSnapshot } from '../../src/ledger/types.ts'

const HOUR = 3_600_000
const NOW = 1_700_000_000_000

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

function fakeHookCtx(): { ctx: { on(name: string, fn: Handler): () => void }; fire: Handler } {
  let handler: Handler | undefined
  return {
    ctx: {
      on(name: string, fn: Handler): () => void {
        if (name === 'agent/pre-step') handler = fn
        return () => { handler = undefined }
      },
    },
    fire: (payload, next) => {
      if (handler === undefined) throw new Error('未注册 agent/pre-step')
      return handler(payload, next)
    },
  }
}

const enter = (messages: unknown[]): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })
const userMsg = (text: string): unknown => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const payloadOf = (): unknown => ({
  agent: { session: { id: 'sess-reminder' } },
  messages: [userMsg('在忙')],
  turn: 1,
  step: 0,
})

function task(id: string, over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: id as TaskId,
    revision: 1,
    title: `任务-${id}`,
    objective: '',
    phase: 'blocked',
    acceptance: { kind: 'owner-confirm' } as never,
    budget: {} as never,
    usage: {} as never,
    resume: { lastCompletedStep: null, next: null, open: [] },
    createdAt: NOW - 10 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    ...over,
  }
}

function setup(tasks: TaskSnapshot[]) {
  const t = makeTmp('prts-reminder-')
  const store = openReminderStore(t.db('reminders.sqlite'))
  const ledger = { list: () => tasks }
  return {
    t, store, ledger,
    cleanup() { try { store.close() } catch { /* closed */ } t.cleanup() },
  }
}

const MARK = '[任务提醒]'

/** 跑一次 runOnce 的完整链路（pre-step → 注入文本），返回注入正文或 ''。 */
async function runOnce(
  env: { store: ReturnType<typeof openReminderStore>; ledger: { list(): TaskSnapshot[] } },
  opts: { staleAfterMs?: number; maxVisible?: number; now?: number } = {},
): Promise<string> {
  const { ctx, fire } = fakeHookCtx()
  const at = opts.now ?? NOW
  const att = attachTaskReminder(ctx, {
    ledger: env.ledger as never,
    store: env.store,
    now: () => at,
    ...(opts.staleAfterMs === undefined ? {} : { staleAfterMs: opts.staleAfterMs }),
    ...(opts.maxVisible === undefined ? {} : { maxVisible: opts.maxVisible }),
  })
  try {
    const d = await fire(payloadOf(), async () => enter([userMsg('在忙')]))
    const msgs = (d as { messages: unknown[] }).messages
    const last = msgs[msgs.length - 1] as { content?: { text?: string }[] } | undefined
    const text = last?.content?.[0]?.text ?? ''
    return text.includes(MARK) ? text : ''
  } finally { att.dispose() }
}

test('TR1 blocked 超阈值：提醒一次且含任务标题', async () => {
  const env = setup([task('t1', { phase: 'blocked', blockedReason: { code: 'need-input', message: '等博士确认' } })])
  try {
    const text = await runOnce(env)
    assert.notEqual(text, '', '应提醒')
    assert.ok(text.includes('任务-t1'), `应含标题：${text.slice(0, 200)}`)
    assert.ok(text.includes('等博士确认') || text.includes('need-input'), `应含阻塞原因：${text.slice(0, 200)}`)
  } finally { env.cleanup() }
})

test('TR2 同一轮之后不再重复（进程内）', async () => {
  const env = setup([task('t1')])
  try {
    assert.notEqual(await runOnce(env), '', '第一次应提醒')
    assert.equal(await runOnce(env), '', '第二次不得重复')
  } finally { env.cleanup() }
})

test('TR3 重启不丢：新 store 实例仍不重复', async () => {
  const t = makeTmp('prts-reminder-r-')
  const dbPath = t.db('reminders.sqlite')
  const tasks = [task('t1')]
  try {
    const s1 = openReminderStore(dbPath)
    try {
      const text = await runOnce({ store: s1, ledger: { list: () => tasks } })
      assert.notEqual(text, '', '第一次应提醒')
    } finally { s1.close() }
    const s2 = openReminderStore(dbPath)
    try {
      const text = await runOnce({ store: s2, ledger: { list: () => tasks } })
      assert.equal(text, '', '重启后不得重复提醒')
    } finally { s2.close() }
  } finally { t.cleanup() }
})

test('TR4 verifying 超阈值：提醒（等你验收）', async () => {
  const env = setup([task('t1', { phase: 'verifying' })])
  try {
    const text = await runOnce(env)
    assert.notEqual(text, '', 'verifying 也应提醒')
    assert.ok(text.includes('任务-t1'), `应含标题：${text.slice(0, 200)}`)
  } finally { env.cleanup() }
})

test('TR5 未超阈值：不提醒', async () => {
  const env = setup([task('t1', { updatedAt: NOW - 30 * 60_000 })]) // 30 分钟
  try {
    assert.equal(await runOnce(env), '', '默认阈值 2 小时，30 分钟不该提醒')
  } finally { env.cleanup() }
})

test('TR6 阈值可配：1 小时阈值下 90 分钟会提醒', async () => {
  const env = setup([task('t1', { updatedAt: NOW - 90 * 60_000 })])
  try {
    assert.equal(await runOnce(env, { staleAfterMs: 2 * HOUR }), '', '2 小时阈值下 90 分钟不提醒')
    assert.notEqual(await runOnce(env, { staleAfterMs: 1 * HOUR }), '', '1 小时阈值下 90 分钟应提醒')
  } finally { env.cleanup() }
})

test('TR7 没有停滞任务：不提醒', async () => {
  const env = setup([
    task('t1', { phase: 'active', updatedAt: NOW - 10 * HOUR }),
    task('t2', { phase: 'done', updatedAt: NOW - 10 * HOUR }),
  ])
  try {
    assert.equal(await runOnce(env), '', 'active/done 不是停滞，不该提醒')
  } finally { env.cleanup() }
})

test('TR8 多条停滞：只显示 maxVisible 条 + 折叠提示，被折叠的也算已提醒', async () => {
  const env = setup([task('t1'), task('t2'), task('t3')])
  try {
    const text = await runOnce(env, { maxVisible: 1 })
    assert.ok(text.includes('任务-t1'), `最久的应先显示：${text.slice(0, 300)}`)
    assert.ok(text.includes('另有 2 条'), `应折叠提示：${text.slice(0, 300)}`)
    assert.equal(await runOnce(env, { maxVisible: 1 }), '', '被折叠的也标记了已提醒，不能再提')
  } finally { env.cleanup() }
})

test('TR9 再次停滞：任务回到 active 后重新 blocked（updatedAt 前进）会重新提醒', async () => {
  const env = setup([])
  try {
    const first = [task('t1', { updatedAt: NOW - 5 * HOUR })]
    assert.notEqual(
      await runOnce({ store: env.store, ledger: { list: () => first } }, { now: NOW }),
      '',
      '第一次停滞应提醒',
    )
    // 时钟前进 10 小时；任务在 NOW+5h 再次 blocked（新的停滞）
    const again = [task('t1', { updatedAt: NOW + 5 * HOUR })]
    assert.notEqual(
      await runOnce({ store: env.store, ledger: { list: () => again } }, { now: NOW + 10 * HOUR }),
      '',
      '旧留痕不该压住新的停滞',
    )
  } finally { env.cleanup() }
})
