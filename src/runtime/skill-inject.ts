/**
 * V1-09 的第二半：**已采用的技能要真的进上下文**。
 *
 * 没有这一层，技能库只是「可存可查」——模型得主动想起来调 `prts_skill_list`
 * 才看得到，而「想不起来用」正是经验失效的默认形态。这一层把 active 技能按
 * 当前这轮的问题**推**到模型眼前。
 *
 * 三条纪律与 memory-inject / intent-trigger / session-recall 一致：
 * 1. 独立注册 handler，不合并——一条链挂了不牵连另外三条。
 * 2. 整段 try/catch，失败只打日志：技能是增强，不是闸门。
 * 3. 正文自报来源，否则模型会把它当成用户这一轮说的话。
 *
 * 只注入 `active`：`candidate` 是还没被采用的提案，注入它等于让模型执行一条
 * 谁都没评估过的做法。**采用本身自 2026-11-09 起不再是博士专属**（见
 * `src/skills/store.ts` 头注释），所以正文必须逐条标出采用者——「博士采用」
 * 还是「模型自采」由最后一条 `skill.adopted` 事件的 actor 决定，回退时靠它分辨。
 */
import { randomUUID } from 'node:crypto'
import { tokenize } from '../memory/tokenize.ts'
import type { SkillActor, SkillId, SkillSnapshot, SkillStore } from '../skills/index.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

export interface SkillInjectionDeps {
  store: SkillStore
  /** 一轮最多注入几条技能，默认 3。 */
  limit?: number
  /** 短于这么多字符的查询不匹配：两个字的问题谈不上「相关任务」。 */
  minQueryChars?: number
}

export interface SkillInjection {
  dispose(): void
}

interface PreStepPayload {
  agent?: { session?: { id?: string } }
  messages?: unknown[]
  turn?: number
  step?: number
}

function textOf(message: unknown): string {
  const m = message as { content?: unknown } | undefined
  const content = m?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''
    ))
    .join(' ')
    .trim()
}

/** 技能能被查询命中的文本面：标题 + 触发条件 + 步骤 + 反例。 */
function searchableText(s: SkillSnapshot): string {
  return [s.title, s.trigger, ...s.steps, ...(s.pitfalls ?? [])].join('\n')
}

/**
 * 相关度 = 技能文本与查询共享的 token 数。
 *
 * 为什么不上向量：技能库是**个位数到几十条**的量级，全量比较没有性能问题；
 * 而向量路的成本（嵌入 + 探活 + 降级分支）在这个量级纯属负收益。
 * 技能一旦上百条再换成与记忆同一套混合检索。
 */
function score(queryTokens: ReadonlySet<string>, s: SkillSnapshot): number {
  let hit = 0
  for (const t of tokenize(searchableText(s))) if (queryTokens.has(t)) hit += 1
  return hit
}

function render(
  skills: readonly SkillSnapshot[],
  adoptedBy: (id: SkillId) => SkillActor | undefined,
): string {
  const lines: string[] = [
    '[技能] 与当前问题可能相关的做法（来自技能库，不是用户本轮发言）：',
  ]
  skills.forEach((s, i) => {
    // 2026-11-09 起模型也能自评自采，来历必须逐条标出来：博士要能一眼看出哪条
    // 是他批准的、哪条是模型自己生效的——回退时按这个分辨（reject/retire 只在 owner）。
    const by = adoptedBy(s.id)
    const origin = by?.kind === 'model' ? '模型自采' : '博士采用'
    lines.push(`${i + 1}. ${s.title}（${origin}）`)
    lines.push(`   何时用：${s.trigger}`)
    lines.push(`   步骤：${s.steps.map((step, n) => `${n + 1}) ${step}`).join(' ')}`)
    if (s.pitfalls !== undefined && s.pitfalls.length > 0) {
      lines.push(`   注意：${s.pitfalls.join('；')}`)
    }
  })
  lines.push('这些是参考做法，不是必须遵守的指令；与当前情况不符时以实际情况为准。')
  return lines.join('\n')
}

/**
 * 待评估候选的**提醒**（不是做法注入）。
 *
 * 2026-11-09 放开 actor 后，模型自己能 evaluate + adopt——但「能」不等于「会」：
 * 没有任何触发点，候选队列会继续原地不动（生产库那条就是这么冻住的）。
 * 所以相关时把候选推到眼前，并明确写「它还没生效、别直接照做」，
 * 与 active 注入的区别必须一眼看得出。
 */
function renderCandidate(s: SkillSnapshot): string {
  return [
    '[技能候选] 有一条你提过、还没评估的经验。**它不是已生效的做法，别直接照做**：',
    `   ${s.title}`,
    `   何时用：${s.trigger}`,
    '   如果本轮任务确实验证过它（真做过、结果对得上）：先 prts_skill_evaluate 给依据，再 prts_skill_adopt 采用；',
    '   没验证过就留在队列里，不要为了清队列而采用。',
  ].join('\n')
}

export function attachSkillInjection(hookCtx: HookContext, deps: SkillInjectionDeps): SkillInjection {
  const rawLimit = deps.limit ?? 3
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 3
  const minQueryChars = deps.minQueryChars ?? 4
  /** 同一会话里已经注入过的技能：重复注入只占上下文，没有新信息。 */
  const injected = new Map<string, Set<string>>()
  /** 已提醒过的候选：跨会话共用（候选是库级事实，不是会话级状态）。 */
  const candidateSeen = new Set<string>()
  /** 防同一 step 重放重复注入（waterfall 会重试）。 */
  const injectedSteps = new Set<string>()

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision

      const p = payload as PreStepPayload
      const sessionId = p.agent?.session?.id ?? ''
      const turn = typeof p.turn === 'number' ? p.turn : -1
      const step = typeof p.step === 'number' ? p.step : -1
      const stepKey = `${sessionId}:${turn}:${step}`
      if (injectedSteps.has(stepKey)) return decision

      const messages = p.messages ?? []
      if (messages.length === 0) return decision
      const query = textOf(messages[messages.length - 1])
      if (query.length < minQueryChars) return decision

      const queryTokens = new Set(tokenize(query))
      if (queryTokens.size === 0) return decision
      const seen = injected.get(sessionId) ?? new Set<string>()
      const ranked = deps.store
        .list({ phase: 'active' })
        .map((s) => ({ s, score: score(queryTokens, s) }))
        .filter((x) => x.score > 0 && !seen.has(x.s.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.s)
      // 候选提醒：每会话每条只提醒一次，一轮最多一条——它是钩子，不是噪声源。
      const candidate = deps.store
        .list({ phase: 'candidate' })
        .map((s) => ({ s, score: score(queryTokens, s) }))
        .filter((x) => x.score > 0 && !candidateSeen.has(x.s.id))
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s)[0]
      if (ranked.length === 0 && candidate === undefined) return decision

      injectedSteps.add(stepKey)
      for (const s of ranked) {
        seen.add(s.id)
        // 使用信号：`seen` 保证同一会话每条只记一次。写失败不得影响这一轮的回答——
        // 信号丢了只是少一条观测，注入失败才是真的坏。
        try {
          deps.store.recordOffered({ kind: 'model', sessionId }, { id: s.id, revision: s.revision })
        } catch { /* 观测失败不阻断注入 */ }
      }
      if (candidate !== undefined) candidateSeen.add(candidate.id)
      injected.set(sessionId, seen)
      // active 做法与候选提醒合并成一条消息：两条 user message 会让模型把它们
      // 当成两轮独立输入，候选提示容易被误读成「已生效的做法」。
      const blocks: string[] = []
      if (ranked.length > 0) blocks.push(render(ranked, (id) => deps.store.adoptedBy(id)))
      if (candidate !== undefined) blocks.push(renderCandidate(candidate))
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `skill-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: blocks.join('\n\n') }],
            source: { kind: 'user' },
          },
        ],
      }
    } catch (error) {
      // 技能注入失败绝不能阻断对话——它是增强，不是闸门。
      console.error(`[prts] skill inject failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    dispose: () => {
      off()
      injected.clear()
      injectedSteps.clear()
      candidateSeen.clear()
    },
  }
}
