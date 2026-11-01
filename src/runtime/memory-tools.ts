/**
 * 记忆模块：模型侧检索入口（调用面接线，2026-11-02）。
 *
 * ## 为什么需要这个文件
 *
 * 在此之前记忆模块在生产上**只有写入**：`start.ts` 订阅 `agent/inbox/claimed` 与
 * `agent/turn-stopping` 落 turn，而 `search()` 在 `src/` 内零调用方——六项机制全部
 * 只被 `test/` 与 `.rivet/scratch/` 调用。结果是所有检索实验（any@8、rerank、画像闭环）
 * 衡量的都是离线探针的性质，不构成「生产 agent 因此记得住」的证据。
 *
 * 本文件补上唯一的消费出口：模型可以主动检索长期记忆，命中内容作为工具结果进上下文。
 *
 * ## 设计取舍（每条都有理由，不是默认值）
 *
 * - **只走 bm25（LIKE + FTS）**：向量路需要 embedder，生产不保证有 Ollama；
 *   画像 30 题全量实测无增益（`docs/memory-profile-wave3-30q-2026-11-02.md`），
 *   `profileQuota` 默认 0 不打开。先给一个可解释的检索，不给没人验证过增益的混合路。
 * - **只读 `live`**：benchmark 数据不进生产检索（设计稿 §6.4）。画像污染事件
 *   （267 条实验画像被标成 live）就是这么来的，工具面再加一道默认值。
 * - **`limit` 上限 20**：工具结果直接进上下文，模型一次要太多会挤掉真正的对话。
 * - **`query` 为空直接抛**：静默返回空结果会让模型以为「记忆里没有」，
 *   而实际是调用写错了——失败要响，不能咽（同 AGENTS.md 的 fail-closed 纪律）。
 * - **不注册写工具**：退役/巩固是运维动作（长作业、可能耗时几十秒），不该由模型
 *   在对话中触发。它们的入口留待 CLI 子命令，见文末遗留。
 */
import type { ToolRegistry } from './task-tools.ts'
import type { MemoryHit, MemoryStore } from '../memory/index.ts'

export interface MemoryToolDeps {
  store: MemoryStore
  /** 覆盖检索条数上限（测试用），默认 8。 */
  defaultLimit?: number
}

export interface MemoryTools {
  names: readonly string[]
  dispose(): void
}

const MAX_LIMIT = 20
const DEFAULT_LIMIT = 8

/** 命中项的对外形状：模型看文本与时间，回溯看 id。 */
function toWire(hit: MemoryHit): Record<string, unknown> {
  return {
    kind: hit.kind,
    id: hit.id,
    text: hit.text,
    // 时间必须给——只给正文，任何「多少天前 / 谁先谁后」的问题都无从推理
    occurredAt: hit.occurredAtMs === null || hit.occurredAtMs === undefined
      ? (hit.occurredRaw ?? null)
      : new Date(hit.occurredAtMs).toISOString(),
    score: Number(hit.score.toFixed(4)),
    recallPath: hit.recallPath,
  }
}

export function createMemoryTools(tools: ToolRegistry, deps: MemoryToolDeps): MemoryTools {
  const disposers: (() => void)[] = []
  const names: string[] = []
  const defaultLimit = deps.defaultLimit ?? DEFAULT_LIMIT

  const register = (definition: Record<string, unknown>): void => {
    const off = tools.register(definition)
    disposers.push(off)
    names.push(String(definition.name))
  }

  register({
    name: 'prts_memory_recall',
    description:
      '检索长期记忆：过去对话的原文片段，按相关度排序，每条带发生时间。'
      + '当问题涉及「之前 / 上次 / 曾经 / 我一向」这类跨会话信息，或需要确认博士的既有偏好与约束时使用。'
      + '返回的是原文片段而非摘要，回答时据此判断，不要编造未在结果中出现的内容。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索词，用问题里的关键实体或话题，不要整句照抄',
        },
        limit: {
          type: 'integer',
          description: `返回条数上限，1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}。实际条数可能更少（内部分配 fact/turn 名额）`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['message', 'hits'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { message?: unknown }
        return [{ type: 'text', text: typeof v?.message === 'string' ? v.message : JSON.stringify(value) }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { query?: unknown; limit?: unknown }
      const query = typeof a.query === 'string' ? a.query.trim() : ''
      if (query === '') {
        throw new Error('prts_memory_recall: query 不能为空——空 query 会被当成「没有相关记忆」')
      }
      const raw = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.floor(a.limit) : defaultLimit
      const limit = Math.min(MAX_LIMIT, Math.max(1, raw))

      const hits = deps.store.search({
        text: query,
        limit,
        // 显式写死 live：默认值在 store 里已是 ['live']，工具面再钉一次，
        // 避免将来有人改默认值把评测数据带进生产检索。
        includeOrigin: ['live'],
      })

      const body = hits.length === 0
        ? `记忆检索「${query}」没有命中。可能确实没记过，也可能换一组关键词再试。`
        : `记忆检索「${query}」命中 ${hits.length} 条（按相关度排序）：\n${
          hits.map((h, i) => `${i + 1}. [${h.kind}] ${toWire(h).occurredAt ?? '时间未知'} — ${h.text}`).join('\n')}`

      // 用进废退：模型真的拿到了这些记忆才算「用过」。只强化 fact——
      // turn 没有重要性列，强化它没有落点。
      // 失败只打日志：记忆是辅助，不能因为回写失败让模型拿不到检索结果。
      const factIds = [...new Set(hits.filter((h) => h.kind === 'fact').map((h) => h.id))]
      if (factIds.length > 0) {
        try {
          deps.store.reinforceFacts({ actor: 'system', factIds })
        } catch (error) {
          console.error(`[prts] memory reinforce failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      return { message: body, hits: hits.map(toWire) }
    },
  })

  return {
    names,
    dispose: () => {
      for (const off of disposers.splice(0)) {
        try { off() } catch { /* 注销失败不阻断停机 */ }
      }
      names.length = 0
    },
  }
}
