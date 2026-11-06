/**
 * 所有者通道词表：prts-terminal 与 runtime 之间的命名管道协议。
 *
 * 传输层（按行 JSON、坏行不抛出、命名管道连接）完全复用 supervisor/protocol.ts，
 * 本文件只定义词表与管道名范式——不重写编解码。
 *
 * 管道名用随机 UUID 而非固定/可预测名：这是**可用性措施**，只消除「发布瞬间抢注同名管道」
 * 的窗口，不是安全边界。名称会写进数据根下的 endpoint 文件，而沙箱可读 dataRoot（H3），
 * 所以它对「读到名称后直接连」零贡献——P2 的安全只有 T1 验的 IL 隔离这一道。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export { encode, lineParser, listenPipe, pipeConnect } from '../supervisor/protocol.ts'

/**
 * 所有者通道管道名：`\\.\pipe\prts-term-<随机 UUID 去横线>`。
 * 与 supervisor/protocol.ts 的 runtimePipeName() 同范式。
 */
export function ownerTermPipeName(): string {
  return `\\\\.\\pipe\\prts-term-${randomUUID().replace(/-/g, '')}`
}

/** 所有者通道的 endpoint 文件名（写在数据根下，客户端从这里读管道名）。 */
export const OWNER_ENDPOINT_FILE = 'terminal.endpoint'

// ---------------------------------------------------------------- 请求（客户端 → 服务端）

/** 发一句话给模型。所有 `/` 开头的命令也走这里——它们是 prompt 文本，不是协议消息。 */
export interface PromptRequest {
  type: 'prompt'
  text: string
}

/**
 * 审批应答。callId 必须与服务端 pending 的 callId 逐字相等：
 * 不匹配时服务端回 error{code:'stale-approval'} 且**不结算**该审批。
 */
export interface ApprovalAnswerRequest {
  type: 'approval.answer'
  callId: string
  allow: boolean
}

export interface StatusRequest {
  type: 'status'
}

/**
 * 只读查询（桌面端任务 / 会话 / 记忆 / 意图页面的数据源）。
 *
 * 只读是硬边界：查询不写账本、不写会话事件、不落记忆 turn、不进审计；所有写操作
 * （验收、驳回、取消、批准、切档、遗忘、更正、切会话）继续走 `/` 命令，owner 通道的
 * 写路径与审计链原样不动。
 *
 * `id` 由客户端生成、响应原样带回——管道上没有请求-响应配对关系，靠它区分
 * 「这一条结果对应哪一次查询」。
 */
export interface QueryRequest {
  type: 'query'
  id: string
  what: QueryWhat
  args?: QueryArgs
}

export type QueryWhat = 'tasks' | 'sessions' | 'intents' | 'memory' | 'sandbox'

export interface QueryArgs {
  /** `what='memory'` 必填：检索词。 */
  query?: string
  /** `what='intents'`：true = 含已触发 / 已取消（缺省只看 pending）。 */
  all?: boolean
}

export type OwnerRequest = PromptRequest | ApprovalAnswerRequest | StatusRequest | QueryRequest

// ---------------------------------------------------------------- 推送（服务端 → 客户端）

/**
 * `delta` = 模型文本增量；`host` = deps.out 的宿主回显（服务端进程自身要说的文本必须走这里，
 * 不能只写 stdout——分离后没人看得到）；`turn-end` = 一轮结束。
 */
export type OwnerEventKind = 'delta' | 'host' | 'turn-end'

export interface EventPush {
  type: 'event'
  kind: OwnerEventKind
  text: string
}

export interface ApprovalRequestPush {
  type: 'approval.request'
  callId: string
  tool: string
  capabilities: readonly string[]
  reason: string
}

/** 终端侧相位：`idle` 空闲、`running` 回合进行中、`awaiting-approval` 正在等审批应答。 */
export type OwnerPhase = 'idle' | 'running' | 'awaiting-approval'

export interface StatusPush {
  type: 'status'
  phase: OwnerPhase
}

/**
 * 只读查询的回执。
 *
 * `bad-request` 包含「`what` 未知」与「`memory` 缺 `query`」；它走 `query.result`
 * 而不是 `error`，是因为客户端按 id 配对结果——收到没有 id 的 `error` 会判成
 * 「服务端不支持 query」并在本次连接内永久停用查询，那会把一个字段打错
 * 变成整条链路不可用。`unavailable` = 对应数据源未配置（没有 ledger、记忆库打不开）。
 * `internal` = 查询处理器自身抛错。
 */
export type QueryErrorCode = 'bad-request' | 'unavailable' | 'internal'

export type QueryResultPush =
  | { type: 'query.result'; id: string; what: string; ok: true; data: unknown }
  | { type: 'query.result'; id: string; what: string; ok: false; error: { code: QueryErrorCode; message: string } }

/**
 * `stale-approval` —— 应答的 callId 与 pending 不符，或当前根本没有待审批请求（不结算）；
 * `bad-request` —— 收到坏行、无法识别的请求，或该状态下不该出现的请求（如审批期内的 prompt）；
 * `busy` —— 已有客户端连着（runChat 是单会话长循环，多客户端会争抢同一个输入迭代器）；
 * `internal` —— 服务端内部错误。
 *
 * 另外 `type:'tool'` 是工具活动推送（call/result），由 attachToolFeed 从
 * tools/execute + tools/result 两个上游事件翻译而来——客户端可把它渲染成
 * 「模型正在调用 X」的活动流水。旧客户端不认识此 type 会落入 default 分支，
 * 升级词表时两端的 case 都要补。
 */
export type OwnerErrorCode = 'stale-approval' | 'bad-request' | 'busy' | 'internal'

export interface ErrorPush {
  type: 'error'
  code: OwnerErrorCode
  message: string
}

/**
 * 工具活动推送（M3：把「模型调了哪个工具」放上所有者通道）。
 * `phase:'call'` 在 tools/execute 发出（守卫已过、工具未跑）；
 * `phase:'result'` 在 tools/result 发出。
 * `detail`：call 阶段是参数 JSON 截断串；result 阶段仅在 isError 时给错误摘要。
 */
export interface ToolPush {
  type: 'tool'
  phase: 'call' | 'result'
  callId: string
  name: string
  detail: string
  isError?: boolean
}

export type OwnerPush = EventPush | ApprovalRequestPush | StatusPush | ErrorPush | ToolPush | QueryResultPush

// ---------------------------------------------------------------- 推送构造器

export function eventPush(kind: OwnerEventKind, text: string): EventPush {
  return { type: 'event', kind, text }
}

export function approvalRequestPush(
  callId: string,
  tool: string,
  capabilities: readonly string[],
  reason: string,
): ApprovalRequestPush {
  return { type: 'approval.request', callId, tool, capabilities, reason }
}

export function statusPush(phase: OwnerPhase): StatusPush {
  return { type: 'status', phase }
}

export function toolPush(
  phase: 'call' | 'result',
  callId: string,
  name: string,
  detail: string,
  isError?: boolean,
): ToolPush {
  return { type: 'tool', phase, callId, name, detail, isError }
}

export function errorPush(code: OwnerErrorCode, message: string): ErrorPush {
  return { type: 'error', code, message }
}

export function queryResultPush(id: string, what: string, data: unknown): QueryResultPush {
  return { type: 'query.result', id, what, ok: true, data }
}

export function queryErrorPush(
  id: string,
  what: string,
  code: QueryErrorCode,
  message: string,
): QueryResultPush {
  return { type: 'query.result', id, what, ok: false, error: { code, message } }
}

// ---------------------------------------------------------------- 入站校验

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 把 lineParser 交出来的 unknown 收窄成 OwnerRequest；不认识的结构返回 null。
 * 调用方拿到 null 时按「坏行不崩」处理：回 errorPush('bad-request', ...)，继续读下一行。
 */
export function decodeOwnerRequest(msg: unknown): OwnerRequest | null {
  if (!isObject(msg)) return null
  switch (msg.type) {
    case 'prompt':
      return typeof msg.text === 'string' ? { type: 'prompt', text: msg.text } : null
    case 'approval.answer':
      return typeof msg.callId === 'string' && typeof msg.allow === 'boolean'
        ? { type: 'approval.answer', callId: msg.callId, allow: msg.allow }
        : null
    case 'status':
      return { type: 'status' }
    case 'query': {
      if (typeof msg.id !== 'string' || msg.id === '') return null
      if (typeof msg.what !== 'string' || msg.what === '') return null
      const rawArgs = isObject(msg.args) ? msg.args : undefined
      const args: QueryArgs = {}
      if (typeof rawArgs?.query === 'string') args.query = rawArgs.query
      if (typeof rawArgs?.all === 'boolean') args.all = rawArgs.all
      // `what` 只校验「是非空字符串」，合法性交给服务端处理器回 `bad-request`——
      // 解码层返回 null 会让调用方回无 id 的 `error`，客户端据此判成
      // 「服务端不支持 query」并永久停用（见 QueryResultPush 注释）。
      return {
        type: 'query',
        id: msg.id,
        what: msg.what as QueryWhat,
        ...(Object.keys(args).length === 0 ? {} : { args }),
      }
    }
    default:
      return null
  }
}

/**
 * 读端点文件并探活它记录的 pid。
 *
 * 只用于**诊断提示**，不改变连接语义：`chat-serve.ts` 正常退出会删端点，但进程被
 * 强杀或崩溃时 finally 不执行，端点残留指向一个死 pid——客户端只会得到
 * `connect ENOENT`，看不出「该重启的是 serve」（2026-11-06 实测踩过）。
 *
 * 读不到文件、坏 JSON、缺 pid 一律返回 undefined，从不抛；pid ≤ 0 也不探活
 * （`process.kill(0, 0)` 会发给整个进程组）。
 */
export function probeEndpointOwner(dataRoot: string): { pid: number; alive: boolean } | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dataRoot, OWNER_ENDPOINT_FILE), 'utf8')) as { pid?: unknown }
    const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : undefined
    if (pid === undefined || pid <= 0) return undefined
    try {
      process.kill(pid, 0)
      return { pid, alive: true }
    } catch {
      return { pid, alive: false }
    }
  } catch {
    return undefined
  }
}
