/**
 * V1-09 模型侧工具。
 *
 * 2026-11-09 起暴露全套七个动作：propose / evaluate / adopt / reject / retire /
 * restore / list。技能只是注入上下文的建议文本，不参与工具注册、不过
 * `Authority.guard`，采用它不等于拿到新能力——真正拦得住模型的是 K2a 守卫。
 *
 * **回退也放开了**：模型能自己撤下已生效的经验（retire）与恢复（restore），
 * 也能否决候选（reject）。理由必填这条不放松——没有理由的回退，下次还会被
 * 重新提出。人工闸门退到 `/skill`（博士随时可撤任何一条）与哈希链
 * （`skill_events` 逐条可 verify）：放开的是「不用人批准」，不是「不用留痕」。
 *
 * 这条放开的**前提**写在 `src/skills/store.ts` 头注释：一旦技能能携带工具、
 * 数据源或授权路径，采用与回退都要收回，否则这一格就真成了「模型自己给自己加能力」。
 *
 * 采用后注入层会逐条标注「博士采用 / 模型自采」（`skill-inject.ts`），
 * 所以回执里不要写「博士已批准」这类说法。
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

/**
 * 完整 id 或唯一前缀 → 当前快照（带 revision）。
 *
 * 歧义直接抛错而不是猜：模型选错一条技能的影响会持续到有人来撤回，
 * 让它多打几位比让它赌一把便宜。
 */
function resolveSkillRef(store: SkillStore, ref: string): { id: SkillId; revision: number } {
  if (ref === '') throw new Error('skill: 缺少 skillId（先调 prts_skill_list 拿 id）')
  const all = store.list()
  const exact = all.find((s) => s.id === ref)
  if (exact !== undefined) return { id: exact.id, revision: exact.revision }
  const hits = all.filter((s) => s.id.startsWith(ref))
  const first = hits[0]
  if (first === undefined) throw new Error(`skill: 没有匹配 ${ref} 的技能`)
  if (hits.length > 1) throw new Error(`skill: ${ref} 匹配到 ${hits.length} 条，请给完整 id`)
  return { id: first.id, revision: first.revision }
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
      + '上次踩了什么坑。提出后仍是 candidate——可以自己评估并采用'
      + '（prts_skill_evaluate → prts_skill_adopt），也可以留给博士看。'
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
        message: `已提为候选技能「${title}」。还没生效——先 prts_skill_evaluate 给依据，再 prts_skill_adopt 才会注入。`,
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

  register({
    name: 'prts_skill_evaluate',
    description:
      '给一条候选技能下评估。verdict 是 adopt / reject / needs-work，basis 必填——'
      + '写清「在哪个任务上验证过、结果如何」，没有依据的评估等于没评。'
      + '**评估本身不改变技能相位**：要它生效还得调 prts_skill_adopt；'
      + '下了 reject 或 needs-work 之后不能采用。',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 id（prts_skill_list 返回的完整 id，也可用唯一前缀）' },
        verdict: { type: 'string', enum: ['adopt', 'reject', 'needs-work'], description: '评估结论' },
        basis: { type: 'string', description: '依据：在哪个任务/哪一轮上验证过，结果如何' },
      },
      required: ['skillId', 'verdict', 'basis'],
      additionalProperties: false,
    },
    output: outSchema({
      type: 'object',
      properties: { message: { type: 'string' }, skillId: { type: 'string' }, phase: { type: 'string' } },
      required: ['message', 'skillId', 'phase'],
    }),
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id ?? ''
      const verdict = String(a.verdict ?? '').trim()
      if (verdict !== 'adopt' && verdict !== 'reject' && verdict !== 'needs-work') {
        throw new Error('skill_evaluate: verdict 必须是 adopt / reject / needs-work')
      }
      const basis = String(a.basis ?? '').trim()
      if (basis === '') throw new Error('skill_evaluate: basis 不能为空（没有依据的评估不可追溯）')
      const ref = resolveSkillRef(deps.store, String(a.skillId ?? '').trim())
      const after = deps.store.evaluate(
        { kind: 'model', sessionId },
        { id: ref.id, revision: ref.revision },
        { verdict, basis },
      )
      return {
        message: verdict === 'adopt'
          ? `已记录评估「${after.title}」→ adopt（相位仍是 ${after.phase}）。要它生效再调 prts_skill_adopt。`
          : `已记录评估「${after.title}」→ ${verdict}（相位 ${after.phase}）。`,
        skillId: after.id,
        phase: after.phase,
      }
    },
  })

  register({
    name: 'prts_skill_adopt',
    description:
      '采用一条候选技能，让它从下一轮对话起注入到相关问题上。'
      + '前置条件：最近一次评估的结论必须是 adopt（没有就先调 prts_skill_evaluate）。'
      + '回执里不要声称「博士已批准」——注入时会标注「模型自采」，'
      + '博士可随时用 /skill retire 撤回。',
    parameters: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: '技能 id（完整 id 或唯一前缀）' },
      },
      required: ['skillId'],
      additionalProperties: false,
    },
    output: outSchema({
      type: 'object',
      properties: { message: { type: 'string' }, skillId: { type: 'string' }, phase: { type: 'string' } },
      required: ['message', 'skillId', 'phase'],
    }),
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id ?? ''
      const ref = resolveSkillRef(deps.store, String(a.skillId ?? '').trim())
      const after = deps.store.adopt({ kind: 'model', sessionId }, { id: ref.id, revision: ref.revision })
      return {
        message: `已采用「${after.title}」——下一轮起会注入到相关问题上（标注为「模型自采」）。`,
        skillId: after.id,
        phase: after.phase,
      }
    },
  })

  /** reject / retire / restore 三者同构：id + 理由，理由是唯一不可省的东西。 */
  const registerReasonAction = (
    name: string,
    description: string,
    verb: string,
    reasonLabel: string,
    apply: (actor: { kind: 'model'; sessionId: string }, ref: { id: SkillId; revision: number }, reason: string) => { id: SkillId; title: string; phase: string },
  ): void => {
    register({
      name,
      description: `${description} ${reasonLabel}必填——理由落进哈希链，事后能追「为什么撤」。`,
      parameters: {
        type: 'object',
        properties: {
          skillId: { type: 'string', description: '技能 id（完整 id 或唯一前缀）' },
          reason: { type: 'string', description: reasonLabel },
        },
        required: ['skillId', 'reason'],
        additionalProperties: false,
      },
      output: outSchema({
        type: 'object',
        properties: { message: { type: 'string' }, skillId: { type: 'string' }, phase: { type: 'string' } },
        required: ['message', 'skillId', 'phase'],
      }),
      execute: async (args: unknown, exec: unknown): Promise<unknown> => {
        const a = (args ?? {}) as Record<string, unknown>
        const sessionId = (exec as { agent?: { session?: { id?: string } } } | undefined)?.agent?.session?.id ?? ''
        const reason = String(a.reason ?? '').trim()
        if (reason === '') throw new Error(`${name.replace('prts_skill_', 'skill_')}: reason 不能为空`)
        const ref = resolveSkillRef(deps.store, String(a.skillId ?? '').trim())
        const after = apply({ kind: 'model', sessionId }, ref, reason)
        return { message: `已${verb}「${after.title}」（${after.phase}）：${reason}`, skillId: after.id, phase: after.phase }
      },
    })
  }

  registerReasonAction(
    'prts_skill_reject',
    '否决一条候选技能（相位 → rejected）。坏经验要留痕，否则同一个错做法会被反复提出。',
    '否决',
    '理由',
    (actor, ref, reason) => deps.store.reject(actor, ref, reason),
  )

  registerReasonAction(
    'prts_skill_retire',
    '撤下一条已生效的技能（相位 → retired）。发现它在当前环境里失效、或本身就是错的，就用它。恢复用 prts_skill_restore。',
    '退役',
    '理由',
    (actor, ref, reason) => deps.store.retire(actor, ref, reason),
  )

  registerReasonAction(
    'prts_skill_restore',
    '把退役的技能恢复生效（相位 → active）。只在确认它仍然适用时用，别拿它抵消上一次回退的判断。',
    '恢复',
    '理由',
    (actor, ref, reason) => deps.store.restore(actor, ref, reason),
  )

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
