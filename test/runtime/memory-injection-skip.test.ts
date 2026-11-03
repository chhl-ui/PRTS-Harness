/**
 * 注入跳过记录：把「这一轮为什么没装记忆」也留下来（工作区装配 ⑧ 的补齐）。
 *
 * ## 为什么要有
 *
 * `memory-injection-record.test.ts` 只记「注入了什么」。但 `memory-inject.ts` 有多条
 * 早退路径，它们一条都不留痕。将来拿 `used_chars` 标定预算时，缺失的恰是被跳过的轮次，
 * 样本会系统性地偏向「记忆总是够用」——天权在 2026-11-04 的三席评审里指出过这一点。
 *
 * ## 只记两种，不是五种
 *
 * 早退的路径有：非 enter decision、step 重放、messages 为空、query 过短、零命中。
 * 前三种属于「这一轮没有装配需求」（reject / 重放 / 空轮次），记下来只是噪声；
 * 后两种是「真的要装配但没装成」，才是有诊断价值的样本。所以只记 `query-too-short`
 * 与 `no-hit`。
 *
 * ## 落在同一条事件上，不新开 kind
 *
 * 复用 `injection.recorded`，payload 增加 `outcome: 'skipped'` 与 `reason`。
 * 理由：它们回答的是同一个问题（这一轮的装配结果是什么），拆成两种 kind 会让
 * 「按轮次看装配」需要 union 两条链的查询。已写的注入事件没有 `outcome` 字段，
 * 读取侧把缺失视为 `'injected'`——不做数据迁移，旧记录照样能读。
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

const enter = (messages: unknown[]): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })

function payloadOf(text: string, sessionId = 'sess-skip', turn = 1, step = 1) {
  return {
    agent: { session: { id: sessionId } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn,
    step,
  }
}

test('SK1 查询过短：留一条 skip 记录，写明原因与查询长度', async () => {
  const tmp = makeTmp('prts-injskip-short-')
  const store = MemoryStore.open(tmp.db())
  try {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      // 'ab' 两个字符 < minQueryChars 默认 4；库里其实有命中，但检索没发生。
      const payload = payloadOf('ab')
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(out.messages.length, 1, '前置条件：没有注入')

      const skipped = store.injectionRecords({ sessionId: 'sess-skip', outcome: 'skipped' })
      assert.equal(skipped.length, 1, '跳过也要留痕，否则将来标定预算的样本有方向性偏差')
      assert.equal(skipped[0]!.outcome, 'skipped')
      assert.equal(skipped[0]!.reason, 'query-too-short')
      assert.equal(skipped[0]!.turn, 1)
      assert.equal(skipped[0]!.step, 1)
      assert.equal(skipped[0]!.injected, 0, '跳过的轮次注入条数是 0，不是未知')
      assert.equal(skipped[0]!.usedChars, 0, '没装东西就是 0 字符')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('SK2 零命中：reason=no-hit', async () => {
  const tmp = makeTmp('prts-injskip-miss-')
  const store = MemoryStore.open(tmp.db())
  try {
    // 空库：查询够长，但库里什么都没有。
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('完全无关的新话题，库里没有任何对应记忆')
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(out.messages.length, 1, '前置条件：没有注入')

      const skipped = store.injectionRecords({ sessionId: 'sess-skip', outcome: 'skipped' })
      assert.equal(skipped.length, 1)
      assert.equal(skipped[0]!.reason, 'no-hit')
      assert.ok(skipped[0]!.limit >= 1, '记下本轮上限，才能解释「为什么一条都没有」')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('SK3 非 enter 的 decision 不写记录——那不是跳过，是没有装配需求', async () => {
  const tmp = makeTmp('prts-injskip-reject-')
  const store = MemoryStore.open(tmp.db())
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      await fake.fire(payloadOf('一个足够长的正常问题'), async () => ({ kind: 'reject' }))
      assert.equal(
        store.injectionRecords({ sessionId: 'sess-skip' }).length, 0,
        'reject 的轮次根本没有进入装配，记下来只是噪声',
      )
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('SK4 同一 step 重放不重复写 skip（waterfall 重试会对同一步触发多次）', async () => {
  const tmp = makeTmp('prts-injskip-replay-')
  const store = MemoryStore.open(tmp.db())
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('ab', 'sess-skip', 1, 3)
      const next = async () => enter([...payload.messages])
      await fake.fire(payload, next)
      await fake.fire(payload, next)
      const skipped = store.injectionRecords({ sessionId: 'sess-skip', outcome: 'skipped' })
      assert.equal(skipped.length, 1, '同一步重放只留一条')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('SK5 skip 记录写失败不阻断本轮（观测不得成为新的失败面）', async () => {
  const tmp = makeTmp('prts-injskip-broken-')
  const store = MemoryStore.open(tmp.db())
  try {
    let attempts = 0
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'recordInjection') {
          return () => { attempts++; throw new Error('chain write failed') }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as MemoryStore
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store: broken })
    try {
      const payload = payloadOf('ab')
      const out = await fake.fire(payload, async () => enter([...payload.messages])) as { messages: unknown[] }
      assert.equal(out.messages.length, 1, '本轮消息不得被改变')
      assert.equal(attempts, 1, '必须真的尝试过记录——否则这条用例对「写失败」零覆盖')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('SK6 旧事件没有 outcome 字段时按 injected 读（不做数据迁移）', async () => {
  const tmp = makeTmp('prts-injskip-legacy-')
  const store = MemoryStore.open(tmp.db())
  try {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      await fake.fire(payloadOf('我之前说过的光学偏好是什么？'), async () => enter([{ id: 'm1', role: 'user' }]))
      const injected = store.injectionRecords({ sessionId: 'sess-skip', outcome: 'injected' })
      assert.equal(injected.length, 1, '正常注入的轮次按 injected 归类')
      assert.equal(injected[0]!.outcome, 'injected')
      assert.equal(store.injectionRecords({ sessionId: 'sess-skip', outcome: 'skipped' }).length, 0)
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})
