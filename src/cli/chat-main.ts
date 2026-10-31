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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime } from '../runtime/start.ts'
import { runChat } from './chat.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
const workspace = process.env.PRTS_WORKSPACE
const configPath = process.env.PRTS_CONFIG
if (!dataRoot || !workspace || !configPath) {
  console.error('prts chat: 需要 PRTS_DATA_ROOT / PRTS_WORKSPACE / PRTS_CONFIG 三个环境变量')
  process.exit(2)
}

let credentials: { DEEPSEEK_API_KEY?: string } | undefined
const keyFile = join(dataRoot, 'secrets', 'deepseek.key')
if (existsSync(keyFile)) {
  credentials = { DEEPSEEK_API_KEY: readFileSync(keyFile, 'utf8').trim() }
} else {
  console.error(`prts chat: 未找到 ${keyFile}，将以无 key 状态启动（模型调用会失败）`)
}

const app = await startRuntime({
  configPath,
  dataRoot,
  workspace,
  mode: 'normal',
  credentials,
})

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })

async function* stdinLines(): AsyncIterable<string> {
  for await (const line of rl) yield line
}

process.stdout.write('prts chat — 输入消息开始对话，/exit 退出，Ctrl-C 中断\nprts> ')
try {
  const result = await runChat({
    ctx: app.ctx,
    lines: stdinLines(),
    out: (text) => process.stdout.write(text + '\n'),
    cwd: workspace,
    dataRoot,
    onIdle: () => process.stdout.write('prts> '),
  })
  process.stdout.write(`\n[prts] 共 ${result.turns} 轮\n`)
} finally {
  rl.close()
  await app.dispose()
}
