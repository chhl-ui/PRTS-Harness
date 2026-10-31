/**
 * 所有者通道服务端（P2 的 D2）：把命名管道的 push 消息流转成 runChat 需要的 pull 形态。
 *
 * ## 为什么需要这一层
 *
 * `runChat` 的输入是 `AsyncIterable<string>`（它按行 await），而管道是 push。
 * 中间必须有带缓冲的队列 + promise 在两边搭桥。这一层只搬运，不解析：`prompt`
 * 文本原样交给 runChat，`/accept`、`/tasks` 仍由 chat.ts 解析，管道模式与 REPL
 * 行为逐字一致。
 *
 * ## 状态机由 approvalChannel 驱动，不靠文本推断
 *
 * - `idle`：接受 prompt / status；approval.answer 一律回 stale-approval（没有 pending）。
 * - `awaiting-approval`：由 `requestApproval()` 进入并记下 pendingCallId；只接受
 *   callId 逐字相等的 approval.answer；此时到达的 prompt **回错不入队**——默默排队
 *   会让审批结束后凭空多出一轮对话。
 * - `closing`：客户端断开或 `close()` 之后，入站请求全部回错，不再入队。
 *
 * ## 断开语义
 *
 * 客户端断开只做两件事：把未结算的审批按 false（拒绝）结算，然后送 EOF。
 * 它**不中断飞行中的回合**——回合收敛由 chat.ts 的 `waitIdle(agent)` 控制
 * （默认上限 120s），本层拿不到 agent 句柄。所以「断开后模型调用数还在涨」是
 * 预期行为，衡量「是否停止接新活」的指标是**新回合起始数**，不是模型调用次数。
 */
import type { Socket } from 'node:net'
import {
  approvalRequestPush,
  decodeOwnerRequest,
  encode,
  errorPush,
  eventPush,
  lineParser,
  listenPipe,
  statusPush,
} from './owner-protocol.ts'
import type { OwnerPhase, OwnerPush } from './owner-protocol.ts'

export interface ApprovalAskInfo {
  callId: string
  tool: string
  capabilities: readonly string[]
  reason: string
}

export interface TerminalServer {
  /** 交给 runChat 的输入流；客户端断开或 close() 后正常结束（EOF）。 */
  lines: AsyncIterable<string>
  /** 模型文本增量 → event{kind:'delta'}。 */
  pushModelDelta(text: string): void
  /** 宿主输出（/tasks 回显、批准结果、用法提示）→ event{kind:'host'}。 */
  pushHostOutput(text: string): void
  /** 回合结束 → event{kind:'turn-end'}。 */
  pushTurnEnd(text: string): void
  /** 作为 ChatDeps.approvalChannel.ask 的实现。 */
  requestApproval(info: ApprovalAskInfo): Promise<boolean>
  /** 当前是否已有客户端连着（便于测试与日志）。 */
  hasClient(): boolean
  /** 关管道并让 lines 结束；幂等。 */
  close(): void
}

export function createTerminalServer(pipeName: string): TerminalServer {
  const queue: string[] = []
  const waiters: ((v: string | null) => void)[] = []
  let closed = false
  let client: Socket | undefined
  let phase: OwnerPhase = 'idle'
  let pending: { callId: string; resolve: (allow: boolean) => void; settled: boolean } | undefined

  const pipe = listenPipe(pipeName)

  const push = (msg: OwnerPush): void => {
    if (client === undefined) return
    try { client.write(encode(msg)) } catch { /* 写失败等同断开，由 close 事件收尾 */ }
  }

  /** 把一行交给 runChat：有人等着就直接给，否则入队。 */
  const deliver = (line: string): void => {
    const w = waiters.shift()
    if (w !== undefined) w(line)
    else queue.push(line)
  }

  /** 让 lines 结束：唤醒所有等待者并给 null。 */
  const eof = (): void => {
    closed = true
    for (const w of waiters.splice(0)) w(null)
  }

  /** 结算 pending 审批；settled 标志保证不二次 resolve。 */
  const settle = (allow: boolean): void => {
    const p = pending
    if (p === undefined || p.settled) return
    p.settled = true
    pending = undefined
    phase = 'idle'
    push(statusPush('idle'))
    p.resolve(allow)
  }

  const onClientClose = (): void => {
    client = undefined
    // 审批等待中客户端断线：按拒绝结算（fail-closed），否则 answerer 会永久挂起。
    settle(false)
    eof()
  }

  const onLine = (msg: unknown): void => {
    const req = decodeOwnerRequest(msg)
    if (req === null) {
      push(errorPush('bad-request', '无法识别的请求，已忽略'))
      return
    }
    if (req.type === 'status') {
      push(statusPush(phase))
      return
    }
    if (req.type === 'approval.answer') {
      if (pending === undefined) {
        push(errorPush('stale-approval', '当前没有待审批请求'))
        return
      }
      if (pending.callId !== req.callId) {
        push(errorPush('stale-approval', `应答的 callId 与待审批请求不符（期望 ${pending.callId}）`))
        return
      }
      settle(req.allow)
      return
    }
    // prompt
    if (closed) {
      push(errorPush('internal', '通道已关闭'))
      return
    }
    if (pending !== undefined) {
      // 不排队：排队会让审批结束后凭空多出一轮对话。
      push(errorPush('bad-request', '正在等待审批应答，本轮 prompt 未入队'))
      return
    }
    deliver(req.text)
  }

  const onBadLine = (raw: string): void => {
    push(errorPush('bad-request', `不是合法 JSON 行（长度 ${raw.length}）`))
  }

  pipe.server.on('connection', (socket: Socket) => {
    if (client !== undefined) {
      // 单客户端：runChat 是单会话长循环，多客户端会争抢同一个输入迭代器。
      try {
        socket.write(encode(errorPush('busy', '已有客户端连接，同一时刻只接受一个')))
        socket.end()
      } catch { /* 对端已断 */ }
      return
    }
    client = socket
    phase = 'idle'
    socket.on('data', lineParser(onLine, onBadLine))
    socket.on('close', onClientClose)
    socket.on('error', onClientClose)
    push(statusPush(phase))
  })

  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          const queued = queue.shift()
          if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
          if (closed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise<IteratorResult<string>>((resolve) => {
            waiters.push((v) => {
              if (v === null) resolve({ value: undefined as never, done: true })
              else resolve({ value: v, done: false })
            })
          })
        },
      }
    },
  }

  return {
    lines,
    pushModelDelta(text: string): void { push(eventPush('delta', text)) },
    pushHostOutput(text: string): void { push(eventPush('host', text)) },
    pushTurnEnd(text: string): void { push(eventPush('turn-end', text)) },
    requestApproval(info: ApprovalAskInfo): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (closed || client === undefined) {
          // 没有人能回答：按拒绝结算，不挂着。与 DSH 无 answerer 时的 fail-closed 同向。
          resolve(false)
          return
        }
        pending = { callId: info.callId, resolve, settled: false }
        phase = 'awaiting-approval'
        push(approvalRequestPush(info.callId, info.tool, info.capabilities, info.reason))
        push(statusPush(phase))
      })
    },
    hasClient(): boolean { return client !== undefined },
    close(): void {
      settle(false)
      pipe.close()
      client = undefined
      eof()
    },
  }
}
