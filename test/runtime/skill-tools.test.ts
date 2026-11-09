/**
 * V1-09 模型侧工具：propose / evaluate / adopt / list。
 *
 * 2026-11-09 博士决定完全放开 propose → evaluate → adopt 的闭环：技能是注入
 * 上下文的建议文本，不参与工具注册、不过 `Authority.guard`，采用它不等于拿到
 * 新能力（真正的强制点是 K2a 守卫）。
 *
 * **reject / retire / restore 仍不暴露**——回退与否决留在 owner 的 `/skill` 通道。
 * 模型可以让一条经验生效，不能自己关掉已经生效的东西。
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

test('ST1 注册全套七个工具——2026-11-09 二次放开后不再保留动作', () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      assert.deepEqual(fake.names().sort(), [
        'prts_skill_adopt', 'prts_skill_evaluate', 'prts_skill_list', 'prts_skill_propose',
        'prts_skill_reject', 'prts_skill_restore', 'prts_skill_retire',
      ])
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

test('ST5 工具面能走完 propose → evaluate → adopt，采用者记成模型', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const exec = { agent: { session: { id: 'sess-x' } } }
      const out = await fake.get('prts_skill_propose').execute(lesson, exec) as { skillId: string }
      const ev = await fake.get('prts_skill_evaluate').execute(
        { skillId: out.skillId, verdict: 'adopt', basis: '在上一轮对账任务里用过，数字对上了' },
        exec,
      ) as { phase: string }
      assert.equal(ev.phase, 'candidate', '评估本身不改变相位')
      const a = await fake.get('prts_skill_adopt').execute({ skillId: out.skillId }, exec) as { message: string }
      assert.equal(c.store.get(out.skillId as never)?.phase, 'active')
      assert.deepEqual(c.store.adoptedBy(out.skillId as never), { kind: 'model', sessionId: 'sess-x' })
      assert.match(a.message, /模型自采/, '回执必须说明注入时会标注来历')
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST6 没有 adopt 结论就不能采用——评估与采用仍然分开', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const out = await fake.get('prts_skill_propose').execute(lesson) as { skillId: string }
      await assert.rejects(
        () => fake.get('prts_skill_adopt').execute({ skillId: out.skillId }),
        /evaluation|INVALID/,
        '未经评估不得采用',
      )
      assert.equal(c.store.get(out.skillId as never)?.phase, 'candidate')
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})

test('ST7 模型能自己回退与恢复——采用之后不满意可以撤下', async () => {
  const c = open()
  try {
    const fake = fakeRegistry()
    const tools = createSkillTools(fake.registry, { store: c.store })
    try {
      const exec = { agent: { session: { id: 'sess-x' } } }
      const out = await fake.get('prts_skill_propose').execute(lesson, exec) as { skillId: string }
      await fake.get('prts_skill_evaluate').execute(
        { skillId: out.skillId, verdict: 'adopt', basis: '在上一轮任务上验证过' },
        exec,
      )
      await fake.get('prts_skill_adopt').execute({ skillId: out.skillId }, exec)
      assert.equal(c.store.get(out.skillId as never)?.phase, 'active')

      const r = await fake.get('prts_skill_retire').execute(
        { skillId: out.skillId, reason: '换了仓库后触发条件不再出现' },
        exec,
      ) as { phase: string }
      assert.equal(r.phase, 'retired')
      const back = await fake.get('prts_skill_restore').execute(
        { skillId: out.skillId, reason: '演练结束，确认仍适用' },
        exec,
      ) as { phase: string }
      assert.equal(back.phase, 'active')

      // 理由必填不因放开而放松——没理由的回退下次还会被重新提出。
      await assert.rejects(
        () => fake.get('prts_skill_retire').execute({ skillId: out.skillId, reason: '  ' }, exec),
        /理由|reason|INVALID/,
      )
    } finally { tools.dispose() }
  } finally { c.tmp.cleanup(c.store) }
})
