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
 * ## 会话代际：断开 ≠ 关闭（客户端寿命与运行时寿命解耦）
 *
 * 改造前：客户端断开 → `lines` 永久 EOF（`closed=true`）→ 服务端只能退出，
 * 运行时随客户端一起销毁（`chat-serve.ts` 的 finally）。
 *
 * 改造后本层提供 `accept()`：**每次客户端连接是一代会话**，断开只让本代输入流
 * EOF；服务端可以继续 `accept()` 下一个客户端，运行时与 agent 不跟着销毁。
 * `endSession()` 是服务端主动结束当前代（例如 `/exit` 之后）；`close()` 才是终局，
 * 关管道并让 `accept()` 返回 `undefined`。
 *
 * 单客户端约束不变：同一时刻只接受一个连接（runChat 是单会话长循环）。
 *
 * ## 状态机由 approvalChannel 驱动，不靠文本推断
 *
 * - `idle`：接受 prompt / status；approval.answer 一律回 stale-approval（没有 pending）。
 * - `awaiting-approval`：由 `requestApproval()` 进入并记下 pendingCallId；只接受
 *   callId 逐字相等的 approval.answer；此时到达的 prompt **回错不入队**——默默排队
 *   会让审批结束后凭空多出一轮对话。
 * - `closing`（服务端 close）：客户端断开或 `close()` 之后，入站请求全部回错，不再入队。
 *
 * ## 断开语义
 *
 * 客户端断开只做两件事：把未结算的审批按 false（拒绝）结算，然后让本代输入流
 * EOF。它**不中断飞行中的回合**——回合收敛由 chat.ts 的 `waitIdle(agent)` 控制
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

/** 一代客户端连接：独立的输入队列，断开只结束自己。 */
interface Connection {
  queue: string[]
  waiters: ((v: string | null) => void)[]
  ended: boolean
}

export interface TerminalServer {
  /** 管道名（日志与测试用）。 */
  readonly pipeName: string
  /**
   * 等下一个客户端并返回该连接的输入流；`close()` 之后返回 `undefined`。
   * 已连接但尚未被 accept 消费的会话会被缓存，不会丢。
   */
  accept(): Promise<AsyncIterable<string> | undefined>
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
  /** 主动结束当前代会话（EOF + 断开该客户端）；不关管道，可重复调用。 */
  endSession(): void
  /** 关管道并让 accept 返回 undefined；幂等。 */
  close(): void
}

export function createTerminalServer(pipeName: string): TerminalServer {
  let closed = false
  let client: Socket | undefined
  let current: Connection | undefined
  /** 已连接但还没被 accept 取走的会话（客户端可能先于 accept 连上）。 */
  let pendingLines: AsyncIterable<string> | undefined
  let acceptWaiter: ((v: AsyncIterable<string> | undefined) => void) | undefined
  let phase: OwnerPhase = 'idle'
  let pending: { callId: string; resolve: (allow: boolean) => void; settled: boolean } | undefined
  /**
   * 客户端连上之前产生的宿主输出。
   *
   * 实测痛点：chat-serve 在 runChat 之前就 push 开场白与未结任务提示，
   * 那一刻还没有客户端，按「没有 client 就丢弃」处理会让开场消息永久消失——
   * 而人连上后看到的是一片空白，没有任何线索说明为什么。
   * 只缓存 host 类（delta / turn-end 是回合内产生的，没有客户端时本就不该发）。
   */
  const preamble: string[] = []
  const PREAMBLE_LIMIT = 50

  const pipe = listenPipe(pipeName)

  const push = (msg: OwnerPush): void => {
    if (client === undefined) return
    try { client.write(encode(msg)) } catch { /* 写失败等同断开，由 close 事件收尾 */ }
  }

  /** 把一行交给本代会话：有人等着就直接给，否则入队。 */
  const deliver = (conn: Connection, line: string): void => {
    const w = conn.waiters.shift()
    if (w !== undefined) w(line)
    else conn.queue.push(line)
  }

  /** 让一代输入流结束：唤醒所有等待者并给 null。 */
  const endConn = (conn: Connection): void => {
    conn.ended = true
    for (const w of conn.waiters.splice(0)) w(null)
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

  const offerToAcceptor = (lines: AsyncIterable<string>): void => {
    if (acceptWaiter !== undefined) {
      const resolve = acceptWaiter
      acceptWaiter = undefined
      resolve(lines)
      return
    }
    pendingLines = lines
  }

  const onClientClose = (conn: Connection): void => {
    if (current !== conn) return
    client = undefined
    current = undefined
    // 未被 accept 消费就断了：丢弃，等下一个连接。
    pendingLines = undefined
    // 审批等待中客户端断线：按拒绝结算（fail-closed），否则 answerer 会永久挂起。
    settle(false)
    endConn(conn)
  }

  const onLine = (conn: Connection, msg: unknown): void => {
    if (conn.ended) return
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
    deliver(conn, req.text)
  }

  const onBadLine = (raw: string): void => {
    push(errorPush('bad-request', `不是合法 JSON 行（长度 ${raw.length}）`))
  }

  const makeLines = (conn: Connection): AsyncIterable<string> => ({
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next(): Promise<IteratorResult<string>> {
          const queued = conn.queue.shift()
          if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
          if (conn.ended || closed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise<IteratorResult<string>>((resolve) => {
            conn.waiters.push((v) => {
              if (v === null) resolve({ value: undefined as never, done: true })
              else resolve({ value: v, done: false })
            })
          })
        },
      }
    },
  })

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
    const conn: Connection = { queue: [], waiters: [], ended: false }
    current = conn
    socket.on('data', lineParser((msg) => onLine(conn, msg), onBadLine))
    socket.on('close', () => onClientClose(conn))
    socket.on('error', () => onClientClose(conn))
    // 补发客户端连上之前产生的宿主输出（开场白、未结任务提示），否则人会看到一片空白。
    for (const text of preamble.splice(0)) push(eventPush('host', text))
    push(statusPush(phase))
    offerToAcceptor(makeLines(conn))
  })

  return {
    pipeName,
    accept(): Promise<AsyncIterable<string> | undefined> {
      if (closed) return Promise.resolve(undefined)
      if (pendingLines !== undefined) {
        const lines = pendingLines
        pendingLines = undefined
        return Promise.resolve(lines)
      }
      return new Promise<AsyncIterable<string> | undefined>((resolve) => { acceptWaiter = resolve })
    },
    pushModelDelta(text: string): void { push(eventPush('delta', text)) },
    pushHostOutput(text: string): void {
      if (client === undefined && preamble.length < PREAMBLE_LIMIT) preamble.push(text)
      push(eventPush('host', text))
    },
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
    endSession(): void {
      const conn = current
      const socket = client
      settle(false)
      current = undefined
      client = undefined
      pendingLines = undefined
      if (conn !== undefined) endConn(conn)
      try { socket?.destroy() } catch { /* 已断 */ }
    },
    close(): void {
      if (closed) return
      closed = true
      settle(false)
      const conn = current
      const socket = client
      current = undefined
      client = undefined
      pendingLines = undefined
      pipe.close()
      if (conn !== undefined) endConn(conn)
      // 主动断开客户端：只把引用置空的话，对端要等服务端进程真正退出才能感知，
      // 而进程退出前还可能有一段 dispose 时间——实测客户端会一直挂着。
      try { socket?.destroy() } catch { /* 已断 */ }
      if (acceptWaiter !== undefined) {
        const resolve = acceptWaiter
        acceptWaiter = undefined
        resolve(undefined)
      }
    },
  }
}
