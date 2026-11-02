/**
 * 记忆检索工具（`prts_memory_recall`）的单元测试。
 *
 * 这个工具是记忆模块唯一的**生产消费出口**——此前 `search()` 在 `src/` 内零调用方。
 * 所以这里钉的不只是「工具能返回结果」，还有三条挡住静默失效的边界：
 * 空 query 必须响、limit 必须有上限、benchmark 数据不得进生产检索。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore } from '../../src/memory/index.ts'
import { createMemoryTools } from '../../src/runtime/memory-tools.ts'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface Captured {
  name: string
  description: string
  parameters: { required?: string[]; properties?: Record<string, unknown> }
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
      if (d === undefined) throw new Error(`工具未注册：${name}`)
      return d
    },
  }
}

function seededStore(prefix: string): { store: MemoryStore; cleanup: () => void } {
  const t = makeTmp(prefix)
  const store = MemoryStore.open(t.db())
  return {
    store,
    cleanup: () => t.cleanup(store),
  }
}

test('MT1 注册 prts_memory_recall，命中事实后返回文本与时间', async () => {
  const { store, cleanup } = seededStore('prts-memtool-')
  try {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    try {
      assert.deepEqual([...tools.names], ['prts_memory_recall'])
      assert.deepEqual(fake.get('prts_memory_recall').parameters.required, ['query'])

      const out = await fake.get('prts_memory_recall').execute({ query: '光学' }) as {
        message: string
        hits: Array<{ kind: string; text: string; occurredAt: string | null; score: number }>
      }
      assert.match(out.message, /命中 1 条/)
      assert.match(out.message, /光学镜头设计/)
      assert.equal(out.hits.length, 1)
      assert.equal(out.hits[0]?.kind, 'fact')
      assert.equal(out.hits[0]?.text, '光学镜头设计')
      // 时间必须带上：没有时间的记忆无法回答「多少天前」
      assert.ok(out.hits[0]?.occurredAt === null || typeof out.hits[0]?.occurredAt === 'string')
      assert.equal(typeof out.hits[0]?.score, 'number')
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})

test('MT2 空 query 抛错，不静默返回空结果', async () => {
  const { store, cleanup } = seededStore('prts-memtool-empty-')
  try {
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    try {
      const exec = fake.get('prts_memory_recall').execute
      await assert.rejects(() => exec({}), /query 不能为空/)
      await assert.rejects(() => exec({ query: '   ' }), /query 不能为空/)
      await assert.rejects(() => exec({ query: 42 }), /query 不能为空/)
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})

test('MT3 limit 上限 20：要 100 条也不会超过 20', async () => {
  const { store, cleanup } = seededStore('prts-memtool-limit-')
  try {
    for (let i = 0; i < 25; i++) {
      store.assertFact({
        actor: 'owner', subject: '博士', predicate: '测试', object: `光学条目 ${i}`,
        provenance: 'stated', confirmationBasis: 'owner-stated',
      })
    }
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    try {
      const exec = fake.get('prts_memory_recall').execute
      const big = await exec({ query: '光学', limit: 100 }) as { hits: unknown[] }
      // 注意：store 内部有 factQuota（默认 ceil(limit/2)），所以「20」是上限不是承诺条数；
      // 精确名额语义由 test/memory/quota.test.ts 钉住，这里只验上限没被突破。
      assert.ok(big.hits.length <= 20, `要 100 条不能超过 20，实际 ${big.hits.length}`)
      assert.ok(big.hits.length > 0, '25 条同词事实不该一条都召回不了')
      const small = await exec({ query: '光学', limit: 3 }) as { hits: unknown[] }
      assert.ok(small.hits.length <= 3, `要 3 条不能超过 3，实际 ${small.hits.length}`)
      // 非法 limit 被夹到下限 1，而不是报错或返回全部
      const floor = await exec({ query: '光学', limit: 0 }) as { hits: unknown[] }
      assert.equal(floor.hits.length, 1)
      const nan = await exec({ query: '光学', limit: Number.NaN }) as { hits: unknown[] }
      assert.ok(nan.hits.length > 0 && nan.hits.length <= 8, 'NaN 退回默认 8')
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})

test('MT4 benchmark 数据不进生产检索（工具面第二道闸）', async () => {
  const { store, cleanup } = seededStore('prts-memtool-origin-')
  try {
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '光学镜头设计',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    store.assertFact({
      actor: 'system', subject: '基准', predicate: '含', object: '光学仪器校准',
      provenance: 'stated', confirmationBasis: 'owner-stated', origin: 'benchmark',
    })
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    try {
      const out = await fake.get('prts_memory_recall').execute({ query: '光学' }) as {
        hits: Array<{ text: string }>
      }
      assert.equal(out.hits.length, 1)
      assert.equal(out.hits[0]?.text, '光学镜头设计', 'benchmark 的「光学仪器校准」不得出现')
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})

test('MT5 无命中时明确说明，而不是给一段空正文', async () => {
  const { store, cleanup } = seededStore('prts-memtool-miss-')
  try {
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    try {
      const out = await fake.get('prts_memory_recall').execute({ query: '完全不存在的词' }) as {
        message: string
        hits: unknown[]
      }
      assert.equal(out.hits.length, 0)
      assert.match(out.message, /没有命中/)
      assert.match(out.message, /换一组关键词/, '要给出下一步动作，否则模型只会放弃')
    } finally {
      tools.dispose()
    }
  } finally {
    cleanup()
  }
})

test('MT6 dispose 注销工具', () => {
  const { store, cleanup } = seededStore('prts-memtool-dispose-')
  try {
    const fake = fakeRegistry()
    const tools = createMemoryTools(fake.registry, { store })
    assert.equal(tools.names.length, 1)
    tools.dispose()
    assert.equal(tools.names.length, 0)
    assert.throws(() => fake.get('prts_memory_recall'), /工具未注册/)
  } finally {
    cleanup()
  }
})

test('MT7 端到端：运行时注册了工具，模型调用后对话正常完成且记忆落盘', { timeout: 180000 }, async () => {
  const t = makeTmp('prts-memtool-e2e-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    // 接线生效的硬证据：工具名来自注册回执，不是文档里的手写常量
    assert.ok(
      app.toolNames.includes('prts_memory_recall'),
      `工具未注册到运行时，实际注册：${app.toolNames.join(', ')}`,
    )

    const script: ScriptedStep[] = [
      { text: '记下了。' },
      { toolCalls: [{ name: 'prts_memory_recall', arguments: { query: '光学' } }] },
      { text: '你偏好光学镜头设计。' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('我偏好光学镜头设计', '我之前说过偏好什么？', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
      sessionId: 'sess-mem',
      ledger: app.ledger,
    })

    // 两轮对话的 user/assistant 都应落进记忆库——写入路径与读取路径同时在场，
    // 这是「记忆模块在生产链路上真的被消费」的最小证据。
    const db = new DatabaseSync(join(dataRoot, 'memory.sqlite'), { readOnly: true })
    try {
      const row = db.prepare('SELECT count(*) c FROM mem_turns').get() as { c: number }
      assert.ok(row.c >= 3, `两轮对话至少 3 条 turn（user+assistant+user），实际 ${row.c}`)
      const texts = (db.prepare(
        'SELECT b.body FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref ORDER BY t.rowid',
      ).all() as Array<{ body: string }>).map((r) => r.body)
      assert.ok(texts.some((x) => x.includes('光学镜头设计')), `记忆里应有原始对话，实际：${texts.join(' | ')}`)
    } finally {
      db.close()
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('MT8 embedder 在场时 queryVector 进 search：语义命中出现在工具结果里', async () => {
  const { store, cleanup } = seededStore('prts-mt8-')
  try {
    const tid = store.recordTurn({
      actor: 'system', sessionId: 'old', turnIndex: 0, speaker: 'user',
      text: '书房的绿萝该浇水了', occurredAtMs: Date.now(),
    })
    store.putVectors([{ ownerKind: 'turn', ownerId: tid, vector: [1, 0, 0, 0] }], 'fake-embed')
    const embedder = async () => ({ model: 'fake-embed', embed: async () => [[1, 0, 0, 0]] })

    const reg = fakeRegistry()
    createMemoryTools(reg.registry, { store, embedder })
    const tool = reg.get('prts_memory_recall')
    // 查询与正文零共享 token：字面路必不中，命中只能来自向量路。
    const r = await tool.execute({ query: '阳台的花盆怎么选' }) as { message: string }
    assert.ok(r.message.includes('绿萝'), `语义命中应出现在工具消息里：${r.message}`)
  } finally { cleanup() }
})

test('MT9 embedder 抛错：工具照常返回字面结果，不吞可用性', async () => {
  const { store, cleanup } = seededStore('prts-mt9-')
  try {
    store.recordTurn({
      actor: 'system', sessionId: 'old', turnIndex: 0, speaker: 'user',
      text: '光学镜头设计偏好 85mm', occurredAtMs: Date.now(),
    })
    const broken = async () => { throw new Error('ollama down') }
    const reg = fakeRegistry()
    createMemoryTools(reg.registry, { store, embedder: broken })
    const r = await reg.get('prts_memory_recall').execute({ query: '光学镜头' }) as { message: string }
    assert.ok(r.message.includes('85mm'), 'embedder 挂时字面命中照常返回')
  } finally { cleanup() }
})
