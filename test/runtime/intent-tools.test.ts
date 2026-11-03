/**
 * V1-14 · W2：模型侧意图工具。
 *
 * 只测两条边界里最容易出错的部分：**时间**（无时区串会按本机时区解释、过去时刻要被
 * 闸门拦住）与**原话回显**（模型算错时间时，用户得能从回执里看出来）。
 * 取消不在模型面——它是所有者动作，见 `docs/design-intent-memory-v1-14.md`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { createIntentTools } from '../../src/runtime/intent-tools.ts'
import { makeTmp } from '../support/tmp.ts'

interface Captured {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function fakeRegistry(): { registry: { register(d: unknown): () => void }; get(name: string): Captured } {
  const defs = new Map<string, Captured>()
  return {
    registry: {
      register(d: unknown): () => void {
        const def = d as Captured
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    get(name: string): Captured {
      const def = defs.get(name)
      if (def === undefined) throw new Error(`未注册 ${name}`)
      return def
    },
  }
}

const HOUR = 3_600_000

test('T1 create 建意图，回执回显用户原话与绝对时刻', async () => {
  const t = makeTmp('prts-itool-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeRegistry()
    const tools = createIntentTools(fake.registry, { store })
    try {
      const fireAt = new Date(Date.now() + 3 * HOUR)
      const out = await fake.get('prts_intent_create').execute({
        action: '提醒我交报告',
        fire_at_iso: fireAt.toISOString(),
        condition_raw: '三天后',
      }) as { message: string; intentId: string; fireAtIso: string }

      assert.match(out.message, /提醒我交报告/)
      assert.match(out.message, /三天后/, '原话必须回显——模型换算错时用户要能看出来')
      assert.equal(out.fireAtIso, fireAt.toISOString())
      assert.equal(store.listIntents().length, 1)
      assert.equal(store.listIntents()[0].conditionRaw, '三天后')
    } finally { tools.dispose() }
  } finally { t.cleanup(store) }
})

test('T2 缺时区的 fire_at_iso 必须拒绝（否则按本机时区解释，时刻整体偏移）', async () => {
  const t = makeTmp('prts-itool-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeRegistry()
    const tools = createIntentTools(fake.registry, { store })
    try {
      await assert.rejects(
        () => fake.get('prts_intent_create').execute({
          action: 'x',
          fire_at_iso: '2026-11-06T15:00:00',
          condition_raw: '三天后',
        }),
        /时区/,
      )
      assert.equal(store.listIntents().length, 0, '被拒绝的不能落库')
    } finally { tools.dispose() }
  } finally { t.cleanup(store) }
})

test('T3 过去时刻被 store 的时间闸门拦住', async () => {
  const t = makeTmp('prts-itool-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeRegistry()
    const tools = createIntentTools(fake.registry, { store })
    try {
      await assert.rejects(
        () => fake.get('prts_intent_create').execute({
          action: 'x',
          fire_at_iso: new Date(Date.now() - HOUR).toISOString(),
          condition_raw: '昨天',
        }),
        /未来/,
      )
      assert.equal(store.listIntents().length, 0)
    } finally { tools.dispose() }
  } finally { t.cleanup(store) }
})

test('T4 list 默认只列 pending，并把时刻格式化成 ISO', async () => {
  const t = makeTmp('prts-itool-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeRegistry()
    const tools = createIntentTools(fake.registry, { store })
    try {
      const now = Date.now()
      const id = store.createIntent({
        actor: 'owner', conditionRaw: '三天后', action: 'A', fireAtMs: now + 3 * HOUR,
      })
      store.createIntent({ actor: 'owner', conditionRaw: '明天', action: 'B', fireAtMs: now + HOUR })
      const gone = store.createIntent({ actor: 'owner', conditionRaw: '五天后', action: 'C', fireAtMs: now + 5 * HOUR })
      store.cancelIntent({ actor: 'owner', intentId: gone })

      const out = await fake.get('prts_intent_list').execute({}) as {
        count: number
        intents: Array<{ intentId: string; action: string; fireAtIso: string; status: string }>
      }
      assert.equal(out.count, 2, '取消的不能出现在默认列表里')
      assert.ok(out.intents.every((i) => i.status === 'pending'))
      assert.ok(out.intents.some((i) => i.intentId === id))
      assert.match(out.intents[0].fireAtIso, /^\d{4}-\d{2}-\d{2}T/, '时刻要给 ISO，不能让模型自己猜格式')

      const cancelled = await fake.get('prts_intent_list').execute({ status: 'cancelled' }) as { count: number }
      assert.equal(cancelled.count, 1)
    } finally { tools.dispose() }
  } finally { t.cleanup(store) }
})

test('T5 缺 action 或 condition_raw 时拒绝，不产生半条意图', async () => {
  const t = makeTmp('prts-itool-')
  const store = MemoryStore.open(t.db())
  try {
    const fake = fakeRegistry()
    const tools = createIntentTools(fake.registry, { store })
    try {
      const iso = new Date(Date.now() + HOUR).toISOString()
      await assert.rejects(
        () => fake.get('prts_intent_create').execute({ action: '', fire_at_iso: iso, condition_raw: '三天后' }),
        /action/,
      )
      await assert.rejects(
        () => fake.get('prts_intent_create').execute({ action: 'x', fire_at_iso: iso, condition_raw: '' }),
        /condition_raw/,
      )
      assert.equal(store.listIntents().length, 0)
    } finally { tools.dispose() }
  } finally { t.cleanup(store) }
})
