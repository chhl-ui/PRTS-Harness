/**
 * 记忆注入清单（工作区装配 ⑧ 的第一刀）：每轮注入留下可事后解释的记录。
 *
 * ## 只记「装了什么」，不决定「装多少」
 *
 * 架构需求 §5.3 把 ③预算 与 ⑧清单 列为两条。2026-11-04 三席评审（天权／天机／瑶光）
 * 一致认为：③ 的裁剪是唯一会改变模型可见内容、且退化不报错的动作，而 8000 字符这类
 * 缺省值在两端都不成立（对 `defaultContextWindow: 1000000` 形同虚设，对真实小窗口又过大）。
 * 所以先落 ⑧，把 `used_chars` 与命中构成记录下来——将来标定预算时用真实分布，而不是拍一个常量。
 *
 * ## 两条实现纪律（评审指出的 CRITICAL）
 *
 * 1. **`seen` 只登记真正进正文的命中**。现状 `memory-inject.ts` 的顺序是
 *    hits 选出 → `seen.add` → 渲染；一旦在 hits 之后裁剪，被裁条目会被永久记为「已注入」，
 *    该会话从此不再提它——静默失忆，无报错。本刀不做裁剪，测试 INJ1 用 hitIds 与正文对齐
 *    把这条钉住：将来加裁剪，这条断言会先红。
 * 2. **事件写失败不得阻断注入**。`fold.ts` 的 `default` 分支对未实现种类直接 throw，
 *    `appendEvent` 又在同一事务里同步调它；写事件若被包进外层 catch，注入会连带消失
 *    （I1 会红）。INJ4 用会抛错的 store 把这条钉住。
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

function payloadOf(text: string, sessionId = 'sess-record', turn = 1, step = 1) {
  return {
    agent: { session: { id: sessionId } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn,
    step,
  }
}

const enter = (messages: unknown[]): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })

function seeded(prefix: string): { store: MemoryStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp(prefix)
  const store = MemoryStore.open(tmp.db())
  store.assertFact({
    actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
    provenance: 'stated', confirmationBasis: 'owner-stated',
  })
  return { store, tmp }
}

/** 从注入后的 decision 里取出注入正文；没有注入则返回空串。 */
function injectedText(out: unknown): string {
  const messages = (out as { messages: Array<{ content?: Array<{ text?: string }> }> }).messages
  return messages[1]?.content?.[0]?.text ?? ''
}

test('INJ1 一次注入留下一条清单：条数、命中 id、用量与正文口径一致', async () => {
  const { store, tmp } = seeded('prts-injrec-base-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('我之前说过的光学偏好是什么？')
      const out = await fake.fire(payload, async () => enter([...payload.messages]))
      const text = injectedText(out)
      assert.match(text, /光学镜头设计/, '前置条件：本轮确实注入了记忆')

      const records = store.injectionRecords({ sessionId: 'sess-record' })
      assert.equal(records.length, 1, '一次注入写且只写一条清单')

      const r = records[0]!
      assert.equal(r.turn, 1)
      assert.equal(r.step, 1)
      assert.equal(r.injected, 1, '注入条数记的是真正进正文的命中数')
      assert.equal(r.hitIds.length, 1, 'hitIds 与 injected 必须一致——被丢弃的命中不得混进清单')
      assert.equal(
        r.usedChars, text.length,
        'usedChars 是渲染后正文的完整长度（含自报来源的 header）——预算口径必须与它同源，否则将来标定对不上',
      )
      assert.ok(r.usedChars > 0)
      assert.ok(r.limit >= 1, '记下本轮生效的条数上限，否则事后无法解释「为什么只有这几条」')
      assert.deepEqual(Object.keys(r.kinds), ['fact'], '命中种类分布也要留痕')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('INJ2 清单跨重启可读（不是进程内缓存）', async () => {
  const tmp = makeTmp('prts-injrec-restart-')
  const path = tmp.db()
  let store = MemoryStore.open(path)
  try {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    const payload = payloadOf('我的光学偏好是什么？')
    await fake.fire(payload, async () => enter([...payload.messages]))
    att.dispose()
    assert.equal(store.injectionRecords({ sessionId: 'sess-record' }).length, 1, '关闭前应能读到')

    store.close()
    store = MemoryStore.open(path)
    const after = store.injectionRecords({ sessionId: 'sess-record' })
    assert.equal(after.length, 1, '重开同一库后清单仍在——⑧ 要求的是可事后解释，不是可当下解释')
    assert.equal(after[0]!.injected, 1)
  } finally {
    tmp.cleanup(store)
  }
})

test('INJ3 没有命中时不产生「注入」记录（避免把「没装」记成「装入了 0 条」）', async () => {
  const tmp = makeTmp('prts-injrec-miss-')
  const store = MemoryStore.open(tmp.db())
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('完全无关的新话题，库里没有对应记忆')
      const out = await fake.fire(payload, async () => enter([...payload.messages]))
      assert.equal((out as { messages: unknown[] }).messages.length, payload.messages.length, '不该注入')
      // 2026-11-04 起零命中会留一条 `skipped` 记录（`memory-injection-skip.test.ts` SK2）：
      // 它是「诊断样本」，不是「装入了 0 条」。两种口径用 outcome 分开，别混着数。
      assert.equal(
        store.injectionRecords({ outcome: 'injected' }).length, 0,
        '没注入就不能出现在注入集合里',
      )
      const skipped = store.injectionRecords({ outcome: 'skipped' })
      assert.equal(skipped.length, 1, '跳过要留痕')
      assert.equal(skipped[0]!.reason, 'no-hit')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('INJ4 清单写失败不阻断注入（观测不得成为新的失败面）', async () => {
  const { store, tmp } = seeded('prts-injrec-broken-')
  try {
    // 只打坏记录写入，检索与渲染保持真实——这是「观测失败」的最真实形状。
    // 必须用 Proxy 而不是 `{...store}`：类是原型方法，展开只复制自有属性，
    // search 会变成 undefined（既有 I4 用例踩过这个坑），失败点就跑偏了。
    let recordAttempts = 0
    const broken = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'recordInjection') {
          return () => { recordAttempts++; throw new Error('chain write failed') }
        }
        return Reflect.get(target, prop, receiver)
      },
    }) as MemoryStore
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store: broken })
    try {
      const payload = payloadOf('我之前说过的光学偏好是什么？')
      const out = await fake.fire(payload, async () => enter([...payload.messages]))
      const text = injectedText(out)
      assert.equal((out as { messages: unknown[] }).messages.length, 2, '记录失败不得吞掉注入')
      assert.match(text, /光学镜头设计/, '正文照常送达模型')
      assert.equal(recordAttempts, 1, '必须真的尝试过记录——否则这条用例对「写失败」零覆盖')
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('INJ5 清单只留 id，不复制记忆正文（事件链不可变，正文不能跟着进去）', async () => {
  const { store, tmp } = seeded('prts-injrec-nobody-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('我之前说过的光学偏好是什么？')
      await fake.fire(payload, async () => enter([...payload.messages]))
      const r = store.injectionRecords({ sessionId: 'sess-record' })[0]!
      assert.equal(
        JSON.stringify(r).includes('光学镜头设计'), false,
        '清单落的是哈希链，正文一旦写入就删不掉；只留 id，取内容走投影',
      )
    } finally {
      att.dispose()
    }
  } finally {
    tmp.cleanup(store)
  }
})

test('INJ6 新事件种类不破坏记忆链，且投影重建能安全跳过它', async () => {
  const { store, tmp } = seeded('prts-injrec-chain-')
  try {
    const fake = fakeHookCtx()
    const att = attachMemoryInjection(fake.ctx, { store })
    try {
      const payload = payloadOf('我之前说过的光学偏好是什么？')
      await fake.fire(payload, async () => enter([...payload.messages]))
    } finally {
      att.dispose()
    }
    // 重放：fold.ts 若无该种类的分支会在这里抛「未实现的事件种类」。
    store.rebuildProjections()
    const chain = store.verifyChain()
    assert.equal(chain.ok, true, `注入清单必须落在链上且不破坏链：${JSON.stringify(chain)}`)
    const rows = store.injectionRecords({ sessionId: 'sess-record' })
    assert.equal(rows.length, 1, '投影重建不得删除既有清单事件')
  } finally {
    tmp.cleanup(store)
  }
})
