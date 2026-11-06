/**
 * 分离客户端（P2 的 D3）：连所有者管道，把 stdin 发给运行时的会话循环。
 *
 * ## 它不知道业务
 *
 * 客户端不解析任何命令语义：`/accept`、`/cancel`、`/tasks`、`/exit` 一律当普通
 * prompt 文本发出去，由 chat.ts 在服务端解析。这条边界让「管道只搬运」成立——
 * 客户端一旦开始理解任务与账本，协议就要跟着业务变，网页界面也就没法复用。
 *
 * ## 断线重连（客户端寿命与运行时寿命解耦的客户端一侧）
 *
 * 服务端已改成「客户端断开只结束本代会话，运行时与 agent 常驻」（chat-serve 的
 * accept 循环）。客户端这边对应地：**意外断开自动重连**，每次重连重读端点文件
 * （服务端重启会换管道名）。`/exit` 是主动结束，不重连。
 *
 * ## 审批输入与普通输入争用同一个 stdin
 *
 * 收到 `approval.request` 后置一个 pendingCallId，**下一条 stdin 行**被解释为
 * 该请求的答案（y/yes → 允许，其余 → 拒绝），并在应答里原样带上 callId。
 * 服务端会校验 callId，不匹配的应答被拒（stale-approval），所以这里不能凭记忆
 * 猜——每收到一个新请求就覆盖 pendingCallId。断线时清空：旧审批已随会话失效。
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Socket } from 'node:net'
import { OWNER_ENDPOINT_FILE, encode, lineParser, pipeConnect, probeEndpointOwner } from '../runtime/owner-protocol.ts'
import type { OwnerPush } from '../runtime/owner-protocol.ts'
import { reconnectDelayMs } from '../runtime/reconnect.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
if (!dataRoot) {
  console.error('prts chat:remote: 需要 PRTS_DATA_ROOT 环境变量（端点文件在它下面）')
  process.exit(2)
}

const endpointPath = join(dataRoot, OWNER_ENDPOINT_FILE)

/** 读端点文件拿管道名。每次（重）连都重读：服务端重启会换管道名。 */
function readPipeName(): string {
  const raw = JSON.parse(readFileSync(endpointPath, 'utf8')) as { pipe?: unknown }
  if (typeof raw.pipe !== 'string' || raw.pipe === '') throw new Error('endpoint 文件里没有 pipe 字段')
  return raw.pipe
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let current: Socket | undefined
let pendingCallId: string | undefined
/** 用户主动结束（/exit 或 /quit）：断开后不再重连。 */
let exiting = false

function write(message: unknown): void {
  if (current === undefined) return
  try { current.write(encode(message)) } catch { /* close 会收尾 */ }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY === true,
})

const onPush = (msg: unknown): void => {
  const push = msg as OwnerPush
  switch (push?.type) {
    case 'event':
      if (push.kind === 'turn-end') process.stdout.write('\n')
      else process.stdout.write(push.text)
      return
    case 'approval.request':
      pendingCallId = push.callId
      process.stdout.write(`\n[审批] ${push.tool} 请求越界操作：\n`)
      for (const c of push.capabilities) process.stdout.write(`  · ${c}\n`)
      if (push.reason !== '') process.stdout.write(`  理由：${push.reason}\n`)
      process.stdout.write('  批准本次？[y/N] ')
      return
    case 'status':
      // 相位变化不单独铺陈——提示符由本地的行读取循环维持。
      return
    case 'tool':
      // 工具活动流水（M3）：call 打出工具名+参数，result 只在出错时多打一行。
      if (push.phase === 'call') {
        process.stdout.write(`\n  · ${push.name} ${push.detail}\n`)
      } else if (push.isError === true) {
        process.stdout.write(`  ✗ ${push.name} ${push.detail}\n`)
      } else {
        process.stdout.write(`  ✓ ${push.name}\n`)
      }
      return
    case 'error':
      process.stdout.write(`\n[prts] ${push.code}：${push.message}\n`)
      return
    default:
      process.stdout.write('\n[prts] 无法识别的推送，已忽略\n')
  }
}

rl.on('line', (raw: string) => {
  const line = raw.trim()
  if (line === '') return
  // `/exit` 是主动结束：服务端结束本代会话并断开，客户端不再重连。
  if (line === '/exit' || line === '/quit') exiting = true
  if (pendingCallId !== undefined) {
    const callId = pendingCallId
    pendingCallId = undefined
    write({ type: 'approval.answer', callId, allow: /^y(es)?$/i.test(line) })
    process.stdout.write('\n')
    return
  }
  if (current === undefined) {
    process.stdout.write('\n[prts] 尚未连上服务端，本条消息未发送\n')
    return
  }
  write({ type: 'prompt', text: line })
})

/** 连一次并跑到断开为止（resolve 即断开，由主循环决定重连还是退出）。 */
async function runConnection(socket: Socket): Promise<void> {
  current = socket
  pendingCallId = undefined
  process.stdout.write('prts chat:remote — 已连接（输入消息开始对话；/exit 断开并退出客户端）\n')
  socket.on('data', lineParser(onPush, (raw) => {
    process.stdout.write(`\n[prts] 收到非法 JSON 行（长度 ${raw.length}），已忽略\n`)
  }))
  await new Promise<void>((resolve) => {
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  current = undefined
  pendingCallId = undefined
}

// 主循环：连接 → 会话 → 断开 →（主动退出则结束，否则退避重连）。
let attempt = 0
for (;;) {
  if (exiting) break
  let socket: Socket
  try {
    socket = await pipeConnect(readPipeName())
  } catch (error) {
    attempt += 1
    const delay = reconnectDelayMs(attempt)
    const reason = error instanceof Error ? error.message : String(error)
    // 陈旧端点：serve 被强杀时 finally 没跑到，端点仍指向死 pid，客户端只会看到
    // ENOENT。探活一次，把「该重启的是 serve」直接说出来（2026-11-06 实测踩过）。
    const ep = probeEndpointOwner(dataRoot)
    const hint = ep !== undefined && !ep.alive
      ? `\n[prts] 端点陈旧：pid ${ep.pid} 已退出——请重启 prts chat:serve（端点：${endpointPath}）`
      : ''
    process.stdout.write(
      `\n[prts] 连不上服务端（${reason}）；${Math.round(delay / 1000)}s 后重试`
      + `（第 ${attempt} 次，Ctrl+C 退出）${hint}\n`,
    )
    await sleep(delay)
    continue
  }
  attempt = 0
  await runConnection(socket)
  if (exiting) break
  process.stdout.write('\n[prts] 与服务端的连接已断开，正在重连…（Ctrl+C 退出）\n')
  await sleep(500)
}

rl.close()
process.stdout.write('[prts] 客户端已退出\n')
process.exit(0)
