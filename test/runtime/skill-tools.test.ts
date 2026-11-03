/**
 * V1-09 模型侧工具：只 propose / list，**不暴露** evaluate / adopt / reject / retire / restore。
 *
 * 这条边界不是「暂时没做」，是安全不变量：技能是能力扩张，模型能自己采用经验
 * 就等于能自己给自己加能力。与账本「模型只能建 draft」同构。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SkillStore } from '../../src/skills/index.ts'
import { createSkillTools } from '../../src/runtime/skill-tools.ts'
import { makeTmp } from '../support/tmp.ts'

interface Captured {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function fakeRegistry(): { registry: { register(d: unknown): () => void }; get(name: string): Captured; names(): string[] } {
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
      const def = defs.get(name)
      if (def === undefined) throw new Error(`未注册 ${name}`)
      return def
    },
    names: () => [...defs.keys()],
  }
}

function open(): { store: SkillStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-skills-tool-')
  return { store: SkillStore.open(join(tmp.dir, 'skills.sqlite')), tmp }
}

const lesson = {
  title: '大文件先 grep 再读',
  trigger: '打开一个没见过的源文件时',
  steps: ['先 grep 关键词定位', '再 read_file 局部'],
  pitfalls: ['整文件读会挤占上下文'],
}

test('ST1 只注册 propose / list——决策类动作一个都没有', () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      assert.deepEqual(fake.names().sort(), ['prts_skill_list', 'prts_skill_propose'])
      for (const forbidden of ['prts_skill_adopt', 'prts_skill_retire', 'prts_skill_evaluate', 'prts_skill_restore', 'prts_skill_reject']) {
        assert.equal(fake.names().includes(forbidden), false, `${forbidden} 不该存在`)
      }
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST2 propose 落成 candidate，回执明说「还没生效」', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const out = await fake.get('prts_skill_propose').execute(lesson, { agent: { session: { id: 'sess-x' } } }) as { message: string; skillId: string }
      const s = c.store.get(out.skillId as never)
      assert.ok(s !== undefined)
      assert.equal(s.phase, 'candidate')
      assert.equal(s.title, lesson.title)
      assert.equal(s.proposedBy.kind, 'model')
      assert.match(out.message, /还没生效|需要博士/)
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST3 提案字段校验：标题、触发条件、步骤都不能空', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const propose = fake.get('prts_skill_propose')
      await assert.rejects(() => propose.execute({ ...lesson, title: '  ' }))
      await assert.rejects(() => propose.execute({ ...lesson, trigger: '' }))
      await assert.rejects(() => propose.execute({ ...lesson, steps: [] }))
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST4 list 默认只看 active；candidate 要显式查', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      await fake.get('prts_skill_propose').execute(lesson)
      const active = await fake.get('prts_skill_list').execute({}) as { count: number }
      assert.equal(active.count, 0, '提案不该出现在 active 里')
      const cand = await fake.get('prts_skill_list').execute({ phase: 'candidate' }) as { count: number; skills: Array<{ title: string }> }
      assert.equal(cand.count, 1)
      assert.equal(cand.skills[0].title, lesson.title)
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST5 工具面走不通「采用」——提案停在 candidate，只能由库外 owner 通道推进', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const out = await fake.get('prts_skill_propose').execute(lesson) as { skillId: string; message: string }
      // 连试三次：工具面没有任何路径能让它 active
      for (let i = 0; i < 3; i += 1) {
        await fake.get('prts_skill_list').execute({ phase: 'active' })
      }
      assert.equal(c.store.get(out.skillId as never)?.phase, 'candidate')
      assert.equal(c.store.list({ phase: 'active' }).length, 0)
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})
