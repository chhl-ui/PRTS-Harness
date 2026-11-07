/**
 * 情景摘要的生产者（Wave B 的写入端）。
 *
 * 在此之前 `mem_summaries` 是**零写入**：表建了、`putSummary` 在 store 上等着、
 * FTS 索引也建好了，但全仓没有一处往里写。后果是检索只能召回 turn 碎片——
 * 新会话冷启动时拿到五条互不相连的对话行，拼不出「这一轮到底做成了什么」。
 *
 * 这里补上生产者：把一个会话的若干 turn 压成一条摘要，正文走 `putSummary`
 * （外置 body + FTS 同事务同步）。
 */
import type { MemoryStore } from './store.ts'
import type { TextGenerator } from './generate.ts'

export interface SummarizeDeps {
  store: MemoryStore
  generator: TextGenerator
}

export interface SummarizeOptions {
  sessionId: string
  /** 最多取多少条 turn（按 turn_index 升序取前 N 条），默认 40 */
  limit?: number
  /** 摘要主语类型，默认 session */
  subjectKind?: string
}

export interface SummarizeResult {
  summaryId: string
  turnCount: number
}

const DEFAULT_LIMIT = 40

/**
 * 摘要提示词。刻意要求保留四类东西：任务 id、产物路径、当前状态、待办——
 * 这四样是「冷启动能不能接上」的判据，也是 turn 碎片里最难自己拼出来的。
 */
function buildPrompt(turns: ReadonlyArray<{ speaker: string; text: string }>): string {
  const dialogue = turns.map((t) => `${t.speaker}: ${t.text}`).join('\n')
  return [
    '把下面这段对话压成一条情景摘要，供以后冷启动时快速接上进度。',
    '必须保留：任务 id、产物文件路径、当前状态、下一步待办。',
    '删掉寒暄、重复和自我重复的解释。',
    '只输出摘要正文，不要标题，不要解释，不要加引号。',
    '',
    dialogue,
  ].join('\n')
}

/**
 * 把一个会话的 turn 压成一条摘要并落库。
 *
 * 无 turn、或生成器只回了空白时返回 `null`——不写空摘要（空摘要在检索里
 * 是纯噪声，比没有更糟）。
 */
export async function summarizeSession(
  deps: SummarizeDeps,
  opts: SummarizeOptions,
): Promise<SummarizeResult | null> {
  const turns = deps.store.turnsForSession(opts.sessionId, { limit: opts.limit ?? DEFAULT_LIMIT })
  if (turns.length === 0) return null

  const generated = await deps.generator.generate(buildPrompt(turns))
  const text = generated.trim()
  if (text === '') return null

  const summaryId = deps.store.putSummary({
    subjectKind: opts.subjectKind ?? 'session',
    subjectId: opts.sessionId,
    text,
    sourceTurnIds: turns.map((t) => t.turnId),
  })
  return { summaryId, turnCount: turns.length }
}
