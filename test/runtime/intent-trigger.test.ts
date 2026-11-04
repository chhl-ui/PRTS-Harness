/**
 * V1-14 · W3：触发注入（方案 B）。
 *
 * 判定的是「到期后是否触发」与「补发时是否如实告知延迟」两条验收。
 * 时间靠注入的 `now()` 推进，不真等待——真实时钟在测试里既慢又不可复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { attachIntentTrigger } from '../../src/runtime/intent-trigger.ts'
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

const MIN = 60_000

test('G1 到点的意图在 pre-step 注入，正文含动作与用户原话', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 5 * MIN
    store.createIntent({ actor: 'owner', conditionRaw: '五分钟后', action: '提醒我关火', fireAtMs: fireAt })

    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + 1000 // 到点后 1 秒
      const out = await hook.fire({}, async () => enter([{ id: 'm1' }])) as {
        messages: Array<{ role: string; content: Array<{ text?: string }> }>
      }
      assert.equal(out.messages.length, 2, '原消息 + 提醒')
      const text = out.messages[1].content[0].text ?? ''
      assert.match(text, /提醒我关火/, '必须包含要做的事')
      assert.match(text, /五分钟后/, '原话要回显，用户才能核对时间换算')
      assert.doesNotMatch(text, /补发/, '1 秒延迟不算补发')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('G2 同一条意图不会重复注入', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 2 * MIN
    store.createIntent({ actor: 'owner', conditionRaw: '一分钟后', action: 'A', fireAtMs: fireAt })
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + 1000
      const first = await hook.fire({}, async () => enter([{ id: 'm1' }])) as { messages: unknown[] }
      assert.equal(first.messages.length, 2)
      // 新语义：注入只算「渲染」，装配器确认投递后才落 fired（markDelivered）。
      trig.markDelivered('')
      const second = await hook.fire({}, async () => enter([{ id: 'm2' }])) as { messages: unknown[] }
      assert.equal(second.messages.length, 1, '已触发的不能再提醒一次')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('G3 未到点不注入，到点后才注入', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 10 * MIN
    store.createIntent({ actor: 'owner', conditionRaw: '十分钟后', action: 'B', fireAtMs: fireAt })
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      const early = await hook.fire({}, async () => enter([{ id: 'm1' }])) as { messages: unknown[] }
      assert.equal(early.messages.length, 1, '没到点不能提前打扰')
      clock = fireAt
      const onTime = await hook.fire({}, async () => enter([{ id: 'm2' }])) as { messages: unknown[] }
      assert.equal(onTime.messages.length, 2)
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('G4 延迟超过阈值时按「补发」措辞，并说明晚了多久', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 2 * MIN
    store.createIntent({ actor: 'owner', conditionRaw: '两分钟后', action: '交报告', fireAtMs: fireAt })
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock, lateThresholdMs: MIN })
    try {
      clock = fireAt + 3 * 60 * MIN // 晚了 3 小时
      const out = await hook.fire({}, async () => enter([{ id: 'm1' }])) as {
        messages: Array<{ content: Array<{ text?: string }> }>
      }
      const text = out.messages[1].content[0].text ?? ''
      assert.match(text, /补发/, '迟到的提醒必须自报延迟，不能假装是准点')
      assert.match(text, /晚了\s*3\s*小时/, '要说清晚了多久')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('G5 已取消的意图永不注入', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 2 * MIN
    const id = store.createIntent({ actor: 'owner', conditionRaw: '一分钟后', action: 'C', fireAtMs: fireAt })
    store.cancelIntent({ actor: 'owner', intentId: id })
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + MIN
      const out = await hook.fire({}, async () => enter([{ id: 'm1' }])) as { messages: unknown[] }
      assert.equal(out.messages.length, 1, '取消的不许触发')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('G6 重启后补触发：新实例扫描到过期意图并标记为 fired', async () => {
  const t = makeTmp('prts-itrig-')
  const path = t.db()
  let clock = Date.now()
  const fireAt = clock + 2 * MIN
  const first = MemoryStore.open(path)
  try {
    first.createIntent({ actor: 'owner', conditionRaw: '一分钟后', action: 'D', fireAtMs: fireAt })
  } finally { first.close() }

  // 「重启」：进程关闭期间到点了
  clock = fireAt + 10 * MIN
  const second = MemoryStore.open(path)
  try {
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store: second, now: () => clock })
    try {
      const out = await hook.fire({}, async () => enter([{ id: 'm1' }])) as { messages: unknown[] }
      assert.equal(out.messages.length, 2, '重启后的第一次交互必须补发')
      trig.markDelivered('')
      assert.equal(second.listIntents({ status: 'fired' }).length, 1, '投递确认后状态要落到 fired')
      assert.equal(second.dueIntents(clock).length, 0)
    } finally { trig.dispose() }
  } finally { second.close(); t.cleanup() }
})

test('G7 决策为 reject 时不注入（不能往被拒绝的回合里塞消息）', async () => {
  const t = makeTmp('prts-itrig-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 2 * MIN
    store.createIntent({ actor: 'owner', conditionRaw: '一分钟后', action: 'E', fireAtMs: fireAt })
    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + 1000
      const out = await hook.fire({}, async () => ({ kind: 'reject' })) as { kind: string }
      assert.equal(out.kind, 'reject')
      assert.equal(store.dueIntents(clock).length, 1, '没注入就不能标记已触发')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})
