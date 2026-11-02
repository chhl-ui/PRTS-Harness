/**
 * `prts chat` 入口：进程内 REPL。
 *
 * 用法：
 *   PRTS_DATA_ROOT=C:\prts-data PRTS_WORKSPACE=C:\prts-workspace \
 *   PRTS_CONFIG=C:\prts-system\config\prts.yml npm run chat
 *
 * 缺少任一环境变量直接退出（不猜默认值）。
 */
import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import { join } from 'node:path'
import { loadApiKey } from './secret.ts'
import { startRuntime } from '../runtime/start.ts'
import { runChat, describeOpenTasks } from './chat.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
const workspace = process.env.PRTS_WORKSPACE
const configPath = process.env.PRTS_CONFIG
if (!dataRoot || !workspace || !configPath) {
  console.error('prts chat: 需要 PRTS_DATA_ROOT / PRTS_WORKSPACE / PRTS_CONFIG 三个环境变量')
  process.exit(2)
}

// 密钥来源按「被随手读到的门槛」排序：凭据管理器 → 环境变量（读到即清除）→ 文件。
// 文件路径会给出警告——那是模型 shell 用 Get-Content 就能读走的位置。
const loaded = loadApiKey({
  target: 'PRTS/DeepSeek',
  keyFile: join(dataRoot, 'secrets', 'deepseek.key'),
  envName: 'DEEPSEEK_API_KEY',
})
for (const warning of loaded.warnings) console.error(`prts chat: ${warning}`)
const credentials: { DEEPSEEK_API_KEY?: string } | undefined =
  loaded.key === undefined ? undefined : { DEEPSEEK_API_KEY: loaded.key }

/**
 * 行源：readline 一建立就收集行，而不是等 runChat 开始迭代时才消费。
 *
 * 必须在 startRuntime 之前调用——startRuntime 要几秒，这期间若 stdin 没有消费者，
 * 已写入的行会丢（Windows 管道实测：`printf 'hi\n/exit\n' | node src/cli/chat-main.ts`
 * 曾出现只收到 `/exit`、`hi` 静默丢失，表现为「共 0 轮」）。
 * 迭代器在 close 之后仍会 drain 掉已缓冲的行，不吞末尾输入。
 */
function lineSource(rl: ReadlineInterface): AsyncIterable<string> {
  const pending: string[] = []
  const waiters: ((r: IteratorResult<string>) => void)[] = []
  let closed = false
  rl.on('line', (line) => {
    const wake = waiters.shift()
    if (wake !== undefined) wake({ value: line, done: false })
    else pending.push(line)
  })
  rl.on('close', () => {
    closed = true
    for (const wake of waiters.splice(0)) wake({ value: undefined as never, done: true })
  })
  return {
    [Symbol.asyncIterator]: () => ({
      next(): Promise<IteratorResult<string>> {
        if (pending.length > 0) return Promise.resolve({ value: pending.shift() as string, done: false })
        if (closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => { waiters.push(resolve) })
      },
    }),
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
// 先建立行收集，再拉起运行时——顺序反了就会丢早到的输入。
const lines = lineSource(rl)

const app = await startRuntime({
  configPath,
  dataRoot,
  workspace,
  mode: 'normal',
  credentials,
})

// 启动线索：把未结任务列出来，让博士自己决定接不接——不自动恢复执行。
const openTasksHint = describeOpenTasks(app.ledger)
if (openTasksHint !== '') process.stdout.write(openTasksHint + '\n')
process.stdout.write('prts chat — 输入消息开始对话，/exit 退出，Ctrl-C 中断\nprts> ')
try {
  const result = await runChat({
    ctx: app.ctx,
    lines,
    // out 只写原文：增量输出时每片都是半句，换行由回合边界（onIdle）负责。
    out: (text) => process.stdout.write(text),
    cwd: workspace,
    dataRoot,
    // 账本句柄来自 startRuntime（W0）。不传的话 /task 系列命令会在终端里报不可用。
    ledger: app.ledger,
    // P0-2a：所有者记忆命令（/memory /forget /correct）——同库同句柄，不再开第二个 store。
    memory: app.memory,
    dbPath: app.dbPath,
    // E3 审批：授权句柄 + 能力桥都来自 startRuntime；缺任一则越界操作 fail-closed。
    authority: app.authority,
    approvalBridge: app.approvalBridge,
    // 无参 /task-approve 的寻址：draft 不绑定会话，只能靠这条进程内指针。
    draftTaskForSession: app.draftTaskForSession,
    // 回合结束先换行再打提示符，保证提示符另起一行（流式文本本身不带尾换行）。
    onIdle: () => process.stdout.write('\nprts> '),
  })
  process.stdout.write(`\n[prts] 共 ${result.turns} 轮\n`)
} finally {
  rl.close()
  await app.dispose()
}
