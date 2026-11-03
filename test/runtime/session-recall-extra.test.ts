/**
 * `attachSessionRecall` 的补充行为测试——钉住验收合同
 * （`test/runtime/session-recall.test.ts`）没有覆盖的条款：
 *
 * - `resume.next` 为 null 时「下一步」退回账本里最后一条 step 的名字
 * - 意图按 `fireAtMs` 升序、`maxIntents` 截断
 * - 近期 turn 每条压成一行且不超过 120 字符
 * - `recentWindowMs` 之外的 turn 不返回；窗口以注入的 `now` 为基准
 * - `decision.kind !== 'enter'` 原样返回，且不消耗该会话的开场名额
 * - payload 缺 `session.id` 时不注入
 * - `dispose` 注销 handler
 * - 未结任务按 `updatedAt` 倒序取 `maxTasks` 条
 * - `maxTurns` 截断
 * - 空正文不登记会话：后来才有数据时仍能开一次场
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Ledger } from '../../src/ledger/index.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { attachSessionRecall } from '../../src/runtime/session-recall.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Actor } from '../../src/ledger/index.ts'

const owner: Actor = { kind: 'owner' }
const HOUR = 3_600_000

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

const enter = (messages: unknown[]) => ({ kind: 'enter' as const, messages })

function payloadOf(sessionId: string) {
  return {
    agent: { session: { id: sessionId } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '今天做什么' }], source: { kind: 'user' } }],
    turn: 0,
    step: 0,
  }
}

interface Ctx {
  ledger: Ledger
  store: MemoryStore
  cleanup(): void
}

function openCtx(): Ctx {
  const tmp = makeTmp('prts-session-recall-extra-')
  const ledger = Ledger.open(join(tmp.dir, 'ledger.sqlite'))
  const store = MemoryStore.open(join(tmp.dir, 'memory.sqlite'))
  return { ledger, store, cleanup: () => tmp.cleanup(ledger, store) }
}

test('SRX1 resume.next 为空时，「下一步」退回账本里最后一条 step 的名字', () => {
  const c = openCtx()
  try {
    const created = c.ledger.create(owner, {
      title: '把光学设计跑通', objective: 'O', acceptance: { kind: 'owner-confirm' },
    })
    const active = c.ledger.activate(owner, { id: created.id, revision: created.revision })
    c.ledger.beginStep(owner, active.id, { stepNo: 1, name: '先拍基准图', idempotent: true })
    c.ledger.beginStep(owner, active.id, { stepNo: 2, name: '再跑集成测试', idempotent: true })

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('把光学设计跑通'), `缺任务标题：\n${text}`)
      assert.ok(text.includes('再跑集成测试'), `应退回最后一条 step：\n${text}`)
      assert.ok(!text.includes('先拍基准图'), `不该把更早的 step 当下一步：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX2 待触发意图按 fireAtMs 升序，maxIntents 截断', () => {
  const c = openCtx()
  try {
    const at = Date.now()
    c.store.createIntent({ actor: 'owner', conditionRaw: '后天', action: '较晚的提醒', fireAtMs: at + 48 * HOUR })
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '较早的提醒', fireAtMs: at + 2 * HOUR })

    const recall = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: c.ledger, store: c.store, maxIntents: 1,
    })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('较早的提醒'), `应按计划时刻升序取最近到点的那条：\n${text}`)
      assert.ok(!text.includes('较晚的提醒'), `maxIntents=1 不该列出第二条：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX3 近期 turn 每条压成一行且不超过 120 字符', () => {
  const c = openCtx()
  try {
    const long = `${'乙'.repeat(10)}\n开头${'甲'.repeat(200)}结尾`
    c.store.recordTurn({
      actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user',
      text: long, occurredAtMs: Date.now() - HOUR,
    })

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes(`${'乙'.repeat(10)} 开头`), `换行应压成空格：\n${text}`)
      assert.ok(text.includes('…'), `超长正文应有截断标记：\n${text}`)
      assert.ok(!text.includes('结尾'), `120 字符之后的内容应被截掉：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX4 recentWindowMs 之外的 turn 不返回，窗口以注入的 now 为基准', () => {
  const c = openCtx()
  try {
    const at = Date.now()
    c.store.recordTurn({
      actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user',
      text: '很久以前的对话', occurredAtMs: at - 10 * HOUR,
    })

    const narrow = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: c.ledger, store: c.store, now: () => at, recentWindowMs: 2 * HOUR,
    })
    try {
      assert.equal(narrow.runOnce('s-now'), '', '窗口外的 turn 不该产出正文')
    } finally { narrow.dispose() }

    const wide = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: c.ledger, store: c.store, now: () => at, recentWindowMs: 12 * HOUR,
    })
    try {
      assert.ok(wide.runOnce('s-now').includes('很久以前的对话'), '同一时刻、放宽窗口后应能取到')
    } finally { wide.dispose() }
  } finally { c.cleanup() }
})

test('SRX5 空正文不登记会话：后来才有数据时仍能开一次场', () => {
  const c = openCtx()
  try {
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      assert.equal(recall.runOnce('s-later'), '', '空库不该产出正文')
      c.store.recordTurn({
        actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user',
        text: '后来才写进来的内容', occurredAtMs: Date.now() - HOUR,
      })
      assert.ok(recall.runOnce('s-later').includes('后来才写进来的内容'), '空正文不该占用开场名额')
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX6 非 enter 决策原样返回，且不消耗这个会话的开场名额', async () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const h = fakeHookCtx()
    const recall = attachSessionRecall(h.ctx, { ledger: c.ledger, store: c.store })
    try {
      const rejected = await h.fire(payloadOf('s-hook'), async () => ({ kind: 'reject' }))
      assert.deepEqual(rejected, { kind: 'reject' })
      const entered = await h.fire(payloadOf('s-hook'), async () => enter([]))
      assert.equal((entered as { messages: unknown[] }).messages.length, 1, 'reject 的轮次不该吃掉开场')
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX7 payload 缺 session.id 时不注入', async () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const h = fakeHookCtx()
    const recall = attachSessionRecall(h.ctx, { ledger: c.ledger, store: c.store })
    try {
      const bare = await h.fire({ agent: {} }, async () => enter([]))
      assert.equal((bare as { messages: unknown[] }).messages.length, 0, '没有会话 id 就不该注入')
      const withId = await h.fire(payloadOf('s-hook'), async () => enter([]))
      assert.equal((withId as { messages: unknown[] }).messages.length, 1)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX8 dispose 注销 handler', () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const h = fakeHookCtx()
    const recall = attachSessionRecall(h.ctx, { ledger: c.ledger, store: c.store })
    recall.dispose()
    assert.throws(
      () => { void h.fire(payloadOf('s-hook'), async () => enter([])) },
      /未注册 agent\/pre-step/,
    )
  } finally { c.cleanup() }
})

test('SRX9 未结任务按 updatedAt 倒序取 maxTasks 条', async () => {
  const c = openCtx()
  try {
    const made = ['任务甲', '任务乙', '任务丙'].map((title) => c.ledger.create(owner, {
      title, objective: 'O', acceptance: { kind: 'owner-confirm' },
    }))
    // updatedAt 是毫秒精度：逐个推进时钟，否则三条会撞在同一毫秒里，排序退化成建库顺序。
    for (const t of made) {
      c.ledger.activate(owner, { id: t.id, revision: t.revision })
      // Windows 的 Date.now() 分辨率约 15.6ms：5ms 的定时器可能落在同一毫秒里，
      // 三条任务 updatedAt 相同 → 稳定排序保持建库顺序 → 「最近更新的」断言翻。
      // 20ms 跨过一个系统时钟 tick，比 5ms 稳。
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const recall = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: c.ledger, store: c.store, maxTasks: 2,
    })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('任务丙'), `最近更新的应入选：\n${text}`)
      assert.ok(text.includes('任务乙'), `次新的应入选：\n${text}`)
      assert.ok(!text.includes('任务甲'), `最旧的应被 maxTasks 截掉：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SRX10 maxTurns 截断：只取最近几条', () => {
  const c = openCtx()
  try {
    const at = Date.now()
    for (const [i, text] of ['最旧', '中间', '最新'].entries()) {
      c.store.recordTurn({
        actor: 'owner', sessionId: 's-old', turnIndex: i, speaker: 'user',
        text, occurredAtMs: at - (3 - i) * HOUR,
      })
    }

    const recall = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: c.ledger, store: c.store, maxTurns: 2,
    })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('最新'), `缺最近一条：\n${text}`)
      assert.ok(text.includes('中间'), `缺次近一条：\n${text}`)
      assert.ok(!text.includes('最旧'), `maxTurns=2 不该列第三条：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})
