/** 测试用脚本化模型替身：替代 llm-deepseek，按脚本依次应答（test/ 专用，不进受保护目录）。 */
import type { Context } from '@deepseek-ai/cordis'

export type ScriptedStep =
  | { text: string }
  | { toolCalls: { name: string; arguments: Record<string, unknown> }[]; text?: string }

interface Chunk {
  type: string
  index?: number
  blockType?: string
  text?: string
  id?: string
  name?: string
  argumentsDelta?: string
  block?: unknown
  usage?: unknown
  reason?: string
}

export function scriptedLlmPlugin(script: ScriptedStep[]) {
  let cursor = 0
  const adapter = {
    providerInfo(provider: string) {
      return { id: provider, name: 'scripted-test-llm' }
    },
    providerRetryPolicy() { return undefined },
    async listModels() { return [{ id: 'fake-1', name: 'fake-1' }] },
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model }
    },
    async prepareCall(provider: string, model: string) {
      return {
        model: { provider, id: model, name: model },
        stream: async function* (): AsyncGenerator<Chunk> {
          const step = script[cursor]
          if (!step) throw new Error(`scripted-llm: script exhausted (call #${cursor + 1})`)
          cursor++
          const chunks: Chunk[] = []
          const text = 'text' in step ? step.text : (step.text ?? '')
          const calls = 'toolCalls' in step ? step.toolCalls : []
          let idx = 0
          if (text) {
            chunks.push({ type: 'block-start', index: idx, blockType: 'text' })
            chunks.push({ type: 'text-delta', index: idx, text })
            chunks.push({ type: 'block-end', index: idx, block: { type: 'text', text } })
            idx++
          }
          for (const tc of calls) {
            const argsJson = JSON.stringify(tc.arguments)
            chunks.push({ type: 'block-start', index: idx, blockType: 'tool-call' })
            chunks.push({ type: 'tool-call-delta', index: idx, id: `call-${cursor}-${idx}`, name: tc.name, argumentsDelta: argsJson })
            chunks.push({ type: 'block-end', index: idx, block: { type: 'tool-call', id: `call-${cursor}-${idx}`, name: tc.name, arguments: tc.arguments } })
            idx++
          }
          chunks.push({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } })
          chunks.push({ type: 'finish', reason: calls.length > 0 ? 'tool-calls' : 'stop' })
          yield* chunks
        },
      }
    },
  }
  return {
    name: 'prts-scripted-llm',
    apply(ctx: Context) {
      (ctx.get('llm') as { registerAdapter(p: string[], a: unknown): void }).registerAdapter(['deepseek-official'], adapter)
    },
  }
}
