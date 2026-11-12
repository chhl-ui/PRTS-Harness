/**
 * 压缩后回填（MI-OS1—MI-OS4）：本会话 turn 能否重新进入注入面。
 *
 * 背景：`memory-inject.ts:240` 默认把本会话自己的 turn 从注入候选里排除，
 * 理由是「已在上下文里」。会话被 DSH 压缩后这个前提失效——早期内容已不在上下文，
 * 而过滤仍在，两层叠加等于早期约束彻底消失。`includeOwnSession` 是那条出路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachMemoryInjection } from '../../src/runtime/memory-inject.ts'
import { MemoryStore } from '../../src/memory/index.ts'
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
      assert.ok(handler !== undefined, 'pre-step handler 必须已注册')
      return handler(payload, next)
    },
  }
}

const SID = 'sess-own'

function payloadOf(text: string) {
  return {
    agent: { session: { id: SID } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    turn: 1,
    step: 1,
  }
}

/** 造库：一条本会话 turn，内容与查询字面重叠。 */
function seeded(prefix: string): { store: MemoryStore; cleanup: () => void } {
  const t = makeTmp(prefix)
  const store = MemoryStore.open(t.db())
  store.recordTurn({
    actor: 'owner', sessionId: SID, turnIndex: 0, speaker: '博士', text: '我的光学镜头设计偏好是定焦',
  })
  return { store, cleanup: () => t.cleanup(store) }
}

/** 跑一轮 pre-step，返回注入消息的正文（没有注入返回空串）。 */
async function runOnce(store: MemoryStore, deps: Record<string, unknown>, query: string): Promise<string> {
  const fake = fakeHookCtx()
  const att = attachMemoryInjection(fake.ctx as never, { store, ...deps } as never)
  try {
    const decision = { kind: 'enter' as const, messages: [] as unknown[] }
    const out = await fake.fire(payloadOf(query), async () => decision) as { messages?: { content?: { text?: string }[] }[] }
    const messages = out.messages ?? []
    return messages
      .flatMap((m) => m.content ?? [])
      .map((c) => c.text ?? '')
      .join('\n')
  } finally {
    att.dispose?.()
  }
}

test('MI-OS1 默认不注入本会话自己的 turn（既有行为不变）', async () => {
  const { store, cleanup } = seeded('prts-own-default-')
  try {
    const text = await runOnce(store, {}, '光学镜头设计偏好是什么？')
    assert.equal(text.includes('定焦'), false, '本会话 turn 默认不进注入面')
  } finally {
    cleanup()
  }
})

test('MI-OS2 includeOwnSession 打开后，本会话 turn 回到注入面', async () => {
  const { store, cleanup } = seeded('prts-own-on-')
  try {
    const text = await runOnce(store, { includeOwnSession: () => true }, '光学镜头设计偏好是什么？')
    assert.equal(text.includes('定焦'), true, '压缩后必须能找回早期同会话内容')
  } finally {
    cleanup()
  }
})

test('MI-OS3 打开后仍过滤本轮原话（不把刚说的重复带回）', async () => {
  const { store, cleanup } = seeded('prts-own-self-')
  try {
    const query = '我的光学镜头设计偏好是定焦'
    const text = await runOnce(store, { includeOwnSession: () => true }, query)
    // 本会话那条 turn 的正文与 query 相同 → 应被「本轮原话」兜底过滤掉。
    assert.equal(text.includes('定焦'), false, '本轮原话不得靠打开开关绕过兜底')
  } finally {
    cleanup()
  }
})

test('MI-OS4 includeOwnSession 抛错 → 按关闭处理，不阻断注入', async () => {
  const { store, cleanup } = seeded('prts-own-throw-')
  try {
    const text = await runOnce(store, {
      includeOwnSession: () => { throw new Error('boom') },
    }, '光学镜头设计偏好是什么？')
    assert.equal(typeof text, 'string', '开关抛错不得让本轮装配中断')
  } finally {
    cleanup()
  }
})
