/**
 * 分离客户端（P2 的 D3）：连所有者管道，把 stdin 发给运行时的会话循环。
 *
 * ## 它不知道业务
 *
 * 客户端不解析任何命令语义：`/accept`、`/cancel`、`/tasks`、`/exit` 一律当普通
 * prompt 文本发出去，由 chat.ts 在服务端解析。这条边界让「管道只搬运」成立——
 * 客户端一旦开始理解任务与账本，协议就要跟着业务变，网页界面也就没法复用。
 *
 * ## 审批输入与普通输入争用同一个 stdin
 *
 * 收到 `approval.request` 后置一个 pendingCallId，**下一条 stdin 行**被解释为
 * 该请求的答案（y/yes → 允许，其余 → 拒绝），并在应答里原样带上 callId。
 * 服务端会校验 callId，不匹配的应答被拒（stale-approval），所以这里不能凭记忆
 * 猜——每收到一个新请求就覆盖 pendingCallId。
 */
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OWNER_ENDPOINT_FILE, encode, lineParser, pipeConnect } from '../runtime/owner-protocol.ts'
import type { OwnerPush } from '../runtime/owner-protocol.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
if (!dataRoot) {
  console.error('prts chat:remote: 需要 PRTS_DATA_ROOT 环境变量（端点文件在它下面）')
  process.exit(2)
}

const endpointPath = join(dataRoot, OWNER_ENDPOINT_FILE)
let pipeName: string
try {
  const raw = JSON.parse(readFileSync(endpointPath, 'utf8')) as { pipe?: unknown }
  if (typeof raw.pipe !== 'string' || raw.pipe === '') throw new Error('endpoint 文件里没有 pipe 字段')
  pipeName = raw.pipe
} catch (error) {
  console.error(
    `prts chat:remote: 读不到端点文件 ${endpointPath}（${error instanceof Error ? error.message : String(error)}）。`
    + '常见原因：服务端没起，或 PRTS_DATA_ROOT 指到了别的数据根。',
  )
  process.exit(2)
}

const socket = await pipeConnect(pipeName).catch((error: unknown) => {
  console.error(
    `prts chat:remote: 连不上管道 ${pipeName}（${error instanceof Error ? error.message : String(error)}）。`
    + '服务端可能已退出或端点文件过期。',
  )
  process.exit(2)
})

let pendingCallId: string | undefined
let closing = false

function write(message: unknown): void {
  if (closing) return
  try { socket.write(encode(message)) } catch { /* 下面 close 会收尾 */ }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })

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
    case 'error':
      process.stdout.write(`\n[prts] ${push.code}：${push.message}\n`)
      return
    default:
      process.stdout.write(`\n[prts] 无法识别的推送，已忽略\n`)
  }
}

socket.on('data', lineParser(onPush, (raw) => {
  process.stdout.write(`\n[prts] 收到非法 JSON 行（长度 ${raw.length}），已忽略\n`)
}))

socket.on('close', () => {
  if (closing) return
  closing = true
  process.stdout.write('\n[prts] 与服务端的连接已断开\n')
  rl.close()
  process.exitCode = 0
})

socket.on('error', (error: Error) => {
  process.stdout.write(`\n[prts] 连接错误：${error.message}\n`)
})

rl.on('line', (raw: string) => {
  const line = raw.trim()
  if (line === '') return
  // `/exit` 在分离模式下有两层含义：先让服务端结束会话循环，再关闭本地连接。
  // 这里只发文本（命令语义归服务端），本地退出由服务端 EOF 触发。
  if (pendingCallId !== undefined) {
    const callId = pendingCallId
    pendingCallId = undefined
    write({ type: 'approval.answer', callId, allow: /^y(es)?$/i.test(line) })
    process.stdout.write('\n')
    return
  }
  write({ type: 'prompt', text: line })
})

process.stdout.write(`prts chat:remote — 已连接（${pipeName}）\n`)
process.stdout.write('输入消息开始对话；/exit 结束服务端\n')
