/**
 * 多条到期提醒的折叠（`HANDOFF-20261103-session.md` 三-2 的未做项）。
 *
 * 现状把全部 due 拼成一条墙：5 条到期就是 5 段「你原定…（你当时说的是…）」，
 * 读的人要先在墙里找到最要紧的那条。折叠只改**显示**，不改触发：
 * 所有到期项照旧 markFired，不重复提醒是硬约束（C1 同时钉住这一点）。
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

/** 建 n 条同一时刻到期的意图，返回推进后的时钟。 */
function seedDue(store: MemoryStore, n: number, fireAt: number): void {
  for (let i = 1; i <= n; i++) {
    store.createIntent({
      actor: 'owner',
      conditionRaw: `${i} 分钟后`,
      action: `提醒事项 ${i}`,
      fireAtMs: fireAt,
    })
  }
}

async function fireText(
  hook: { fire: Handler },
  payload: Record<string, unknown>,
): Promise<string> {
  const out = await hook.fire(payload, async () => enter([{ id: 'm1' }])) as {
    messages: Array<{ content: Array<{ text?: string }> }>
  }
  return out.messages[1]?.content?.[0]?.text ?? ''
}

test('C1 超过上限时折叠：只展开前 3 条，其余折成「另有 N 条」，且全部标记 fired', async () => {
  const t = makeTmp('prts-itrig-collapse-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 5 * MIN
    seedDue(store, 5, fireAt)

    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + 1000
      const text = await fireText(hook, {})
      assert.equal((text.match(/\[提醒\]/g) ?? []).length, 3, '默认只展开 3 条，不能拼成一堵墙')
      assert.match(text, /另有 2 条/, '被折叠的条数要明说，否则用户以为只有 3 件事')
      // 新语义：注入只算「渲染」，装配器确认投递后才落 fired（markDelivered）。
      trig.markDelivered('')
      assert.equal(store.listIntents({ status: 'fired' }).length, 5, '折叠只改显示——5 条都必须标记 fired，否则下次重复提醒')

      // 同一步再触发不得二次注入（fired 集合与状态双保险）。
      const second = await hook.fire({}, async () => enter([{ id: 'm1' }])) as { messages: unknown[] }
      assert.equal(second.messages.length, 1, '已触发的不能再提醒一次')
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('C2 正好等于上限时不出现「另有」（折叠不能凭空造出剩余项）', async () => {
  const t = makeTmp('prts-itrig-exact-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 5 * MIN
    seedDue(store, 3, fireAt)

    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock })
    try {
      clock = fireAt + 1000
      const text = await fireText(hook, {})
      assert.equal((text.match(/\[提醒\]/g) ?? []).length, 3)
      assert.doesNotMatch(text, /另有/)
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})

test('C3 上限可配：maxVisible=1 时只展开 1 条', async () => {
  const t = makeTmp('prts-itrig-maxvisible-')
  const store = MemoryStore.open(t.db())
  try {
    let clock = Date.now()
    const fireAt = clock + 5 * MIN
    seedDue(store, 4, fireAt)

    const hook = fakeHookCtx()
    const trig = attachIntentTrigger(hook.ctx, { store, now: () => clock, maxVisible: 1 })
    try {
      clock = fireAt + 1000
      const text = await fireText(hook, {})
      assert.equal((text.match(/\[提醒\]/g) ?? []).length, 1)
      assert.match(text, /另有 3 条/)
    } finally { trig.dispose() }
  } finally { t.cleanup(store) }
})
