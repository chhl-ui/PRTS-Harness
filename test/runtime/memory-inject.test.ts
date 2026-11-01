/**
 * 每轮自动注入记忆（`agent/pre-step` 拦截）的行为测试。
 *
 * 钉住五条边界，其中三条是「不许做的事」：不许吞掉 reject、不许在查不到时硬塞、
 * 不许因为检索抛错让本轮对话中断。用一个假 hookCtx 捕获注册的 handler 直接调用，
 * 不需要起完整运行时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { attachMemoryInjection, renderInjection } from '../../src/runtime/memory-inject.ts'
import { makeTmp } from '../support/tmp.ts'

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

function fakeHookCtx(): { ctx: { on(name: string, fn: Handler): () => void }; fire: Handler; registered(): boolean } {
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
    registered: () => handler !== undefined,
  }
}

function payloadOf(text: string, step = 1): {
  agent: { session: { id: string } }
  messages: Array<{ id: string; role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' } }>
  turn: number
  step: number
} {
  return {
    agent: { session: { id: 'sess-inject' } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn: 1,
    step,
  }
}

function enter(messages: unknown[]): { kind: 'enter'; messages: unknown[] } {
  return { kind: 'enter', messages }
}

function seeded(prefix: string): { store: MemoryStore; cleanup: () => void } {
  const t = makeTmp(prefix)
  const store = MemoryStore.open(t.db())
  store.assertFact({
    actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
    provenance: 'stated', confirmationBasis: 'owner-stated',
  })
  return { store, cleanup: () => t.cleanup(store) }
}

test('I1 有命中时追加一条 user 消息，正文含记忆内容', async () => {
  const { store, cleanup } = seeded('prts-inject-hit-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      // 整句中文、无分隔符：这是真机对话的真实形状。
      // 依赖 tokenize 对长汉字串拆 2-gram（见 `tokenize.ts` 与 M8e）；
      // 修复前整句是一个 13 字 token，这里会零命中。
      const payload = payloadOf('我之前说过的光学偏好是什么？')
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as {
        kind: string
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>
      }
      assert.equal(out.kind, 'enter')
      assert.equal(out.messages.length, 2, '原消息 1 条 + 注入 1 条')
      const injected = out.messages[1]
      assert.equal(injected?.role, 'user', '注入走 user 角色，模型才把它当上下文而不是自己的发言')
      const text = injected?.content?.[0]?.text ?? ''
      assert.match(text, /光学镜头设计/)
      assert.match(text, /记忆检索/, '要标明来源，避免模型把它当成用户本轮发言')
    } finally {
      att.dispose()
    }
  } finally {
    cleanup()
  }
})

test('I2 无命中时不追加任何消息', async () => {
  const t = makeTmp('prts-inject-miss-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('完全无关的新话题')
      const before = [...payload.messages]
      const out = await fake.fire(payload, async () => enter(before)) as { messages: unknown[] }
      assert.equal(out.messages.length, before.length)
    } finally {
      att.dispose()
    }
  } finally {
    t.cleanup(store)
  }
})

test('I3 next() 返回 reject 时原样透传', async () => {
  const { store, cleanup } = seeded('prts-inject-reject-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const out = await fake.fire(payloadOf('光学'), async () => ({ kind: 'reject' })) as { kind: string }
      assert.equal(out.kind, 'reject', '注入不得把 reject 变成 enter')
    } finally {
      att.dispose()
    }
  } finally {
    cleanup()
  }
})

test('I4 query 过短时不检索', async () => {
  const { store, cleanup } = seeded('prts-inject-short-')
  try {
    const fake = fakeHookCtx()
    let searches = 0
    const spy = {
      ...store,
      search: (...args: Parameters<MemoryStore['search']>) => { searches++; return store.search(...args) },
    } as MemoryStore
    const att = attachMemoryInjection(fake.ctx, { store: spy })
    try {
      const payload = payloadOf('ab')
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(searches, 0, '两个字符的查询噪声大于信息，不该检索')
      assert.equal(out.messages.length, payload.messages.length)
    } finally {
      att.dispose()
    }
  } finally {
    cleanup()
  }
})

test('I5 检索抛错时仍返回原 decision（不阻断对话）', async () => {
  const fake = fakeHookCtx()
  const broken = {
    search() { throw new Error('db is locked') },
  } as unknown as MemoryStore
  const att = attachMemoryInjection(fake.ctx, { store: broken })
  try {
    const payload = payloadOf('光学镜头')
    const out = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
    assert.equal(out.messages.length, payload.messages.length, '检索失败不得改变本轮消息')
  } finally {
    att.dispose()
  }
})

test('I6 同一 step 不重复注入；dispose 注销钩子', async () => {
  const { store, cleanup } = seeded('prts-inject-dedup-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('我之前提到的光学偏好', 7)
      const first = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(first.messages.length, 2)
      const second = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(second.messages.length, 1, '同一 step 重复触发不得叠加注入')
    } finally {
      att.dispose()
    }
    assert.equal(fake.registered(), false, 'dispose 后钩子应已注销')
  } finally {
    cleanup()
  }
})

test('I8 renderInjection 自报来源并带编号（评测与生产共用同一渲染）', () => {
  const text = renderInjection([
    {
      kind: 'turn', id: 't1', score: 1, origin: 'live', text: '我平时用 Godox V1 闪光灯',
      recallPath: 'like', occurredAtMs: 1_700_000_000_000,
    },
  ])
  assert.match(text, /^\[记忆检索\]/, '必须带来源前缀，否则模型会当成用户本轮发言')
  assert.match(text, /不是用户本轮发言/)
  assert.match(text, /1\. \[turn\]/)
  assert.match(text, /Godox V1/)
  // 时间要出现：没有时间的记忆答不了「多少天前」这类问题
  assert.match(text, /2023-11-1[34]T/)
})

test('I7 不把本轮问题自己当历史注入（inbox/claimed 先于 pre-step 落盘）', async () => {
  const t = makeTmp('prts-inject-selfref-')
  const store = MemoryStore.open(t.db())
  try {
    const question = '光学 偏好 是什么？'
    // 模拟真实时序：本轮问题在 pre-step 之前已被 recordTurn 写成 turn
    store.recordTurn({
      actor: 'system', sessionId: 'sess-inject', turnIndex: 0, speaker: 'user', text: question,
    })
    store.recordTurn({
      actor: 'system', sessionId: 'sess-old', turnIndex: 0, speaker: 'user',
      text: '博士偏好光学镜头设计，常用 85mm。',
    })

    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf(question)
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as {
        messages: Array<{ content: Array<{ text?: string }> }>
      }
      assert.equal(out.messages.length, 2, '仍然应该注入（有一条真实历史）')
      const text = out.messages[1]?.content?.[0]?.text ?? ''
      assert.match(text, /光学镜头设计/, '真实历史要在')
      const occurrences = text.split(question).length - 1
      assert.equal(occurrences, 0, '本轮原话不该出现在注入里')
    } finally {
      att.dispose()
    }
  } finally {
    t.cleanup(store)
  }
})
