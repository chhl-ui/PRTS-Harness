/**
 * 会话自主管理的模型侧工具。
 *
 * 目前只有一个：`prts_session_archive` —— 让模型自己决定「这一章可以翻过去了」。
 *
 * 它**不直接切换会话**，只往当前会话日志里追加一条 `archive/requested` 事件。
 * 真正的切换由 `runChat` 主循环在下一轮开头执行（见 chat.ts 的 archiveCursor 块）。
 * 这么分是因为 `applySwitch` 是 runChat 闭包里的局部函数，工具层够不着；而事件会落盘，
 * 进程崩了重启还能看到「上一轮请求过归档」，内存标记丢了就没了。
 */
import type { ToolRegistry } from './task-tools.ts'
import type { MemoryStore } from '../memory/index.ts'

export interface SessionToolDeps {
  /**
   * 记忆库。缺省时 `prts_session_recall` 报不可用；
   * `prts_session_archive` 不依赖它，仍然可用。
   */
  store?: MemoryStore
}

export interface SessionTools {
  names: readonly string[]
  dispose(): void
}

/** 从工具执行上下文里取当前会话的 session 对象。 */
function readSession(exec: unknown): { append?: (type: string, data: unknown) => void } | undefined {
  const e = exec as { agent?: { session?: { append?: (type: string, data: unknown) => void } } } | undefined
  return e?.agent?.session
}

export function createSessionTools(tools: ToolRegistry, deps: SessionToolDeps = {}): SessionTools {
  const disposers: (() => void)[] = []
  const names: string[] = []

  const register = (definition: Record<string, unknown>): void => {
    const off = tools.register(definition)
    disposers.push(off)
    names.push(String(definition.name))
  }

  register({
    name: 'prts_session_archive',
    description:
      '结束当前这段会话，开一个新的继续。'
      + '当你判断「这一章已经告一段落」「换一件完全不同的事」「这段历史太长会拖慢后续对话」时调用。'
      + '想保留这一段的内容，先用 prts_memory_summarize 固化，再调用本工具——归档不会自动摘要。'
      + '调用后本回合照常结束，下一次对话从新会话开始。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '为什么现在归档，一句话。会记进日志供以后追溯',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          requested: { type: 'boolean', description: '请求是否已记录' },
          note: { type: 'string', description: '说明何时生效' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { requested?: boolean; note?: string }
        return [{
          type: 'text',
          text: v?.requested === true
            ? `已记录归档请求。${v.note ?? ''}`
            : '归档请求未记录',
        }]
      },
    },
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const session = readSession(exec)
      if (session?.append === undefined) {
        // fail-closed：写不进日志就等于没请求，不能返回成功让模型以为切过了
        throw new Error('prts_session_archive: 当前会话不支持追加事件，无法记录归档请求')
      }
      const a = (args ?? {}) as { reason?: unknown }
      const reason = typeof a.reason === 'string' ? a.reason.trim().slice(0, 200) : ''
      try {
        session.append('archive/requested', { reason, at: Date.now() })
      } catch (error) {
        throw new Error(`prts_session_archive: 写入归档事件失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return { requested: true, note: '本回合结束后生效，下一次对话在新会话里。' }
    },
  })

  register({
    name: 'prts_session_recall',
    description:
      '回看历史会话。'
      + '不给 sessionId 时列出有过对话的会话目录（id、轮数、最近时间、首条消息）；'
      + '给了 sessionId 就返回那一段的对话原文。'
      + '当你想知道「以前还聊过什么」「这段之前是不是做过」时，先不带参数看目录，再读具体一段。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '要读的会话 id；省略则只列目录' },
        limit: { type: 'integer', description: '读轮数上限（默认 40）或目录条数上限（默认 20）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessions: { type: 'array', description: '目录模式：会话列表' },
          sessionId: { type: 'string', description: '读取模式：会话 id' },
          turns: { type: 'array', description: '读取模式：对话轮次' },
          count: { type: 'integer', description: '读取模式的轮数' },
          note: { type: 'string', description: '读取模式为空时的说明' },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as {
          sessions?: Array<{ sessionId?: string; turnCount?: number; firstText?: string }>
          sessionId?: string
          turns?: Array<{ speaker?: string; text?: string }>
          count?: number
          note?: string
        }
        if (Array.isArray(v?.sessions)) {
          const lines = v.sessions.length === 0
            ? '记忆库里还没有任何会话记录。'
            : v.sessions
              .map((s) => `${s.sessionId}（${s.turnCount ?? 0} 轮）${(s.firstText ?? '').slice(0, 60)}`)
              .join('\n')
          return [{ type: 'text', text: `会话目录：\n${lines}` }]
        }
        if (typeof v?.sessionId === 'string') {
          if ((v.count ?? 0) === 0) return [{ type: 'text', text: `${v.sessionId}：${v.note ?? '没有内容'}` }]
          const body = (v.turns ?? []).map((t) => `${t.speaker ?? '?'}: ${(t.text ?? '').slice(0, 200)}`).join('\n')
          return [{ type: 'text', text: `${v.sessionId} 的 ${v.count} 轮对话：\n${body}` }]
        }
        return [{ type: 'text', text: JSON.stringify(value) }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const store = deps.store
      if (store === undefined) {
        throw new Error('prts_session_recall: 记忆库未接入，无法回看历史会话')
      }
      const a = (args ?? {}) as { sessionId?: unknown; limit?: unknown }
      const limit = typeof a.limit === 'number' && Number.isFinite(a.limit)
        ? Math.max(1, Math.min(200, Math.floor(a.limit)))
        : undefined

      if (typeof a.sessionId === 'string' && a.sessionId.trim() !== '') {
        const sessionId = a.sessionId.trim()
        const turns = store.turnsForSession(sessionId, { limit: limit ?? 40 })
        if (turns.length === 0) {
          return { sessionId, count: 0, turns: [], note: '这个会话在记忆库里没有对话轮次（可能从未记录，或已被遗忘）' }
        }
        return {
          sessionId,
          count: turns.length,
          turns: turns.map((t) => ({
            speaker: t.speaker,
            text: t.text,
            occurredAt: t.occurredAtMs === null ? null : new Date(t.occurredAtMs).toISOString(),
          })),
        }
      }

      const sessions = store.sessionsWithTurns(limit ?? 20)
      return {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          turnCount: s.turnCount,
          lastAt: s.lastAtMs === null ? null : new Date(s.lastAtMs).toISOString(),
          firstText: s.firstText,
        })),
      }
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
