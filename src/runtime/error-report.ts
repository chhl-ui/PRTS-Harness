/**
 * agent/error 消费方：把 turn 内失败报告到 stderr。
 *
 * 为什么需要：dsh-agent-loop（0.2.1-rc.2）的 throwError() 先
 * `dispatch.emit('agent/error', { turn, step, error })` 再 throw，而 kick() 的
 * `catch (_error) {}` 只吞掉异常传播、不上报——所以 agent/error 是 turn 内失败
 * 的唯一上报通道。没有订阅方时失败完全静默，对话表现为一直不回复。
 *
 * 脱敏边界：只输出 turn/step/name/code 与脱敏、单行化后的 message 首段；
 * 不输出 error 的其余字段（payload / headers / request 片段），并把常见凭据
 * 形态（x-api-key、Authorization、Bearer、sk-*）替换为 <redacted>。
 */
import type {} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

/** agent/error 的结构化摘要（测试与日志文件通道的稳定形状）。 */
export interface AgentErrorEntry {
  turn: number
  step: number
  name: string
  code?: string
  message: string
  /** cause 链的 name/code 摘要，从直接原因由内向外。 */
  chain: string[]
}

export interface ErrorReporterOptions {
  /** 行输出目标；默认 process.stderr。测试注入收集器。 */
  sink?: (line: string) => void
  /** 每次上报后回调，供错误计数/断言等稳定通道消费。 */
  onReport?: (entry: AgentErrorEntry) => void
}

const MAX_MESSAGE = 300
const MAX_CHAIN = 4

/** 凭据形态脱敏：message 原样打出会泄露 URL / header / 请求片段。 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\b(sk-[A-Za-z0-9_-]{4,})/g, '<redacted>'],
  [/(x-api-key\s*[:=]\s*)\S+/gi, '$1<redacted>'],
  [/(api[_-]?key\s*[:=]\s*)\S+/gi, '$1<redacted>'],
  [/(authorization\s*[:=]\s*)(?:\S+\s+)?\S+/gi, '$1<redacted>'],
  [/(\bbearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>'],
]

function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

function field(target: unknown, key: string): string | undefined {
  if (target === null || typeof target !== 'object') return undefined
  const value = (target as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function errorName(error: unknown): string {
  return field(error, 'name') ?? (error instanceof Error ? 'Error' : typeof error)
}

function errorCode(error: unknown): string | undefined {
  const code = field(error, 'code') ?? field(error, 'type')
  return code
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    const json = JSON.stringify(error)
    return json === undefined ? String(error) : json
  } catch {
    return String(error)
  }
}

/** 沿 cause 链收集 name/code 摘要；不读其它字段，避免把 payload 带进日志。 */
function errorChain(error: unknown): string[] {
  const chain: string[] = []
  let cursor: unknown = error
  while (cursor !== null && typeof cursor === 'object' && chain.length < MAX_CHAIN) {
    const cause: unknown = (cursor as { cause?: unknown }).cause
    if (cause === undefined || cause === null) break
    const code = errorCode(cause)
    chain.push(code ? `${errorName(cause)}(${code})` : errorName(cause))
    cursor = cause
  }
  return chain
}

/** 把 agent/error payload 归一化成可断言的结构。 */
export function toAgentErrorEntry(payload: { turn?: unknown; step?: unknown; error?: unknown }): AgentErrorEntry {
  const turn = typeof payload.turn === 'number' ? payload.turn : 0
  const step = typeof payload.step === 'number' ? payload.step : 0
  const message = redact(errorMessage(payload.error).replace(/\s+/g, ' ').trim()).slice(0, MAX_MESSAGE)
  const code = errorCode(payload.error)
  return {
    turn,
    step,
    name: errorName(payload.error),
    ...(code === undefined ? {} : { code }),
    message,
    chain: errorChain(payload.error),
  }
}

/** 单行日志格式：`[prts] agent error turn=1 step=1 name=LlmError code=TRANSPORT: ...` */
export function formatAgentError(entry: AgentErrorEntry): string {
  const code = entry.code === undefined ? '' : ` code=${entry.code}`
  const chain = entry.chain.length === 0 ? '' : ` (cause: ${entry.chain.join(' <- ')})`
  return `[prts] agent error turn=${entry.turn} step=${entry.step} name=${entry.name}${code}: ${entry.message}${chain}`
}

/**
 * 订阅 ctx.events 的 agent/error，把每条失败写到 stderr（或注入的 sink）。
 * 返回解绑函数；监听本身也随 ctx 的 fiber 自动释放。
 */
export function attachErrorReporter(ctx: Pick<Context, 'events'>, options: ErrorReporterOptions = {}): () => void {
  const sink = options.sink ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const off = ctx.events.on('agent/error', (payload) => {
    const entry = toAgentErrorEntry(payload)
    sink(formatAgentError(entry))
    options.onReport?.(entry)
  })
  return () => { off() }
}
