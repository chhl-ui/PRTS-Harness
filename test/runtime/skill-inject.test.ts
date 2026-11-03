/**
 * V1-09 的第二半：采用过的技能要真的进模型上下文。
 *
 * 只注入 `active`——`candidate` 是博士没批准的做法，注入它等于让模型执行
 * 未获批准的经验，那正是「模型不能自己给自己加能力」要挡的形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SkillStore } from '../../src/skills/index.ts'
import { attachSkillInjection } from '../../src/runtime/skill-inject.ts'
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

const msg = (text: string) => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const payloadOf = (text: string, sessionId = 'sess-1', turn = 1, step = 1) => ({
  agent: { session: { id: sessionId } },
  messages: [msg(text)],
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

const owner = { kind: 'owner' as const }

const lesson = {
  title: '改共享模块前先 grep 全部消费方',
  trigger: '要改被多处 import 的函数签名时',
  steps: ['grep 该符号的所有引用', '逐个确认签名同步'],
  pitfalls: ['只看当前文件会漏掉跨包消费方'],
}

function open(): { store: SkillStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-skill-inj-')
  return { store: SkillStore.open(join(tmp.dir, 'skills.sqlite')), tmp }
}

/** 走完整流程把技能变成 active。 */
function activated(store: SkillStore): string {
  const id = store.propose(owner, lesson)
  const e = store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: '上次就是这么漏的' })
  store.adopt(owner, { id, revision: e.revision })
  return id
}

test('SI1 技能库空 → 不注入空壳', async () => {
  const c = open()
  try {
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('改共享模块的函数签名要注意什么'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI2 active 技能与查询相关 → 注入标题、触发条件与步骤', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('我要改一个共享模块的函数签名'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 1, '应追加一条')
      const text = textOf([d.messages[0]])
      assert.ok(text.includes(lesson.title), `缺标题：\n${text}`)
      assert.ok(text.includes(lesson.trigger), `缺触发条件：\n${text}`)
      assert.ok(text.includes('grep 该符号的所有引用'), `缺步骤：\n${text}`)
      assert.ok(text.includes('不是用户本轮发言'), '自报来源')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI3 candidate 不注入——没被采用的经验不该被执行', async () => {
  const c = open()
  try {
    c.store.propose(owner, lesson)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('我要改一个共享模块的函数签名'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0, 'candidate 不得进上下文')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI4 查询与技能不相关 → 不注入（宁可少给，不要噪声）', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('今天天气怎么样适合去海边吗'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI5 同一技能在同一会话里只注入一次', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const first = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(first.messages.length, 1)
      const second = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 2, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(second.messages.length, 0, '第二轮不该重复注入')
      const other = await h.fire(payloadOf('改共享模块的函数签名', 'sess-b', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(other.messages.length, 1, '换会话应重新注入')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI6 技能库抛错不阻断对话', async () => {
  const c = open()
  try {
    const h = fakeHookCtx()
    const broken = { list(): never { throw new Error('库打不开') } }
    const inj = attachSkillInjection(h.ctx, { store: broken as unknown as SkillStore })
    try {
      const d = await h.fire(payloadOf('改共享模块的函数签名'), async () => enter([])) as { kind: string; messages: unknown[] }
      assert.equal(d.kind, 'enter')
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI7 查询太短不匹配——两个字谈不上「相关任务」', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('好'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI8 被退下来的技能不再注入——回退要在行为上看得出来', async () => {
  const c = open()
  try {
    const id = activated(c.store)
    const active = c.store.get(id as never)
    assert.ok(active !== undefined)
    c.store.retire(owner, { id: id as never, revision: active.revision }, '换仓库后失效')
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('改共享模块的函数签名'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 0)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})
