/**
 * Wave 1 装配器（`src/runtime/assembly.ts`）的验收测试。
 *
 * 背景：七条 `agent/pre-step` 注入链各自独立注册（`src/runtime/start.ts:807/817/827/859/877/886/903`），
 * 每条先 `await next()` 再往 `decision.messages` 追加。Cordis 的 waterfall 是
 * 「先注册 = 最外层」（`node_modules/@deepseek-ai/cordis/src/events.ts:234-243`），
 * 所以装配器必须**最先注册**，它的 `next()` 返回时能看到其余七条链的全部追加。
 *
 * 判据（来自 `.rivet/plans/prts-后续建设方案-2026-11-04.md` Wave 1）：
 * - 七条链的消息都能被识别（按 id 前缀）；
 * - 总注入 token 超预算时按优先级整链裁剪，且 memory 最后被裁；
 * - 写一条装配清单（`chain: 'assembly'`），chains 数组含七个链标识；
 * - 不传预算时不裁（默认行为不变）。
 *
 * 这个测试自带一个**按生产语义实现**的 mini waterfall harness（注册序 = 外层到内层），
 * 不是「单 handler fake ctx」——否则测不到装配器真正依赖的顺序语义。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { attachAssembly } from '../../src/runtime/assembly.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }
type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** 生产等价的 waterfall：先注册者在外层，next() 推进到下一个注册者。 */
function makeHookCtx() {
  const handlers: Handler[] = []
  return {
    ctx: {
      on(_name: string, fn: Handler): () => void {
        handlers.push(fn)
        return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) }
      },
    },
    async dispatch(payload: unknown): Promise<Decision> {
      let i = 0
      const next = (): Promise<unknown> => {
        const h = handlers[i++]
        if (h === undefined) {
          // 生产里的内置 next 返回本轮已认领的用户消息（dsh-agent-loop lib/index.js:913-920）。
          const claimed = (payload as { messages?: unknown[] }).messages ?? []
          return Promise.resolve({ kind: 'enter', messages: [...claimed] })
        }
        return h(payload, next)
      }
      return await next() as Decision
    },
  }
}

/** 模拟一条注入链：先 next()，再追加一条带自己 id 前缀的消息。 */
function chain(prefix: string, text: string): Handler {
  return async (_payload, next) => {
    const decision = await next() as Decision
    if (decision.kind !== 'enter') return decision
    return {
      ...decision,
      messages: [...decision.messages, { id: `${prefix}-x`, role: 'user', content: [{ type: 'text', text }] }],
    }
  }
}

const CHAINS: { chain: string; prefix: string; text: string }[] = [
  { chain: 'memory', prefix: 'mem', text: 'm'.repeat(200) },
  { chain: 'session-recall', prefix: 'recall', text: 'r'.repeat(200) },
  { chain: 'proactive', prefix: 'proactive', text: 'p'.repeat(200) },
  { chain: 'emotion', prefix: 'mood', text: 'e'.repeat(200) },
  { chain: 'skill', prefix: 'skill', text: 's'.repeat(200) },
  { chain: 'task-reminder', prefix: 'task-reminder', text: 't'.repeat(200) },
  { chain: 'intent', prefix: 'intent', text: 'i'.repeat(200) },
]

function setup(opts: { budget?: number; records: unknown[] }) {
  const hook = makeHookCtx()
  // 装配器最先注册 → 最外层。
  const assembly = attachAssembly(hook.ctx as never, {
    ...(opts.budget === undefined ? {} : { budget: { maxTokens: opts.budget } }),
    record: (input) => { opts.records.push(input) },
  })
  for (const c of CHAINS) hook.ctx.on('agent/pre-step', chain(c.prefix, c.text))
  return { hook, assembly }
}

test('A1 无预算：七条链的消息全部保留，清单记下七个 chain', async () => {
  const records: unknown[] = []
  const { hook, assembly } = setup({ records })
  const decision = await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [{ id: 'u1' }] })
  assembly.dispose()

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.kind === 'enter' ? decision.messages.length : -1, 8, '用户消息 + 七条注入')
  assert.equal(records.length, 1, '一次装配写一条清单')

  const r = records[0] as { chain?: string; chains?: string[]; outcome?: string }
  assert.equal(r.chain, 'assembly')
  assert.deepEqual([...(r.chains ?? [])].sort(), CHAINS.map((c) => c.chain).sort())
  assert.equal(r.outcome, 'injected')
})

test('A2 超预算：按优先级整链裁剪，memory 保留', async () => {
  // 每条 200 字符 ≈ 100 token；预算只够 3 条（300）。
  const records: unknown[] = []
  const { hook, assembly } = setup({ budget: 300, records })
  const decision = await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [{ id: 'u1' }] })
  assembly.dispose()

  assert.equal(decision.kind, 'enter')
  const kept = decision.kind === 'enter' ? decision.messages : []
  const ids = kept.map((m) => String((m as { id?: string }).id))
  assert.ok(ids.includes('u1'), '用户消息不能被动')
  assert.ok(ids.includes('mem-x'), 'memory 是最高优先级，最后才裁')
  assert.ok(!ids.includes('proactive-x'), 'proactive 最先被裁')
  assert.ok(kept.length <= 4, `保留条数应 <= 4（用户 + 3 条注入），实际 ${kept.length}`)

  const r = records[0] as { chains?: string[]; droppedChains?: string[] }
  assert.ok((r.droppedChains ?? []).length > 0, '清单要记下被裁的链')
})

test('A3 预算够用：不裁任何链', async () => {
  const records: unknown[] = []
  const { hook, assembly } = setup({ budget: 100000, records })
  const decision = await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [{ id: 'u1' }] })
  assembly.dispose()

  assert.equal(decision.kind === 'enter' ? decision.messages.length : -1, 8)
  const r = records[0] as { droppedChains?: string[] }
  assert.deepEqual(r.droppedChains ?? [], [])
})

test('A4 清单写入失败不影响本轮装配', async () => {
  const hook = makeHookCtx()
  const assembly = attachAssembly(hook.ctx as never, {
    record: () => { throw new Error('disk full') },
  })
  for (const c of CHAINS) hook.ctx.on('agent/pre-step', chain(c.prefix, c.text))
  const decision = await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [{ id: 'u1' }] })
  assembly.dispose()

  assert.equal(decision.kind === 'enter' ? decision.messages.length : -1, 8, '记录失败不能吃掉注入')
})

test('A5 非注入消息不被误裁（id 不匹配任何前缀）', async () => {
  const records: unknown[] = []
  const { hook, assembly } = setup({ budget: 1, records })
  const decision = await hook.dispatch({
    agent: { session: { id: 's1' } }, turn: 1, step: 0,
    messages: [{ id: 'u1' }, { id: 'runtime-context' }],
  })
  assembly.dispose()

  assert.equal(decision.kind, 'enter')
  const ids = (decision.kind === 'enter' ? decision.messages : []).map((m) => String((m as { id?: string }).id))
  assert.ok(ids.includes('u1'), '用户消息不能动')
  assert.ok(ids.includes('runtime-context'), '非注入消息不能动')
  assert.ok(!ids.includes('mem-x'), '预算 1 token 连 memory 也放不下')
})

test('A6 onDelivered 只报裁剪后仍保留的链', async () => {
  const delivered: { chains: readonly string[]; sessionId: string }[] = []
  const hook = makeHookCtx()
  const assembly = attachAssembly(hook.ctx as never, {
    budget: { maxTokens: 300 },
    onDelivered: (chains, sessionId) => { delivered.push({ chains, sessionId }) },
  })
  for (const c of CHAINS) hook.ctx.on('agent/pre-step', chain(c.prefix, c.text))
  await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [{ id: 'u1' }] })
  assembly.dispose()

  assert.equal(delivered.length, 1, '一次装配一次投递确认')
  assert.equal(delivered[0]?.sessionId, 's1')
  assert.ok(!delivered[0]?.chains.includes('proactive'), '被裁的链不能报已投递')
  assert.ok(delivered[0]?.chains.includes('memory'), '保留的链要报')
})

test('A7 上游 reject 时 onDelivered 不触发（reject 回合不能记成已投递）', async () => {
  let called = 0
  const hook = makeHookCtx()
  const assembly = attachAssembly(hook.ctx as never, {
    onDelivered: () => { called += 1 },
  })
  hook.ctx.on('agent/pre-step', async () => ({ kind: 'reject' }))
  const d = await hook.dispatch({ agent: { session: { id: 's1' } }, turn: 1, step: 0, messages: [] })
  assembly.dispose()

  assert.equal((d as { kind: string }).kind, 'reject')
  assert.equal(called, 0, 'reject 路径不得触发 onDelivered')
})
