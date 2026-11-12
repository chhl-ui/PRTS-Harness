/**
 * 压缩决策接线（CA1—CA7）：把 `decideCompaction` 接到 `agent/pre-step`。
 *
 * 这一层只**观测与记录**，不改压缩行为——DSH 的 `compaction-basic` 照旧跑。
 * 目的是让「该压却没人压」这件事可见：DSH 的 `compactIfNeeded` 在
 * `requestHeader` / `routedTarget` 为空时静默 `return null`
 * （`dsh-compaction-basic/lib/index.js:932-935`），本层把同一时刻的决策写下来，
 * 两者一对就能看出静默跳过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachCompactionPolicy } from '../../src/runtime/compaction-policy-attach.ts'

interface Recorded {
  action: string
  reason?: string
  usedTokens?: number
  contextWindow?: number
}

/** 最小 hook ctx：只实现本模块用到的 `on`。 */
function fakeCtx() {
  const handlers: ((p: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
  return {
    on(_name: string, fn: (p: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void {
      handlers.push(fn)
      return () => { handlers.splice(handlers.indexOf(fn), 1) }
    },
    async dispatch(payload: unknown, decision: unknown): Promise<unknown> {
      assert.equal(handlers.length, 1, '必须恰好注册一个 handler')
      return handlers[0](payload, async () => decision)
    },
    count: () => handlers.length,
  }
}

/** 构造一个请求头形态的会话载荷。 */
function payloadWith(header: unknown, session: Record<string, unknown> = {}) {
  return { agent: { session: { id: 's1', requestHeader: () => header, ...session } }, turn: 1, step: 1 }
}

const CONFIG = { thresholdRatio: 0.8, outputReserve: 256, safetyMargin: 0, enabled: true }

test('CA1 请求头缺失 → 记 undetermined / capacity-unknown（DSH 静默跳过的那个场景）', async () => {
  const h = fakeCtx()
  const seen: Recorded[] = []
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 9999,
    resolveWindow: async () => 2000,
    record: (r) => { seen.push(r) },
  })
  await h.dispatch(payloadWith(undefined), { kind: 'enter', messages: [] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].action, 'undetermined')
  assert.equal(seen[0].reason, 'capacity-unknown')
})

test('CA2 窗口已知、已用超阈值 → 记 compact', async () => {
  const h = fakeCtx()
  const seen: Recorded[] = []
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 900,
    resolveWindow: async () => 1000,
    record: (r) => { seen.push(r) },
  })
  await h.dispatch(payloadWith({ config: { provider: 'p', model: 'm' } }), { kind: 'enter', messages: [] })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].action, 'compact')
})

test('CA3 未到阈值 → 记 skip / below-threshold', async () => {
  const h = fakeCtx()
  const seen: Recorded[] = []
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 100,
    resolveWindow: async () => 1000,
    record: (r) => { seen.push(r) },
  })
  await h.dispatch(payloadWith({ config: { provider: 'p', model: 'm' } }), { kind: 'enter', messages: [] })
  assert.equal(seen[0].action, 'skip')
  assert.equal(seen[0].reason, 'below-threshold')
})

test('CA4 取不到窗口（resolveWindow 抛错）→ undetermined / capacity-unknown，不炸回合', async () => {
  const h = fakeCtx()
  const seen: Recorded[] = []
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 100,
    resolveWindow: async () => { throw new Error('boom') },
    record: (r) => { seen.push(r) },
  })
  const out = await h.dispatch(payloadWith({ config: { provider: 'p', model: 'm' } }), { kind: 'enter', messages: [] })
  assert.deepEqual(out, { kind: 'enter', messages: [] }, '决策失败不得改变本轮回合')
  assert.equal(seen[0].action, 'undetermined')
  assert.equal(seen[0].reason, 'capacity-unknown')
})

test('CA5 record 抛错 → 不影响本轮回合', async () => {
  const h = fakeCtx()
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 900,
    resolveWindow: async () => 1000,
    record: () => { throw new Error('record boom') },
  })
  const out = await h.dispatch(payloadWith({ config: { provider: 'p', model: 'm' } }), { kind: 'enter', messages: [] })
  assert.deepEqual(out, { kind: 'enter', messages: [] })
})

test('CA6 reject 的回合不记录（没有装配就没有压缩可谈）', async () => {
  const h = fakeCtx()
  const seen: Recorded[] = []
  attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 900,
    resolveWindow: async () => 1000,
    record: (r) => { seen.push(r) },
  })
  await h.dispatch(payloadWith({ config: { provider: 'p', model: 'm' } }), { kind: 'reject' })
  assert.equal(seen.length, 0)
})

test('CA7 dispose 后 handler 解绑', () => {
  const h = fakeCtx()
  const handle = attachCompactionPolicy(h as never, {
    config: CONFIG,
    measure: () => 0,
    resolveWindow: async () => 1000,
    record: () => {},
  })
  assert.equal(h.count(), 1)
  handle.dispose()
  assert.equal(h.count(), 0)
})
