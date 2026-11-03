/**
 * V1-05 情感状态的表达层：把当前情绪作为一句提示推进上下文。
 *
 * 与 `memory-inject` / `intent-trigger` / `session-recall` / `skill-inject` 同构：
 * 独立注册 handler、整段 try/catch、失败只打日志。情感是增强，不是闸门。
 *
 * ## 这条边界必须写死在注入文本里
 *
 * 架构需求 V1-05 的硬要求是「情感变化不改变任何事实性回答」。机制层已经保证了
 * 一半（情感库不参与检索，见 `test/emotion/emotion-store.test.ts` 的 EM7），
 * 但另一半在模型侧：看到「你现在有点烦躁」，模型完全可能据此把答案说得更保守、
 * 或者少报一条证据。所以注入正文必须显式声明「这是表达基调，不是事实依据」。
 *
 * ## 为什么每轮注入
 *
 * 一句话（< 100 字符）的成本远小于「情绪只在启动时读一次」造成的失真：
 * 情绪是任务尺度变化的，一轮对话里可能经历成功与受阻，只在启动时快照会让
 * 模型一直按开机那一刻的心情说话。衰减是读时计算的，所以每轮读到的都是当下值。
 */
import { randomUUID } from 'node:crypto'
import type { EmotionStore } from '../emotion/index.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

export interface HookContext {
  on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

export interface EmotionInjectionDeps {
  store: EmotionStore
  /** 覆盖当前时刻（测试用）。 */
  now?: () => number
}

export interface EmotionInjection {
  /** 手动跑一次（测试用）。空串表示没有可注入的内容。 */
  render(): string
  dispose(): void
}

export function attachEmotionInjection(hookCtx: HookContext, deps: EmotionInjectionDeps): EmotionInjection {
  const now = deps.now ?? Date.now
  /** 防同一 step 重放重复注入。 */
  const injectedSteps = new Set<string>()

  const render = (): string => {
    const mood = deps.store.renderMood(now())
    if (mood === '') return ''
    return [
      `[表达基调] ${mood}`,
      '这只影响语气与措辞，**不得**改变任何事实性回答：不因为情绪少报证据、不说得更肯定或更含糊。',
    ].join('\n')
  }

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next() as Decision
    try {
      if (decision.kind !== 'enter') return decision
      const p = payload as { agent?: { session?: { id?: string } }; turn?: number; step?: number }
      const sessionId = p.agent?.session?.id ?? ''
      const turn = typeof p.turn === 'number' ? p.turn : -1
      const step = typeof p.step === 'number' ? p.step : -1
      const key = `${sessionId}:${turn}:${step}`
      if (injectedSteps.has(key)) return decision
      const text = render()
      if (text === '') return decision
      injectedSteps.add(key)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `mood-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          },
        ],
      }
    } catch (error) {
      console.error(`[prts] emotion inject failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    render,
    dispose: () => { off(); injectedSteps.clear() },
  }
}
