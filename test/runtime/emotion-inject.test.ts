/**
 * V1-05 表达层：情绪要真的进上下文，否则只是库里的一行。
 * 同时钉住注入正文里的那条边界声明——模型不能拿情绪当少报证据的借口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EmotionStore } from '../../src/emotion/index.ts'
import { attachEmotionInjection } from '../../src/runtime/emotion-inject.ts'
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
const payloadOf = (sessionId = 'sess-1', turn = 1, step = 1) => ({
  agent: { session: { id: sessionId } },
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }],
  turn,
  step,
})

function textOf(messages: unknown[]): string {
  return messages
    .map((m) => {
      const msg = m as { content?: Array<{ type?: string; text?: string }> }
      return (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    })
    .join('\n')
}

function open(): { store: EmotionStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-emotion-inj-')
  return { store: EmotionStore.open(join(tmp.dir, 'emotion.sqlite')), tmp }
}

const owner = { kind: 'owner' as const }

test('EI1 没有情绪状态时不注入空壳', async () => {
  const c = open()
  try {
    const h = fakeHookCtx()
    const inj = attachEmotionInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf(), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0)
      assert.equal(inj.render(), '')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('EI2 有状态时注入，且正文明确「不得改变任何事实性回答」', async () => {
  const c = open()
  try {
    c.store.update(owner, { valence: -0.5, arousal: 0.6, label: '烦躁', reason: '连续受阻' })
    const h = fakeHookCtx()
    const inj = attachEmotionInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf(), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 1)
      const text = textOf(d.messages)
      assert.ok(text.includes('烦躁'), `应包含情绪标签：\n${text}`)
      assert.ok(text.includes('不得') && text.includes('事实'), `必须声明不改变事实：\n${text}`)
      assert.ok(text.includes('不是用户本轮发言') === false, '这条不需要那套措辞，来源已在标签里')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('EI3 同一 step 重放不重复注入', async () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.3, arousal: 0.3, label: '平静', reason: 'r' })
    const h = fakeHookCtx()
    const inj = attachEmotionInjection(h.ctx, { store: c.store })
    try {
      const first = await h.fire(payloadOf('s', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(first.messages.length, 1)
      const second = await h.fire(payloadOf('s', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(second.messages.length, 0)
      const next = await h.fire(payloadOf('s', 2, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(next.messages.length, 1, '下一轮应重新注入（情绪可能已变）')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('EI4 情感库抛错不阻断对话', async () => {
  const c = open()
  try {
    const h = fakeHookCtx()
    const broken = { renderMood(): never { throw new Error('库打不开') } }
    const inj = attachEmotionInjection(h.ctx, { store: broken as unknown as EmotionStore })
    try {
      const d = await h.fire(payloadOf(), async () => enter([])) as { kind: string; messages: unknown[] }
      assert.equal(d.kind, 'enter')
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})
