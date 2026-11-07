/**
 * `prts_memory_summarize`：模型自主固化经验的入口。
 *
 * 这个工具是 `summarizeSession` 的**生产消费出口**——此前它只被 CLI 调用，
 * 模型碰不到。所以这里钉两条边界：拿不到 sessionId 必须 fail-closed（不能瞎写），
 * 以及摘要真的落到 `mem_summaries` 且能被检索到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { createMemoryTools } from '../../src/runtime/memory-tools.ts'
import { makeTmp } from '../support/tmp.ts'

interface Captured {
  name: string
  description: string
  parameters: { required?: string[] }
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
      const d = defs.get(name)
      if (d === undefined) throw new Error(`未注册的工具: ${name}（已注册 ${[...defs.keys()].join(',')}）`)
      return d
    },
  }
}

const fakeGenerator = (text: string) => async () => ({ model: 'fake', generate: async () => text })

test('MS1 prts_memory_summarize：模型调用后把当前会话压成摘要落库', async () => {
  const t = makeTmp('prts-sumtool-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    store.recordTurn({
      actor: 'owner', sessionId: 'sess-1', turnIndex: 0, speaker: 'owner',
      text: '给 task-c729fa72 补登记证据',
    })
    store.recordTurn({
      actor: 'model', sessionId: 'sess-1', turnIndex: 1, speaker: 'model',
      text: '两份证据已登记，任务进入 verifying，等你 /accept',
    })

    const { registry, get } = fakeRegistry()
    createMemoryTools(registry as never, {
      store,
      generator: fakeGenerator('任务 task-c729fa72 证据已登记，产物在 reference-audit/audit.md，状态 verifying，等 /accept。'),
    })

    const tool = get('prts_memory_summarize')
    const out = await tool.execute({}, { agent: { session: { id: 'sess-1' } } }) as {
      written?: boolean
      summaryId?: string
      turnCount?: number
    }

    assert.equal(out.written, true, `应写入摘要，实际 ${JSON.stringify(out)}`)
    assert.equal(out.turnCount, 2)
    assert.equal(store.countSummaries(), 1, '摘要应落库')

    const hits = store.search({ text: 'task-c729fa72', summaryQuota: 5 })
    assert.ok(
      hits.some((h) => h.kind === 'summary'),
      `摘要应能被检索到，实际 kinds=${hits.map((h) => h.kind).join(',')}`,
    )
  } finally {
    t.cleanup(store)
  }
})

test('MS2 拿不到 sessionId 时 fail-closed，不写库', async () => {
  const t = makeTmp('prts-sumtool-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    store.recordTurn({
      actor: 'owner', sessionId: 'sess-1', turnIndex: 0, speaker: 'owner', text: '你好',
    })
    const { registry, get } = fakeRegistry()
    createMemoryTools(registry as never, { store, generator: fakeGenerator('不该被写入') })
    const tool = get('prts_memory_summarize')

    // exec 缺失 / 形状不对：都不许瞎写
    for (const badExec of [undefined, {}, { agent: {} }, { agent: { session: {} } }]) {
      await assert.rejects(
        () => tool.execute({}, badExec),
        /会话/,
        `exec=${JSON.stringify(badExec)} 应拒绝`,
      )
    }
    assert.equal(store.countSummaries(), 0, '拒绝后不应有摘要')
  } finally {
    t.cleanup(store)
  }
})

test('MS3 会话没有 turn 时返回 written:false，不抛错', async () => {
  const t = makeTmp('prts-sumtool-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const { registry, get } = fakeRegistry()
    createMemoryTools(registry as never, { store, generator: fakeGenerator('不应生成') })
    const out = await get('prts_memory_summarize').execute({}, { agent: { session: { id: 'sess-empty' } } }) as {
      written?: boolean
    }
    assert.equal(out.written, false)
    assert.equal(store.countSummaries(), 0)
  } finally {
    t.cleanup(store)
  }
})

test('MS4 未注入 generator 时工具明确报不可用，不静默返回空', async () => {
  const t = makeTmp('prts-sumtool-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    store.recordTurn({
      actor: 'owner', sessionId: 'sess-1', turnIndex: 0, speaker: 'owner', text: '你好',
    })
    const { registry, get } = fakeRegistry()
    createMemoryTools(registry as never, { store })  // 不给 generator
    await assert.rejects(
      () => get('prts_memory_summarize').execute({}, { agent: { session: { id: 'sess-1' } } }),
      /生成器/,
    )
    assert.equal(store.countSummaries(), 0)
  } finally {
    t.cleanup(store)
  }
})
