/**
 * ③ 预算层与 memory-inject 的接线验收。
 *
 * `token-budget.test.ts` 证明算术正确；本文件证明它**真的接在注入链上**：
 * 预算不够时少装、预算为零时不装、不传预算时旧行为一字不变。
 *
 * 断言不解析正文格式（注入正文会按主题/会话归组成卡片，行首未必是 `- `），
 * 改为数「正文里出现了几条事实的 object」——与渲染格式解耦。
 *
 * 基线（未接线时）：MB1/MB3 会红——旧实现只按 `limit: 5`，不认 token 预算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { attachMemoryInjection } from '../../src/runtime/memory-inject.ts'
import { makeTmp } from '../support/tmp.ts'

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

function payloadOf(text: string, step = 1): unknown {
  return {
    agent: { session: { id: 'sess-budget' } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn: 1,
    step,
  }
}

const enter = (messages: unknown[]): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })
const userMsg = (text: string): unknown => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const INJ = '[记忆检索]'

function seeded(objects: readonly string[]): { store: MemoryStore; cleanup: () => void } {
  const t = makeTmp('prts-mi-budget-')
  const store = MemoryStore.open(t.db())
  for (const object of objects) {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object,
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
  }
  return { store, cleanup: () => { try { store.close() } catch { /* closed */ } t.cleanup() } }
}

/** 注入消息的正文；没注入则返回空串。 */
function injectedText(messages: unknown[]): string {
  const last = messages[messages.length - 1] as { content?: { text?: string }[] } | undefined
  const text = last?.content?.[0]?.text ?? ''
  return text.includes(INJ) ? text : ''
}

/** 正文里出现了几条事实（按 object 匹配，与渲染格式解耦）。 */
function factsIn(text: string, objects: readonly string[]): number {
  return objects.filter((o) => text.includes(o)).length
}

/** 必须与三条事实共享关键词（博士/偏好），否则 FTS 命中为空——测的就不是预算了。 */
const QUERY = '博士偏好什么'
const FACTS = ['光学镜头设计', '机械键盘', '黑咖啡'] as const

test('MB1 预算为 0：零注入', async () => {
  const env = seeded([FACTS[0]])
  try {
    const { ctx, fire } = fakeHookCtx()
    const inj = attachMemoryInjection(ctx, {
      store: env.store,
      budget: { maxTokens: 0, estimateTokens: () => 10 },
    })
    try {
      const d = await fire(payloadOf(QUERY), async () => enter([userMsg(QUERY)]))
      assert.equal(injectedText((d as { messages: unknown[] }).messages), '', '预算 0 不得注入')
    } finally { inj.dispose() }
  } finally { env.cleanup() }
})

test('MB2 预算充足：正常注入', async () => {
  const env = seeded([FACTS[0]])
  try {
    const { ctx, fire } = fakeHookCtx()
    const inj = attachMemoryInjection(ctx, {
      store: env.store,
      budget: { maxTokens: 10_000, estimateTokens: () => 10 },
    })
    try {
      const d = await fire(payloadOf(QUERY), async () => enter([userMsg(QUERY)]))
      const text = injectedText((d as { messages: unknown[] }).messages)
      assert.notEqual(text, '', '预算充足应注入')
      assert.ok(text.includes(FACTS[0]), `注入应含事实：${text.slice(0, 200)}`)
    } finally { inj.dispose() }
  } finally { env.cleanup() }
})

test('MB3 预算只够一条：按顺序只保留前缀', async () => {
  const env = seeded(FACTS)
  try {
    const { ctx, fire } = fakeHookCtx()
    // header 100 + 每条 10：budget 110 只够第一条
    const inj = attachMemoryInjection(ctx, {
      store: env.store,
      limit: 5,
      budget: { maxTokens: 110, estimateTokens: () => 10 },
    })
    try {
      const d = await fire(payloadOf(QUERY), async () => enter([userMsg(QUERY)]))
      const text = injectedText((d as { messages: unknown[] }).messages)
      assert.notEqual(text, '', '预算够一条时应注入这一条')
      assert.equal(factsIn(text, FACTS), 1, `只应装 1 条事实：${text.slice(0, 300)}`)
    } finally { inj.dispose() }
  } finally { env.cleanup() }
})

test('MB4 不传预算：旧行为（只受 limit 约束）', async () => {
  const env = seeded(FACTS)
  try {
    const { ctx, fire } = fakeHookCtx()
    const inj = attachMemoryInjection(ctx, { store: env.store, limit: 5 })
    try {
      const d = await fire(payloadOf(QUERY), async () => enter([userMsg(QUERY)]))
      const text = injectedText((d as { messages: unknown[] }).messages)
      assert.ok(factsIn(text, FACTS) >= 2, `未传预算时不应被裁到 1 条：${text.slice(0, 300)}`)
    } finally { inj.dispose() }
  } finally { env.cleanup() }
})
