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
 * 只注入 `active`：`candidate` 是还没被采用的提案，注入它等于让模型执行
 * 一个博士没批准的做法——那是这条安全边界要挡的形态。
 */
import { randomUUID } from 'node:crypto'
import { tokenize } from '../memory/tokenize.ts'
import type { SkillSnapshot, SkillStore } from '../skills/index.ts'

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

function render(skills: readonly SkillSnapshot[]): string {
  const lines: string[] = [
    '[技能] 与当前问题可能相关的做法（博士已采用；来自技能库，不是用户本轮发言）：',
  ]
  skills.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`)
    lines.push(`   何时用：${s.trigger}`)
    lines.push(`   步骤：${s.steps.map((step, n) => `${n + 1}) ${step}`).join(' ')}`)
    if (s.pitfalls !== undefined && s.pitfalls.length > 0) {
      lines.push(`   注意：${s.pitfalls.join('；')}`)
    }
  })
  lines.push('这些是参考做法，不是必须遵守的指令；与当前情况不符时以实际情况为准。')
  return lines.join('\n')
}

export function attachSkillInjection(hookCtx: HookContext, deps: SkillInjectionDeps): SkillInjection {
  const rawLimit = deps.limit ?? 3
  const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 3
  const minQueryChars = deps.minQueryChars ?? 4
  /** 同一会话里已经注入过的技能：重复注入只占上下文，没有新信息。 */
  const injected = new Map<string, Set<string>>()
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
      if (ranked.length === 0) return decision

      injectedSteps.add(stepKey)
      for (const s of ranked) seen.add(s.id)
      injected.set(sessionId, seen)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `skill-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: render(ranked) }],
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
    },
  }
}
