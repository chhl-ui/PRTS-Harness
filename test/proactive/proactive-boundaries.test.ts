/**
 * V1-07 主动回忆 —— 边界与失败路径。
 *
 * 两个验收文件钉的是「正常路径」：留痕完整、冷却生效、闸门按序。这一份补的是
 * 同一批组件在**坏输入与零值**下的行为，因为它们的失败形态都是静默的：
 * 会话名落成 `__proto__`、`limit: 0` 被当成「不限」、冷却窗口 0 被当成「7 天」，
 * 都不会报错，只会让上限/去重/冷却悄悄失效——而失效的方向正好是「多提、乱提」。
 *
 * 这一份不改任何既有测试文件，只新增用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { openProactiveStore } from '../../src/proactive/index.ts'
import { attachProactiveRecall } from '../../src/runtime/proactive-recall.ts'
import { makeTmp } from '../support/tmp.ts'

const NOW = 1_700_000_000_000
const DAY = 86_400_000
const MARK = '[可以提起的旧事]'

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

function fresh() {
  const t = makeTmp('prts-proactive-b-')
  return { t, store: openProactiveStore(t.db('proactive.sqlite')) }
}

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

function userMsg(text: string): unknown {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function payloadOf(sessionId: string, text: string, turn = 0): unknown {
  return { agent: { session: { id: sessionId } }, messages: [userMsg(text)], turn, step: 0 }
}

function injectedCount(decision: unknown): number {
  const messages = (decision as { messages?: unknown[] }).messages ?? []
  return messages.filter((m) => {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) return false
    return content.map((b) => (b as { text?: string }).text ?? '').join('').includes(MARK)
  }).length
}

function setup() {
  const t = makeTmp('prts-proactive-b-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  const mentions = openProactiveStore(t.db('proactive.sqlite'))
  return {
    t, store, mentions,
    cleanup() { try { mentions.close() } catch { /* closed */ } try { store.close() } catch { /* closed */ } t.cleanup() },
  }
}

function seedFact(store: MemoryStore, object = '50mm 定焦镜头'): void {
  store.assertFact({
    actor: 'owner',
    subject: '博士',
    predicate: '偏好',
    object,
    provenance: 'stated',
    confirmationBasis: 'owner-stated',
  })
}

// ---------------------------------------------------------------- 存储层边界

test('PB1 空会话名与非有限数被拒，且不留下半条留痕', () => {
  const { t, store } = fresh()
  try {
    const base = { sessionId: 's1', turn: 0, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: NOW }
    assert.throws(() => store.record({ ...base, sessionId: '' }), TypeError, '空会话名会让会话隔离退化成共用一个桶')
    assert.throws(() => store.record({ ...base, memoryId: '' }), TypeError)
    assert.throws(() => store.record({ ...base, kind: '' }), TypeError)
    assert.throws(() => store.record({ ...base, turn: Number.NaN }), TypeError, 'NaN 轮次会被当成第 0 轮参与间隔计算')
    assert.throws(() => store.record({ ...base, score: Number.POSITIVE_INFINITY }), TypeError)
    assert.throws(() => store.record({ ...base, mentionedAtMs: Number.NaN }), TypeError)
    assert.equal(store.list().length, 0, '被拒的写入不得落盘')
  } finally { store.close(); t.cleanup() }
})

test('PB2 未知会话与原型链键名：读路径按普通字符串处理，不抛错也不误判', () => {
  const { t, store } = fresh()
  try {
    // `constructor` / `__proto__` 当会话名与记忆 id 时，普通对象查表会命中原型上的成员。
    store.record({ sessionId: '__proto__', turn: 0, memoryId: 'constructor', kind: 'fact', score: 1, mentionedAtMs: NOW })
    store.record({ sessionId: 'constructor', turn: 1, memoryId: '__proto__', kind: 'fact', score: 1, mentionedAtMs: NOW })
    assert.equal(store.countBySession('__proto__'), 1)
    assert.equal(store.countBySession('constructor'), 1)
    assert.equal(store.countBySession('toString'), 0)
    assert.equal(store.countBySession(''), 0, '空会话名没有提起过，答案是 0 而不是抛错')
    assert.equal(store.list({ sessionId: 'toString' }).length, 0)
    assert.equal(store.isCoolingDown('toString'), false)
    assert.equal(store.isCoolingDown(''), false)
    assert.equal(store.list({ sessionId: '__proto__' }).length, 1)
  } finally { store.close(); t.cleanup() }
})

test('PB3 limit 的零与越界：0 是空数组，负数不论上限，给了上限取最近 N 条', () => {
  const { t, store } = fresh()
  try {
    for (const turn of [0, 1, 2]) {
      store.record({ sessionId: 's1', turn, memoryId: `mem-${turn}`, kind: 'fact', score: 1, mentionedAtMs: NOW + turn })
    }
    assert.deepEqual(store.list().map((r) => r.turn), [0, 1, 2], '缺省按写入顺序')
    assert.deepEqual(store.list({ limit: 2 }).map((r) => r.turn), [1, 2], '给了上限取最近 N 条，仍按时间正序')
    assert.deepEqual(store.list({ limit: 0 }), [], 'limit 0 就是一条都不要，不是「不限」')
    assert.deepEqual(store.list({ limit: -1 }).map((r) => r.turn), [0, 1, 2], '负数不论上限')
    assert.deepEqual(store.list({ limit: 99 }).map((r) => r.turn), [0, 1, 2], '超量不报错')
  } finally { store.close(); t.cleanup() }
})

test('PB4 冷却窗口覆盖：0 表示不冷却，边界是严格小于，未来时刻按冷却处理', () => {
  const { t, store } = fresh()
  try {
    store.record({ sessionId: 's1', turn: 0, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: 1000 })
    assert.equal(store.isCoolingDown('mem-1', 1000 + 99, 100), true, '窗口内')
    assert.equal(store.isCoolingDown('mem-1', 1000 + 100, 100), false, '正好等于窗口就解除')
    assert.equal(store.isCoolingDown('mem-1', 9000, 0), false, '窗口 0 = 不冷却')
    assert.equal(store.isCoolingDown('mem-1', 500, 100), true, '未来时刻（时钟回拨）不放开冷却')
  } finally { store.close(); t.cleanup() }
})

test('PB5 关闭可重复调用，重开同一个库仍能读到之前的留痕', () => {
  const t = makeTmp('prts-proactive-b-')
  const path = t.db('proactive.sqlite')
  const first = openProactiveStore(path)
  try {
    first.record({ sessionId: 's1', turn: 0, memoryId: 'mem-1', kind: 'fact', score: 1, mentionedAtMs: NOW })
    first.close()
    first.close() // 重复关闭不得抛：cleanup 与显式关闭可能同时发生
    const second = openProactiveStore(path)
    try {
      assert.equal(second.list().length, 1, '留痕是持久事实，重开仍在')
      assert.equal(second.isCoolingDown('mem-1', NOW + DAY), true)
    } finally { second.close() }
  } finally { t.cleanup() }
})

// ---------------------------------------------------------------- 注入层边界

test('PB6 形状不对的输入一律静默放过：reject / 空 messages / 无 sessionId 都不注入也不留痕', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const rejected = { kind: 'reject' }
      const r1 = await fire({ agent: { session: { id: 's1' } }, messages: [userMsg('我最近想买镜头')], turn: 0 }, async () => rejected)
      assert.equal(r1, rejected, 'reject 分支必须原样返回，不做任何改写')
      const r2 = await fire({ agent: { session: { id: 's1' } }, messages: [], turn: 0 }, async () => enter([]))
      assert.equal(injectedCount(r2), 0, '没有本轮消息就没有可提的话题')
      const r3 = await fire({ messages: [userMsg('我最近想买镜头')], turn: 0 }, async () => enter([]))
      assert.equal(injectedCount(r3), 0, '没有 sessionId 就不共用一份上限与去重状态')
      assert.equal(env.mentions.countBySession('s1'), 0, '没注入过就不该有留痕')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PB7 同一轮重复触发只提一次：重入不消耗会话额度', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    seedFact(env.store, '机械键盘')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, minTurnsBetween: 0, now: () => NOW })
    try {
      const fireOnce = async (text: string) => injectedCount(await fire(payloadOf('s1', text, 7), async () => enter([userMsg(text)])))
      assert.equal(await fireOnce('我想买镜头'), 1)
      assert.equal(await fireOnce('键盘好用吗'), 0, '同一轮重放不得提第二条（那会把每会话 2 次压缩成一轮用完）')
      assert.equal(env.mentions.countBySession('s1'), 1)
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PB8 上限为 0 时完全闭嘴；minQueryChars 为 0 时短查询也放行', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    const silent = fakeHookCtx()
    const off = attachProactiveRecall(silent.ctx, { store: env.store, mentions: env.mentions, maxPerSession: 0, now: () => NOW })
    try {
      const d = await silent.fire(payloadOf('s1', '我想买镜头', 0), async () => enter([userMsg('我想买镜头')]))
      assert.equal(injectedCount(d), 0, 'maxPerSession 0 = 一次都不提')
      assert.equal(env.mentions.countBySession('s1'), 0)
    } finally { off.dispose() }

    const chatty = fakeHookCtx()
    const on = attachProactiveRecall(chatty.ctx, { store: env.store, mentions: env.mentions, minQueryChars: 0, now: () => NOW })
    try {
      const d = await chatty.fire(payloadOf('s2', '镜头', 0), async () => enter([userMsg('镜头')]))
      assert.equal(injectedCount(d), 1, 'minQueryChars 0 表示不设最短长度')
      assert.equal(env.mentions.countBySession('s2'), 1)
    } finally { on.dispose() }
  } finally { env.cleanup() }
})

test('PB9 编码：表情与中文作为会话名/记忆 id 原样往返', () => {
  const { t, store } = fresh()
  try {
    const sessionId = '会话-🛰-1'
    const memoryId = '记忆-🔭'
    store.record({ sessionId, turn: 0, memoryId, kind: 'fact', score: 1, mentionedAtMs: NOW })
    assert.equal(store.countBySession(sessionId), 1, '代理对不得被截断成半对，否则会话隔离会指错桶')
    const rows = store.list({ sessionId })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionId, sessionId)
    assert.equal(rows[0]!.memoryId, memoryId)
    assert.equal(store.isCoolingDown(memoryId, NOW + DAY), true)
  } finally { store.close(); t.cleanup() }
})
