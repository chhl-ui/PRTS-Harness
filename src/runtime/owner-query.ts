/**
 * 只读查询处理器：`query` 请求 → 库层快照。
 *
 * ## 为什么单独一层
 *
 * `chat-serve.ts` 与 `test/runtime/terminal-pipe.test.ts` 的 rig 要装同一个处理器，而那条
 * 测试自己的纪律是「组装与入口同构」——两边各写一份取数逻辑，同构就只能靠人眼比对。
 * 协议词表在 `owner-protocol.ts`，本文件只负责「取数 + 形状」，不碰传输。
 *
 * ## 只读是硬边界
 *
 * 这里只调 `list()` / `taskForSession()` / `listIntents()` / `search()`：不写账本、
 * 不写会话事件、不落记忆 turn、不进审计。所有写操作（验收、驳回、取消、批准、切档、
 * 遗忘、更正、切会话）继续走 `/` 命令，owner 通道的写路径与审计链原样不动。
 *
 * ## 当前会话为什么是函数
 *
 * `currentSessionId` 用取值函数而不是字符串：`/switch` / `/new` 会替换当前会话，而处理器
 * 在管道监听时就已经构造（早于 runChat）。传值会让切走之后的 `boundTaskId` 一直指向旧会话。
 *
 * ## 未知 what 为什么回 `query.result` 而不是 `error`
 *
 * 客户端按 `id` 配对结果；收到没有 id 的 `error{bad-request}` 会判成「服务端不支持
 * query」并在本次连接内永久停用查询。把「字段写错」放大成「整条链路不可用」不值得。
 */
import { listSessions } from './session-table.ts'
import { findForOwner } from '../memory/forget-flow.ts'
import { queryErrorPush, queryResultPush } from './owner-protocol.ts'
import type { QueryRequest, QueryResultPush } from './owner-protocol.ts'
import type { Ledger } from '../ledger/index.ts'
import type { MemoryStore } from '../memory/index.ts'

/** `ctx.get('agents')` 的公开面（`list()` 给 live 会话，`get()` 拿会话对象）。 */
export interface QueryAgentRegistry {
  list?(): Array<{ session?: { id?: string } }>
  get?(id: string): { session?: unknown } | undefined
}

export interface OwnerQueryDeps {
  /** 任务账本；缺省时 `tasks` 回 unavailable。 */
  ledger?: Ledger
  /** 记忆库；打不开时为 undefined（`intents` / `memory` 回 unavailable）。 */
  memory?: MemoryStore
  /** `<dataRoot>/dsh-home/sessions`（`listSessions` 的磁盘来源）。 */
  sessionsRoot: string
  agents?: QueryAgentRegistry
  /** 当前会话 id；`/switch` `/new` 之后必须返回新值。 */
  currentSessionId(): string
  /** 会话对象的沙箱档位（`start.ts` 的 `sandboxModeFor`）；resolve 失败返回 undefined。 */
  sandboxModeFor?(session: unknown): string | undefined
}

export function createOwnerQuery(deps: OwnerQueryDeps): (req: QueryRequest) => Promise<QueryResultPush> {
  return (req) => {
    const id = req.id
    switch (req.what) {
      case 'tasks': {
        const ledger = deps.ledger
        if (ledger === undefined) {
          return Promise.resolve(queryErrorPush(id, req.what, 'unavailable', '未配置任务账本'))
        }
        const currentSessionId = deps.currentSessionId()
        return Promise.resolve(queryResultPush(id, req.what, {
          currentSessionId,
          boundTaskId: ledger.taskForSession(currentSessionId)?.id ?? null,
          tasks: ledger.list(),
        }))
      }
      case 'sessions':
        return Promise.resolve(queryResultPush(id, req.what, {
          currentSessionId: deps.currentSessionId(),
          sessions: listSessions({
            sessionsRoot: deps.sessionsRoot,
            ...(deps.agents === undefined ? {} : { agents: deps.agents }),
          }),
        }))
      case 'intents': {
        const memory = deps.memory
        if (memory === undefined) {
          return Promise.resolve(queryErrorPush(id, req.what, 'unavailable', '记忆库未配置'))
        }
        // `all !== true` 只看 pending：桌面端默认关心「还没触发的」，要看历史得显式要。
        return Promise.resolve(queryResultPush(id, req.what, {
          intents: memory.listIntents(req.args?.all === true ? {} : { status: 'pending' }),
        }))
      }
      case 'memory': {
        const text = req.args?.query
        if (typeof text !== 'string' || text.trim() === '') {
          return Promise.resolve(queryErrorPush(id, req.what, 'bad-request', 'what=memory 需要非空 args.query'))
        }
        const memory = deps.memory
        if (memory === undefined) {
          return Promise.resolve(queryErrorPush(id, req.what, 'unavailable', '记忆库未配置'))
        }
        return Promise.resolve(queryResultPush(id, req.what, { hits: findForOwner(memory, text) }))
      }
      case 'sandbox': {
        const session = deps.agents?.get?.(deps.currentSessionId())?.session
        const mode = deps.sandboxModeFor?.(session)
        // `null` 而不是省略字段：客户端要能区分「没有档位」与「响应残缺」。
        return Promise.resolve(queryResultPush(id, req.what, { mode: mode ?? null }))
      }
      default:
        return Promise.resolve(queryErrorPush(id, req.what, 'bad-request', `未知的查询类别：${String(req.what)}`))
    }
  }
}
