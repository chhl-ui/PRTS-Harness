/**
 * V1-14 前瞻记忆 · W2：模型侧工具。
 *
 * 只注册 create / list 两个——**取消走所有者通道**，理由与记忆的 forget/correct 一致
 * （`AGENTS.md`：所有者通道，模型面零工具）：取消提醒会让一个已经承诺的提醒永久失效，
 * 属于破坏性动作，不该由模型在对话中单方面决定。
 *
 * 时间解析走「模型给绝对时刻 + 本地校验」（`docs/design-intent-memory-v1-14.md` 决策 1）：
 * 工具参数直接要 `fire_at_iso`，`store.createIntent` 再校验过去/过近/过远。
 * `condition_raw`（用户原话）原样落库并在回执里回显，模型算错时间时用户能看出来。
 */
import type { MemoryStore } from '../memory/index.ts'
import type { ToolRegistry } from './task-tools.ts'

export interface IntentToolDeps {
  store: MemoryStore
}

export interface IntentTools {
  names: readonly string[]
  dispose(): void
}

export function createIntentTools(tools: ToolRegistry, deps: IntentToolDeps): IntentTools {
  const offs: Array<() => void> = []
  const names: string[] = []
  const register = (definition: { name: string }): void => {
    offs.push(tools.register(definition))
    names.push(definition.name)
  }

  register({
    name: 'prts_intent_create',
    description:
      '记下一条到期提醒（前瞻意图）。**触发时刻必须由你换算成绝对时间**：'
      + '把用户说的「三天后」「下周一」等换成 ISO 8601 带时区的时刻填进 fire_at_iso，'
      + '并把用户原话填进 condition_raw（触发时会原样回显，用来核对你的换算）。'
      + '换算不确定时宁可问清楚，也不要猜——记错时间比不记更糟。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '到期时要做什么/提醒什么' },
        fire_at_iso: {
          type: 'string',
          description: '绝对触发时刻，ISO 8601 带时区（如 2026-11-06T15:00:00+08:00）。必须在 1 分钟后、2 年内',
        },
        condition_raw: { type: 'string', description: '用户原话里的时间表达（如「三天后」），原样保留' },
        source_turn_id: { type: 'string', description: '可选：这条意图来自哪条 turn' },
      },
      required: ['action', 'fire_at_iso', 'condition_raw'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          intentId: { type: 'string' },
          fireAtIso: { type: 'string' },
        },
        required: ['message', 'intentId', 'fireAtIso'],
      },
    } as unknown as Record<string, unknown>,
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      const action = String(a.action ?? '').trim()
      const conditionRaw = String(a.condition_raw ?? '').trim()
      const raw = String(a.fire_at_iso ?? '').trim()
      if (action === '') throw new Error('intent_create: action 不能为空')
      if (conditionRaw === '') throw new Error('intent_create: condition_raw 不能为空（用户原话要原样保留）')
      const fireAtMs = Date.parse(raw)
      // Date.parse 对 "2026-13-01" 这类会返回 NaN，对无时区的串按本地时间解释——
      // 后者是陷阱：模型给的时间若缺时区，会按服务器时区落库，可能整体偏移。
      if (!Number.isFinite(fireAtMs)) {
        throw new Error(`intent_create: fire_at_iso 无法解析为时刻：${raw}（需要 ISO 8601 带时区）`)
      }
      if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
        throw new Error(`intent_create: fire_at_iso 缺少时区：${raw}（否则会按本机时区解释，时刻可能整体偏移）`)
      }
      const intentId = deps.store.createIntent({
        actor: 'model',
        conditionRaw,
        action,
        fireAtMs,
        ...(typeof a.source_turn_id === 'string' && a.source_turn_id !== ''
          ? { sourceTurnId: a.source_turn_id }
          : {}),
      })
      const iso = new Date(fireAtMs).toISOString()
      return {
        message: `已记下：${action}。触发时刻 ${iso}（你说的「${conditionRaw}」）。`
          + '时间不对就请博士取消后重建——我不能自己改已记下的提醒。',
        intentId,
        fireAtIso: iso,
      }
    },
  })

  register({
    name: 'prts_intent_list',
    description: '列出已记下的提醒。默认只看未触发的（pending）；可指定 status 查看已触发或已取消的。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'fired', 'cancelled'], description: '默认 pending' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          intents: { type: 'array' },
        },
        required: ['count', 'intents'],
      },
    } as unknown as Record<string, unknown>,
    execute: async (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as Record<string, unknown>
      const status = a.status === 'fired' || a.status === 'cancelled' ? a.status : 'pending'
      const rows = deps.store.listIntents({ status })
      return {
        count: rows.length,
        intents: rows.map((r) => ({
          intentId: r.intentId,
          action: r.action,
          conditionRaw: r.conditionRaw,
          fireAtIso: new Date(r.fireAtMs).toISOString(),
          status: r.status,
          ...(r.firedAtMs === null ? {} : { firedAtIso: new Date(r.firedAtMs).toISOString() }),
        })),
      }
    },
  })

  return {
    names,
    // 与 memory-tools.ts 同一纪律：注销失败不阻断停机。注销抛错会中断上层的
    // dispose 链，使排在后面的 memory.close() 不执行——Windows 上表现为临时目录
    // 清理 EPERM，症状离原因很远（session-purge SP5 就是这么炸的）。
    dispose: () => {
      for (const off of offs.splice(0)) {
        try { off() } catch { /* 注销失败不阻断停机 */ }
      }
      names.length = 0
    },
  }
}
