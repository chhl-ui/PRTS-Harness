/**
 * V1-09 模型侧工具：只 `propose` 与 `list`。
 *
 * **不暴露 evaluate / adopt / reject / retire / restore**——与账本「模型只能建 draft」、
 * 意图「取消走所有者通道」同一纪律：技能是能力扩张，采用与否是博士的决策。
 * 模型能自己采用经验，等于能自己给自己加能力，那正是产品原则要挡的形态。
 *
 * 副作用：模型提出来的经验会一直是 `candidate`，直到博士采用。这是**设计如此**，
 * 不是缺陷——提案队列本来就需要人来看。
 */
import type { SkillId, SkillPhase, SkillStore } from '../skills/index.ts'
import type { ToolRegistry } from './task-tools.ts'

export interface SkillToolDeps {
  store: SkillStore
}

export interface SkillTools {
  names: readonly string[]
  dispose(): void
}

function renderOut(value: unknown): { type: 'text'; text: string }[] {
  const v = value as { message?: unknown }
  return [{ type: 'text', text: typeof v?.message === 'string' ? v.message : JSON.stringify(value) }]
}

/** 与 intent-tools 同形：`output.render` 必须是函数，否则注册时抛错并被 effect 层咽掉。 */
function outSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return { schema, render: (_args: unknown, value: unknown) => renderOut(value) }
}

function strArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`skill_propose: ${field} 必须是字符串数组`)
  return value.map((v) => String(v).trim()).filter((v) => v !== '')
}

export function createSkillTools(tools: ToolRegistry, deps: SkillToolDeps): SkillTools {
  const offs: Array<() => void> = []
  const names: string[] = []
  const register = (definition: Record<string, unknown>): void => {
    offs.push(tools.register(definition))
    names.push(String(definition.name))
  }

  register({
    name: 'prts_skill_propose',
    description:
      '把一条可复用的做事经验提成**候选技能**。适合记：下次遇到同类情况该怎么做、'
      + '上次踩了什么坑。**你只能提议，不能采用**——采用与否由博士决定，'
      + '所以在回执里别声称这条已经在用。'
      + 'trigger 要写「什么时候该想起它」，写不出触发条件的经验等于没记。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话说清这条经验是什么' },
        trigger: { type: 'string', description: '什么时候该想起它（触发条件/适用场景）' },
        steps: { type: 'array', items: { type: 'string' }, description: '做法，有序' },
        pitfalls: {
          type: 'array', items: { type: 'string' },
          description: '可选：反例、失效条件、下次别再这么做的地方',
        },
        source_refs: {
          type: 'array', items: { type: 'string' },
          description: '可选：这条经验来自哪里（任务 id / turn id / commit sha）',
        },
      },
      required: ['title', 'trigger', 'steps'],
      additionalProperties: false,
    },
    output: outSchema({
      type: 'object',
      properties: { message: { type: 'string' }, skillId: { type: 'string' } },
      required: ['message', 'skillId'],
    }),
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      // 真实 sessionId 进审计：提了坏经验要能追到是哪一轮提的。
      const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id ?? ''
      const title = String(a.title ?? '').trim()
      const trigger = String(a.trigger ?? '').trim()
      const steps = strArray(a.steps, 'steps')
      if (title === '') throw new Error('skill_propose: title 不能为空')
      if (trigger === '') throw new Error('skill_propose: trigger 不能为空（写不出触发条件的经验等于没记）')
      if (steps.length === 0) throw new Error('skill_propose: steps 至少一步')
      const id: SkillId = deps.store.propose(
        { kind: 'model', sessionId },
        {
          title, trigger, steps,
          pitfalls: strArray(a.pitfalls, 'pitfalls'),
          sourceRefs: strArray(a.source_refs, 'source_refs'),
        },
      )
      return {
        message: `已提为候选技能「${title}」。它现在还没生效——需要博士评估后采用。`,
        skillId: id,
      }
    },
  })

  register({
    name: 'prts_skill_list',
    description:
      '列出技能库。默认只看已采用的（active）；candidate 是等待博士评估的提案，'
      + 'retired 是退下来的（含退役理由）。',
    parameters: {
      type: 'object',
      properties: {
        phase: {
          type: 'string',
          enum: ['active', 'candidate', 'retired', 'rejected'],
          description: '默认 active',
        },
      },
      additionalProperties: false,
    },
    output: outSchema({
      type: 'object',
      properties: { count: { type: 'number' }, skills: { type: 'array' } },
      required: ['count', 'skills'],
    }),
    execute: async (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      const phase = (a.phase === 'candidate' || a.phase === 'retired' || a.phase === 'rejected'
        ? a.phase
        : 'active') as SkillPhase
      const rows = deps.store.list({ phase })
      return {
        count: rows.length,
        skills: rows.map((s) => ({
          skillId: s.id,
          title: s.title,
          trigger: s.trigger,
          steps: s.steps,
          ...(s.pitfalls === undefined || s.pitfalls.length === 0 ? {} : { pitfalls: s.pitfalls }),
          phase: s.phase,
          ...(s.retireReason === undefined ? {} : { retireReason: s.retireReason }),
        })),
      }
    },
  })

  return {
    names,
    dispose: () => {
      for (const off of offs.splice(0)) {
        try { off() } catch { /* 注销失败不阻断停机 */ }
      }
      names.length = 0
    },
  }
}
