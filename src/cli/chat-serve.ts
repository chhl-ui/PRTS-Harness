/**
 * 所有者通道服务端入口（P2 的 D4）：起运行时 + 起命名管道 + 跑会话循环。
 *
 * ## 启动顺序是有意义的，不是风格
 *
 * 1. 生成随机管道名并 `listenPipe`（内部同步 listen）；
 * 2. **listen 成功之后**才把名字**原子**发布到 `<dataRoot>/terminal.endpoint`
 *    （写 `.tmp` 再 rename）。反过来先发布再监听，客户端会读到「存在但还没人听」
 *    的名字——轻则 ECONNREFUSED，重则在固定名的实现里连到抢注者。
 * 3. 退出顺序相反：先删 endpoint 再关管道。
 *
 * 随机名只解决「发布瞬间被抢注」，不是安全边界：endpoint 文件在数据根下，而
 * 沙箱可读数据根（H3 实测），所以读到名字就能连。P2 的安全只有 T1 验的
 * 完整性隔离这一道。
 *
 * ## deps.out 必须接到管道
 *
 * chat.ts 里宿主输出（/tasks 回显、批准结果、用法提示）走 `deps.out`，
 * 模型文本走 `onAssistantDelta`（A1 已分流，二者互斥）。不接 out 的话，
 * 所有宿主回显都会打进服务端进程的 stdout，分离客户端看不到——
 * 而这不会让任何断言变红。
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadApiKey } from './secret.ts'
import { startRuntime } from '../runtime/start.ts'
import { runChat, describeOpenTasks } from './chat.ts'
import { OWNER_ENDPOINT_FILE, ownerTermPipeName } from '../runtime/owner-protocol.ts'
import { createTerminalServer } from '../runtime/terminal-server.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
const workspace = process.env.PRTS_WORKSPACE
const configPath = process.env.PRTS_CONFIG
if (!dataRoot || !workspace || !configPath) {
  console.error('prts chat:serve: 需要 PRTS_DATA_ROOT / PRTS_WORKSPACE / PRTS_CONFIG 三个环境变量')
  process.exit(2)
}

const loaded = loadApiKey({
  target: 'PRTS/DeepSeek',
  keyFile: join(dataRoot, 'secrets', 'deepseek.key'),
  envName: 'DEEPSEEK_API_KEY',
})
for (const warning of loaded.warnings) console.error(`prts chat:serve: ${warning}`)
const credentials: { DEEPSEEK_API_KEY?: string } | undefined =
  loaded.key === undefined ? undefined : { DEEPSEEK_API_KEY: loaded.key }

const endpointPath = join(dataRoot, OWNER_ENDPOINT_FILE)
const tmpPath = `${endpointPath}.tmp`
const pipeName = ownerTermPipeName()

// 1) 先监听。listen 失败（如偶然撞名）直接抛错退出——不重试到悄悄改名。
const term = createTerminalServer(pipeName)

// 2) 再原子发布。写 .tmp 再 rename，读方要么看不到文件、要么看到完整内容。
mkdirSync(dataRoot, { recursive: true })
writeFileSync(tmpPath, JSON.stringify({ pipe: pipeName, pid: process.pid, startedAt: Date.now() }), 'utf8')
renameSync(tmpPath, endpointPath)
console.error(`prts chat:serve — 端点已发布：${endpointPath}`)
console.error(`prts chat:serve — 管道：${pipeName}（只接受一个客户端；断开后服务退出）`)

const app = await startRuntime({
  configPath,
  dataRoot,
  workspace,
  mode: 'normal',
  credentials,
})

try {
  const hint = describeOpenTasks(app.ledger)
  if (hint !== '') term.pushHostOutput(hint + '\n')
  term.pushHostOutput('prts — 已连接。输入消息开始对话；/exit 结束服务端。\n')

  const result = await runChat({
    ctx: app.ctx,
    lines: term.lines,
    out: (text) => term.pushHostOutput(text),
    cwd: workspace,
    dataRoot,
    ledger: app.ledger,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
    draftTaskForSession: app.draftTaskForSession,
    // 模型文本：与 out 互斥（A1 在 chat.ts 里做的分流），不会同时走两条。
    onAssistantDelta: (text) => term.pushModelDelta(text),
    approvalChannel: { ask: (info) => term.requestApproval(info) },
    onTurnEnd: (info) => term.pushTurnEnd(info.text ?? ''),
  })
  console.error(`prts chat:serve — 会话结束，共 ${result.turns} 轮`)
} finally {
  // 3) 退出顺序与启动相反：先撤端点，再关管道。
  try { rmSync(endpointPath, { force: true }) } catch { /* 已被删 */ }
  term.close()
  await app.dispose()
}
