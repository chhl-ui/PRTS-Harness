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

function payloadOfTurn(text: string, sessionId: string, turn: number, step = 1) {
  return {
    agent: { session: { id: sessionId } },
    messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn, step,
  }
}
const msgText = (out: unknown, i: number) => (((out as { messages: { content: { text?: string }[] }[] }).messages[i]?.content?.[0]?.text) ?? '')
const injCount = (out: unknown) => ((out as { messages: { content: { text?: string }[] }[] }).messages.filter(m => (m.content?.[0]?.text ?? '').includes('记忆检索')).length)

test('U1 turn2/step1 再次注入（修复前被 step 去重跳过）；同 turn 同 step 只一次', async () => {
  const t = makeTmp('prts-inj-u1-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user', text: '光学镜头设计偏好 85mm' })
    store.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: 1, speaker: 'user', text: '闪光灯高速同步 HSS 笔记' })
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store })
    const n1 = injCount(await fake.fire(payloadOfTurn('光学镜头是啥', 's1', 1, 1), async () => enter([payloadOfTurn('光学镜头是啥', 's1', 1, 1).messages[0]])))
    assert.equal(n1, 1, 'turn1 应注入')
    const n2 = injCount(await fake.fire(payloadOfTurn('闪光灯是什么', 's1', 2, 1), async () => enter([payloadOfTurn('闪光灯是什么', 's1', 2, 1).messages[0]])))
    assert.equal(n2, 1, 'turn2/step1 应再次注入（去重键含 turn）')
    const n3 = injCount(await fake.fire(payloadOfTurn('闪光灯是什么', 's1', 2, 1), async () => enter([payloadOfTurn('闪光灯是什么', 's1', 2, 1).messages[0]])))
    assert.equal(n3, 0, '同 turn 同 step 重放只注入一次')
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U2 已注入命中不再注入；全部已注入过则不追加消息', async () => {
  const t = makeTmp('prts-inj-u2-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user', text: '光学镜头 X 内容' })
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store })
    const p1 = payloadOfTurn('光学镜头', 's1', 1)
    const o1 = await fake.fire(p1, async () => enter([p1.messages[0]]))
    assert.equal(injCount(o1), 1)
    const p2 = payloadOfTurn('光学镜头', 's1', 2)
    const o2 = await fake.fire(p2, async () => enter([p2.messages[0]]))
    assert.equal(injCount(o2), 0, '全部命中已注入过 → 不再追加')
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U3 本会话 turn 被过滤，其它会话 turn 与 fact 保留', async () => {
  const t = makeTmp('prts-inj-u3-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '本会话说过光学镜头自己的话' })
    store.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user', text: '他会话光学镜头历史记录' })
    store.assertFact({ actor: 'owner', subject: '镜头', predicate: '偏好', object: '光学镜头设计', provenance: 'stated', confirmationBasis: 'owner-stated' })
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store })
    const p = payloadOfTurn('光学镜头', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    const text = msgText(out, 1)
    assert.equal(text.includes('自己的话'), false, `本会话 turn 应被滤掉：${text}`)
    assert.ok(text.includes('他会话光学镜头历史记录'), '他会话 turn 保留')
    assert.ok(text.includes('光学镜头设计'), 'fact 保留')
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U5 更正钉住：零字面匹配的更正 turn 直接进注入（V1-06 F10 回归）', async () => {
  const t = makeTmp('prts-inj-u5-'); const store = MemoryStore.open(t.db())
  try {
    // 「改喝拿铁」里没有「咖啡」二字——纯检索召不回，必须靠钉住名额进来。
    store.recordTurn({
      actor: 'system', sessionId: 'old', turnIndex: 0, speaker: 'user',
      text: '我最近改喝拿铁了，不再喝美式。', occurredAtMs: Date.now(),
    })
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store })
    const p = payloadOfTurn('我喝咖啡有什么习惯', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    const text = msgText(out, 1)
    assert.ok(text.includes('拿铁'), `更正句必须被钉进注入：${text}`)
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U6 钉住的边界：同会话更正不注（已在上下文），普通陈述不注', async () => {
  const t = makeTmp('prts-inj-u6-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({
      actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user',
      text: '我改喝拿铁了。', occurredAtMs: Date.now(),
    })
    store.recordTurn({
      actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user',
      text: '今天天气不错，聊聊项目进度。', occurredAtMs: Date.now(),
    })
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store })
    const p = payloadOfTurn('一个与历史完全无关的问题', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    assert.equal(injCount(out), 0, '同会话更正与普通陈述都不该进注入')
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U4 过滤后仍凑满 limit', async () => {
  const t = makeTmp('prts-inj-u4-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '本 session 光学镜头前排占位 A1' })
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user', text: '本 session 光学镜头前排占位 A2' })
    for (const kw of ['B1', 'B2', 'B3']) {
      store.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user', text: `光学镜头 ${kw} 记录` })
    }
    const fake = fakeHookCtx(); const att = attachMemoryInjection(fake.ctx, { store, limit: 2 })
    const p = payloadOfTurn('光学镜头', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    const text = msgText(out, 1)
    const hitLines = text.split('\n').filter(l => /^\d+\. \[/.test(l))
    assert.equal(hitLines.length, 2, `应凑满 limit=2：${text}`)
    assert.equal(text.includes('占位 A'), false, '本 session turn 应被滤掉')
    att.dispose()
  } finally { t.cleanup(store) }
})

test('U7 语义路接线：字面零重叠的命中经向量路进注入（咖啡→拿铁类缺口）', async () => {
  const t = makeTmp('prts-inj-u7-'); const store = MemoryStore.open(t.db())
  try {
    // 两条历史 turn：语义上 A 该命中、B 是正交噪声。文本与查询零共享 token——
    // 字面路召不回 A，只能由向量路带进注入。
    const a = store.recordTurn({
      actor: 'system', sessionId: 'old', turnIndex: 0, speaker: 'user',
      text: '书房的绿萝该浇水了', occurredAtMs: Date.now() - 1000,
    })
    const b = store.recordTurn({
      actor: 'system', sessionId: 'old', turnIndex: 1, speaker: 'user',
      text: '打印机又卡纸了', occurredAtMs: Date.now() - 2000,
    })
    // 查询向量 = A 的方向；B 与其正交。
    store.putVectors([
      { ownerKind: 'turn', ownerId: a, vector: [1, 0, 0, 0] },
      { ownerKind: 'turn', ownerId: b, vector: [0, 1, 0, 0] },
    ], 'fake-embed')
    const embedder = async () => ({ model: 'fake-embed', embed: async () => [[1, 0, 0, 0]] })

    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store, embedder })
    const p = payloadOfTurn('阳台的花盆怎么选', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    const text = msgText(out, 1)
    assert.ok(text.includes('绿萝'), `语义近邻应进注入：${text}`)
    assert.equal(text.includes('卡纸'), false, `正交噪声不应进注入：${text}`)

    // 对照：同一 query 不给 embedder → 无注入（字面零命中）。
    const fake2 = fakeHookCtx()
    const att2 = attachMemoryInjection(fake2.ctx, { store })
    const p2 = payloadOfTurn('阳台的花盆怎么选', 's2', 1)
    const out2 = await fake2.fire(p2, async () => enter([p2.messages[0]]))
    assert.equal(injCount(out2), 0, '无 embedder 时该查询应零命中')
    att.dispose(); att2.dispose()
  } finally { t.cleanup(store) }
})

test('U8 embedder 抛错降级：注入不退化，字面路照常工作', async () => {
  const t = makeTmp('prts-inj-u8-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({
      actor: 'system', sessionId: 'other', turnIndex: 0, speaker: 'user',
      text: '光学镜头设计偏好 85mm', occurredAtMs: Date.now(),
    })
    const broken = async () => { throw new Error('ollama down') }
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store, embedder: broken })
    const p = payloadOfTurn('光学镜头是什么', 's1', 1)
    const out = await fake.fire(p, async () => enter([p.messages[0]]))
    assert.ok(msgText(out, 1).includes('85mm'), 'embedder 挂掉时字面命中照常注入')
    att.dispose()
  } finally { t.cleanup(store) }
})
