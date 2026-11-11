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

test('SI3 candidate 不作为做法注入——只提醒它待评估，正文不得给步骤', async () => {
  const c = open()
  try {
    c.store.propose(owner, lesson)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('我要改一个共享模块的函数签名'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 1, '应有一条候选提醒')
      const text = textOf([d.messages[0]])
      assert.match(text, /技能候选/, '必须标明这是候选提醒')
      assert.match(text, /别直接照做/, '必须明说它不是已生效的做法')
      assert.ok(!text.includes('grep 该符号的所有引用'), `候选步骤不得进正文（那等于批准执行）：\n${text}`)
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

test('SI9 注入标注采用者——模型自采与博士采用必须可分辨', async () => {
  const c = open()
  try {
    activated(c.store) // 博士采用
    const modelActor = { kind: 'model' as const, sessionId: 'sess-1' }
    const modelId = c.store.propose(modelActor, {
      title: '模型自采的一条：对账先以磁盘为基准',
      trigger: '要改共享模块的函数签名时先核对磁盘真值',
      steps: ['枚举磁盘拿真值', '再改文档数字'],
    })
    const e = c.store.evaluate(modelActor, { id: modelId, revision: 1 }, {
      verdict: 'adopt',
      basis: '在同一次对账任务上用过，数字对上了',
    })
    c.store.adopt(modelActor, { id: modelId, revision: e.revision })

    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const d = await h.fire(payloadOf('我要改共享模块的函数签名'), async () => enter([])) as { messages: unknown[] }
      const text = textOf([d.messages[0]])
      assert.match(text, /博士采用/, `博士采用的那条要标出来，否则模型分不清来历：\n${text}`)
      assert.match(text, /模型自采/, `模型自采的那条要标出来（这是 2026-11-09 放开的代价与前提）：\n${text}`)
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI10 候选提醒每会话每条只出现一次；采用后转成 active 注入', async () => {
  const c = open()
  try {
    const modelActor = { kind: 'model' as const, sessionId: 'sess-1' }
    const id = c.store.propose(modelActor, lesson)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, { store: c.store })
    try {
      const first = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(first.messages.length, 1, '第一次应提醒候选')
      const second = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 2, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(second.messages.length, 0, '同一候选不重复提醒——提醒是钩子不是噪声源')

      // 模型自评自采后，同一条应转成 active 注入并标注「模型自采」。
      const e = c.store.evaluate(modelActor, { id, revision: 1 }, { verdict: 'adopt', basis: '在上一轮做过，结果对得上' })
      c.store.adopt(modelActor, { id, revision: e.revision })
      const third = await h.fire(payloadOf('改共享模块的函数签名', 'sess-b', 1, 1), async () => enter([])) as { messages: unknown[] }
      const text = textOf(third.messages)
      assert.match(text, /模型自采/, `采用后应按 active 注入并标注来历：\n${text}`)
      assert.ok(!text.includes('[技能候选]'), '采用后不该再当候选提醒')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI11 会话绑了任务 → offer 载荷带 taskId（DESIGN-04 归因连接键）', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, {
      store: c.store,
      taskForSession: () => ({ id: 'task-1' }),
    })
    try {
      await h.fire(payloadOf('改共享模块的函数签名', 'sess-a'), async () => enter([]))
      const rows = c.store.offers()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].sessionId, 'sess-a')
      assert.equal(rows[0].taskId, 'task-1', '提供时的绑定任务必须落载荷，否则结局连不回来')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI12 换任务 = 新上下文：重新注入，新 offer 带新 taskId', async () => {
  const c = open()
  try {
    activated(c.store)
    let bound = 'task-1'
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, {
      store: c.store,
      taskForSession: () => ({ id: bound }),
    })
    try {
      const first = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 1, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(first.messages.length, 1)
      bound = 'task-2'
      const second = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a', 2, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(second.messages.length, 1, '新任务下相关技能值得再提一次')
      const rows = c.store.offers()
      assert.equal(rows.length, 2)
      assert.deepEqual(rows.map((r) => r.taskId), ['task-1', 'task-2'], '各次提供带各自的任务键')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI13 taskForSession 抛错不阻断注入：按无任务处理，offer 照记', async () => {
  const c = open()
  try {
    activated(c.store)
    const h = fakeHookCtx()
    const inj = attachSkillInjection(h.ctx, {
      store: c.store,
      taskForSession: () => { throw new Error('账本打不开') },
    })
    try {
      const d = await h.fire(payloadOf('改共享模块的函数签名', 'sess-a'), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 1, '技能是增强不是闸门')
      const rows = c.store.offers()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].taskId, undefined, '读不到绑定就不主张关联')
    } finally { inj.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('SI14 重启不重复记 offer：进程内 Map 丢了，链上 hasOffered 还在', async () => {
  const c = open()
  try {
    activated(c.store)
    const h1 = fakeHookCtx()
    const inj1 = attachSkillInjection(h1.ctx, { store: c.store, taskForSession: () => ({ id: 'task-1' }) })
    try {
      await h1.fire(payloadOf('改共享模块的函数签名', 'sess-a', 1, 1), async () => enter([]))
    } finally { inj1.dispose() }
    assert.equal(c.store.offers().length, 1)

    // 模拟 supervisor 重启：新实例、同一会话同一任务、回合继续。
    const h2 = fakeHookCtx()
    const inj2 = attachSkillInjection(h2.ctx, { store: c.store, taskForSession: () => ({ id: 'task-1' }) })
    try {
      const d = await h2.fire(payloadOf('改共享模块的函数签名', 'sess-a', 2, 1), async () => enter([])) as { messages: unknown[] }
      assert.equal(d.messages.length, 1, '上下文重建后文本要重新注入')
      assert.equal(c.store.offers().length, 1, '但 offer 不重记——N 不因重启虚增')
    } finally { inj2.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})
