/**
 * `prts_session_recall`：模型主动回看历史会话。
 *
 * 与已有能力的分工：
 * - `session-recall.ts` 是**自动注入**（7 天内 3 条，开场用），模型不能选
 * - `prts_memory_recall` 是**按语义搜**，跨会话，不知道「有哪些会话」
 * - 本工具补的是「先知道有哪些，再读具体哪一段」
 *
 * 数据源是记忆库的 turn（`start.ts:753/804` 每次对话都 recordTurn，库是会话镜像），
 * 所以不需要 dataRoot，也不需要读 session.v4.jsonl。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { createSessionTools } from '../../src/runtime/session-tools.ts'
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
      const d = defs.get(name)
      if (d === undefined) throw new Error(`未注册的工具: ${name}（已注册 ${[...defs.keys()].join(',')}）`)
      return d
    },
  }
}

function seed(store: MemoryStore): void {
  const base = Date.UTC(2026, 10, 7, 10, 0, 0)
  const rows: Array<[string, number, string, string, number]> = [
    ['sess-old', 0, 'owner', '给 task-c729fa72 补登记证据', base - 86_400_000],
    ['sess-old', 1, 'model', '两份证据已登记，任务进入 verifying', base - 86_400_000 + 1000],
    ['sess-new', 0, 'owner', '把 40 份档案换成真实会话', base],
    ['sess-new', 1, 'model', '档案数据链路已摸清', base + 1000],
    ['sess-new', 2, 'owner', '先做 archive', base + 2000],
  ]
  for (const [sessionId, turnIndex, speaker, text, occurredAtMs] of rows) {
    store.recordTurn({
      actor: speaker === 'owner' ? 'owner' : 'model',
      sessionId, turnIndex, speaker, text, occurredAtMs,
    })
  }
}

test('SR1 不给 sessionId：列出历史会话，带轮数与首条消息', async () => {
  const t = makeTmp('prts-sessrecall-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(store)
    const { registry, get } = fakeRegistry()
    createSessionTools(registry as never, { store })

    const out = await get('prts_session_recall').execute({}) as {
      sessions?: Array<{ sessionId: string; turnCount: number; firstText?: string }>
    }
    assert.ok(Array.isArray(out.sessions), `应返回 sessions 数组，实际 ${JSON.stringify(out)}`)
    assert.equal(out.sessions.length, 2, '应列出两个会话')
    const ids = out.sessions.map((s) => s.sessionId).sort()
    assert.deepEqual(ids, ['sess-new', 'sess-old'])
    const newest = out.sessions.find((s) => s.sessionId === 'sess-new')
    assert.equal(newest?.turnCount, 3, 'sess-new 有 3 轮')
    assert.ok(
      typeof newest?.firstText === 'string' && newest.firstText.includes('40 份档案'),
      `首条消息应可见，实际 ${JSON.stringify(newest?.firstText)}`,
    )
  } finally {
    t.cleanup(store)
  }
})

test('SR2 给 sessionId：读该会话的对话轮次', async () => {
  const t = makeTmp('prts-sessrecall-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(store)
    const { registry, get } = fakeRegistry()
    createSessionTools(registry as never, { store })

    const out = await get('prts_session_recall').execute({ sessionId: 'sess-old' }) as {
      sessionId?: string
      turns?: Array<{ speaker: string; text: string }>
      count?: number
    }
    assert.equal(out.sessionId, 'sess-old')
    assert.equal(out.count, 2)
    assert.equal(out.turns?.[0]?.speaker, 'owner')
    assert.ok(out.turns?.[0]?.text.includes('task-c729fa72'))
  } finally {
    t.cleanup(store)
  }
})

test('SR3 不存在的 sessionId：返回空并说明，不抛错', async () => {
  const t = makeTmp('prts-sessrecall-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    seed(store)
    const { registry, get } = fakeRegistry()
    createSessionTools(registry as never, { store })

    const out = await get('prts_session_recall').execute({ sessionId: 'sess-nope' }) as {
      count?: number
      note?: string
    }
    assert.equal(out.count, 0)
    assert.ok(typeof out.note === 'string' && out.note !== '', '应说明为什么是空的')
  } finally {
    t.cleanup(store)
  }
})

test('SR4 记忆库没有 turn 时列会话返回空数组，不抛错', async () => {
  const t = makeTmp('prts-sessrecall-')
  const store = MemoryStore.open(t.db('memory.sqlite'))
  try {
    const { registry, get } = fakeRegistry()
    createSessionTools(registry as never, { store })
    const out = await get('prts_session_recall').execute({}) as { sessions?: unknown[] }
    assert.deepEqual(out.sessions, [])
  } finally {
    t.cleanup(store)
  }
})
