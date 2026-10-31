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

export type OwnerRequest = PromptRequest | ApprovalAnswerRequest | StatusRequest

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
 * `stale-approval` —— 应答的 callId 与 pending 不符，或当前根本没有待审批请求（不结算）；
 * `bad-request` —— 收到坏行、无法识别的请求，或该状态下不该出现的请求（如审批期内的 prompt）；
 * `busy` —— 已有客户端连着（runChat 是单会话长循环，多客户端会争抢同一个输入迭代器）；
 * `internal` —— 服务端内部错误。
 */
export type OwnerErrorCode = 'stale-approval' | 'bad-request' | 'busy' | 'internal'

export interface ErrorPush {
  type: 'error'
  code: OwnerErrorCode
  message: string
}

export type OwnerPush = EventPush | ApprovalRequestPush | StatusPush | ErrorPush

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

export function errorPush(code: OwnerErrorCode, message: string): ErrorPush {
  return { type: 'error', code, message }
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
    default:
      return null
  }
}
