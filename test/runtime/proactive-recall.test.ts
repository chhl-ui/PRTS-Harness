/**
 * V1-07 主动回忆 —— 注入层验收。
 *
 * 架构需求 §7 V1-07：「7 天试用中出现自然提起过去的情况，博士认为恰当的占比
 * 至少 70%；**可以关闭**」。
 *
 * 70% 是人工指标，这里钉的是它的机制前提——什么该提、什么不该提：
 *   PR1 相关事实触发一条克制注入（自报来源、不冒充用户发言）
 *   PR2 可以关闭（V1-07 原文的硬要求）
 *   PR3 每会话有上限（不刷屏）
 *   PR4 两次之间至少隔几轮（频率受控）
 *   PR5 同一条记忆不在同会话重复
 *   PR6 跨会话有冷却期（7 天）
 *   PR7 只提 fact：turn 是原始对话，不是「可以自然提起的旧事」
 *   PR8 每次提起都留痕（70% 评价的抽样来源）
 *   PR9 短查询不触发（两个字不构成话题）
 *   PR10 检索崩了不阻断对话
 *
 * 基线预期：`src/proactive/` 与 `src/runtime/proactive-recall.ts` 尚不存在，
 * import 失败 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { openProactiveStore } from '../../src/proactive/index.ts'
import { attachProactiveRecall } from '../../src/runtime/proactive-recall.ts'
import { makeTmp } from '../support/tmp.ts'

const DAY = 86_400_000
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

function userMsg(text: string): unknown {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function payloadOf(sessionId: string, text: string, turn = 0): unknown {
  return { agent: { session: { id: sessionId } }, messages: [userMsg(text)], turn, step: 0 }
}

/** 注入正文的识别标记——验收用逐字比较，不靠模糊匹配。 */
const MARK = '[可以提起的旧事]'

function textsOf(messages: unknown[]): string[] {
  return messages.map((m) => {
    const content = (m as { content?: unknown }).content
    if (!Array.isArray(content)) return ''
    return content.map((b) => (b as { text?: string }).text ?? '').join('')
  })
}

/** 一次「新会话 + 一次 pre-step」的最小骨架；返回 decision 与注入文本列表。 */
async function step(
  env: { store: MemoryStore; mentions: ReturnType<typeof openProactiveStore> },
  fire: Handler,
  opts: { sessionId?: string; text: string; turn?: number; maxPerSession?: number; minTurnsBetween?: number; enabled?: boolean; minQueryChars?: number; storeOverride?: MemoryStore },
) {
  const recall = attachProactiveRecall(
    { on: (_n: string, _f: Handler) => () => { /* 见 fakeHookCtx：这里不参与注册 */ } } as never,
    {
      store: opts.storeOverride ?? env.store,
      mentions: env.mentions,
      ...(opts.maxPerSession === undefined ? {} : { maxPerSession: opts.maxPerSession }),
      ...(opts.minTurnsBetween === undefined ? {} : { minTurnsBetween: opts.minTurnsBetween }),
      ...(opts.minQueryChars === undefined ? {} : { minQueryChars: opts.minQueryChars }),
      ...(opts.enabled === undefined ? {} : { enabled: opts.enabled }),
      now: () => NOW,
    },
  )
  recall.dispose()
  // 上面的 attach 只为类型对齐；真正驱动走 fire（由 fakeHookCtx 注册的 handler）。
  const decision = await fire(payloadOf(opts.sessionId ?? 's1', opts.text, opts.turn ?? 0), async () => enter([userMsg(opts.text)]))
  const messages = (decision as { messages: unknown[] }).messages
  return { messages, injected: textsOf(messages).filter((t) => t.includes(MARK)) }
}

function setup() {
  const t = makeTmp('prts-proactive-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  const mentions = openProactiveStore(t.db('proactive.sqlite'))
  return {
    t, store, mentions,
    cleanup() { try { mentions.close() } catch { /* closed */ } try { store.close() } catch { /* closed */ } t.cleanup() },
  }
}

/** 一条「博士偏好 50mm 定焦」的事实；查询「镜头」应命中。 */
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

/** 按项目惯例（交接文档坑 #7）用 Object.create 造替身，不展开实例。 */
function withBrokenSearch(store: MemoryStore): MemoryStore {
  const broken = Object.create(store) as MemoryStore
  ;(broken as unknown as { search(): never }).search = () => { throw new Error('boom') }
  return broken
}

test('PR1 相关事实：注入一条，自报来源且不冒充用户发言', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const decision = await fire(payloadOf('s1', '我最近想买镜头', 0), async () => enter([userMsg('我最近想买镜头')]))
      const messages = (decision as { messages: unknown[] }).messages
      const injected = textsOf(messages).filter((t) => t.includes(MARK))
      assert.equal(injected.length, 1, `应注入一条：实得 ${injected.length}`)
      assert.ok(injected[0]!.includes('50mm'), `注入应含事实内容：${injected[0]!.slice(0, 200)}`)
      assert.ok(injected[0]!.includes('不是用户本轮发言'), '必须自报来源，否则模型会当成用户新指令')
      assert.ok(injected[0]!.includes('不自然就忽略') || injected[0]!.includes('不要硬塞'), '必须给出「不自然就别说」的克制指令')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR2 可以关闭：enabled=false 时零注入', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, enabled: false, now: () => NOW })
    try {
      const decision = await fire(payloadOf('s1', '我最近想买镜头', 0), async () => enter([userMsg('我最近想买镜头')]))
      const injected = textsOf((decision as { messages: unknown[] }).messages).filter((t) => t.includes(MARK))
      assert.equal(injected.length, 0, '关闭后不得注入')
      assert.equal(env.mentions.countBySession('s1'), 0, '关闭时也不留痕')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR3 每会话上限：默认 2 次，第 3 条不再提', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    seedFact(env.store, '机械键盘')
    seedFact(env.store, '黑咖啡')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      let count = 0
      for (const [i, text] of ['我想买镜头', '键盘好用吗', '咖啡怎么冲'].entries()) {
        const d = await fire(payloadOf('s1', text, i * 10), async () => enter([userMsg(text)]))
        count += textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length
      }
      assert.equal(count, 2, `默认上限 2：实得 ${count}`)
      assert.equal(env.mentions.countBySession('s1'), 2)
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR4 间隔：minTurnsBetween 轮内不提第二条', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    seedFact(env.store, '机械键盘')
    seedFact(env.store, '黑咖啡')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, minTurnsBetween: 3, now: () => NOW })
    try {
      const at = async (turn: number, text: string) => {
        const d = await fire(payloadOf('s1', text, turn), async () => enter([userMsg(text)]))
        return textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length
      }
      assert.equal(await at(0, '我想买镜头'), 1, '第 0 轮提第一条')
      assert.equal(await at(1, '键盘好用吗'), 0, '第 1 轮间隔不足')
      assert.equal(await at(2, '咖啡怎么冲'), 0, '第 2 轮间隔仍不足')
      assert.equal(await at(3, '键盘好用吗'), 1, '第 3 轮够间隔，可以提第二条')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR5 同会话去重：同一条事实不重复提', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, minTurnsBetween: 0, maxPerSession: 10, now: () => NOW })
    try {
      const at = async (turn: number) => {
        const d = await fire(payloadOf('s1', '镜头的事', turn), async () => enter([userMsg('镜头的事')]))
        return textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length
      }
      assert.equal(await at(0), 1)
      assert.equal(await at(1), 0, '同一条事实不重复提')
      assert.equal(await at(2), 0)
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR6 跨会话冷却：7 天内别的会话也不提同一条', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const at = async (sessionId: string) => {
        const d = await fire(payloadOf(sessionId, '镜头的事', 0), async () => enter([userMsg('镜头的事')]))
        return textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length
      }
      assert.equal(await at('s1'), 1, '第一会话提起')
      assert.equal(await at('s2'), 0, '7 天内第二会话不再提同一条')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR7 只提 fact：turn 命中不触发主动回忆', async () => {
  const env = setup()
  try {
    env.store.recordTurn({ actor: 'owner', sessionId: 'old', turnIndex: 0, speaker: '博士', text: '我上次说镜头要用 50mm', occurredAtMs: NOW - DAY })
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const d = await fire(payloadOf('s1', '镜头的事', 0), async () => enter([userMsg('镜头的事')]))
      const injected = textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK))
      assert.equal(injected.length, 0, 'turn 是原始对话，不是可以自然提起的旧事')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR8 留痕：每次提起写一条记录，字段可查', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      await fire(payloadOf('s1', '我想买镜头', 4), async () => enter([userMsg('我想买镜头')]))
      const rows = env.mentions.list({ sessionId: 's1' })
      assert.equal(rows.length, 1, '必须留痕，否则 70% 恰当率无法抽样评价')
      assert.equal(rows[0]!.turn, 4)
      assert.equal(rows[0]!.kind, 'fact')
      assert.equal(rows[0]!.mentionedAtMs, NOW)
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR9 短查询：不足 4 字符不触发', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const d = await fire(payloadOf('s1', '镜头', 0), async () => enter([userMsg('镜头')]))
      const injected = textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK))
      assert.equal(injected.length, 0, '两个字不构成话题')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR10 检索抛错：不注入也不崩（增强不是闸门）', async () => {
  const env = setup()
  try {
    seedFact(env.store)
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: withBrokenSearch(env.store), mentions: env.mentions, now: () => NOW })
    try {
      const d = await fire(payloadOf('s1', '我最近想买镜头', 0), async () => enter([userMsg('我最近想买镜头')]))
      assert.equal((d as { kind: string }).kind, 'enter', '原 decision 必须原样返回')
      assert.equal(textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length, 0)
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR11 turn 回退：轮次不可比时这一轮不开口（不放行负间隔）', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    seedFact(env.store, '机械键盘')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, minTurnsBetween: 2, maxPerSession: 10, now: () => NOW })
    try {
      const at = async (turn: number, text: string) => {
        const d = await fire(payloadOf('s1', text, turn), async () => enter([userMsg(text)]))
        return textsOf((d as { messages: unknown[] }).messages).filter((t) => t.includes(MARK)).length
      }
      assert.equal(await at(5, '我想买镜头'), 1, '第 5 轮提起第一条')
      assert.equal(await at(2, '键盘好用吗'), 0, 'turn 回退（2 < 5）算不出间隔，不得放行')
      assert.equal(await at(8, '键盘好用吗'), 1, 'turn 恢复正常且间隔足够后可再提')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})

test('PR12 messages 非数组：原样返回，不得丢掉原有消息', async () => {
  const env = setup()
  try {
    seedFact(env.store, '50mm 定焦镜头')
    const { ctx, fire } = fakeHookCtx()
    const recall = attachProactiveRecall(ctx, { store: env.store, mentions: env.mentions, now: () => NOW })
    try {
      const bare = { kind: 'enter' as const }
      const d = await fire(payloadOf('s1', '我想买镜头', 0), async () => bare)
      assert.equal(d, bare, 'decision 形状不完整时应原样返回，不重建 messages')
      assert.equal('messages' in (d as object), false, '不得凭空造出 messages 字段')
    } finally { recall.dispose() }
  } finally { env.cleanup() }
})
