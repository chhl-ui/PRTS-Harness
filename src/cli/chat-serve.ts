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
import { OWNER_ENDPOINT_FILE, ownerTermPipeName, queryErrorPush } from '../runtime/owner-protocol.ts'
import type { QueryRequest, QueryResultPush } from '../runtime/owner-protocol.ts'
import { createTerminalServer, attachToolFeed } from '../runtime/terminal-server.ts'
import { createOwnerQuery } from '../runtime/owner-query.ts'
import type { QueryAgentRegistry } from '../runtime/owner-query.ts'
import { profileEnv, readProfileIfPresent } from '../runtime/model-profile.ts'

const dataRoot = process.env.PRTS_DATA_ROOT
const workspace = process.env.PRTS_WORKSPACE
const configPath = process.env.PRTS_CONFIG
if (!dataRoot || !workspace || !configPath) {
  console.error('prts chat:serve: 需要 PRTS_DATA_ROOT / PRTS_WORKSPACE / PRTS_CONFIG 三个环境变量')
  process.exit(2)
}

// 模型后端 profile（桌面端可切）：**只在 profile 文件存在时**接管环境变量。
// 手动调试（`DEEPSEEK_BASE_URL=... node src/cli/chat-serve.ts`）不会被默认预设默默覆盖。
const activeProfile = readProfileIfPresent(dataRoot)
if (activeProfile !== undefined) {
  for (const [name, value] of Object.entries(profileEnv(activeProfile))) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  console.error(`prts chat:serve — 模型：${activeProfile.label}（窗口 ${activeProfile.contextWindow}）`)
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
// 只读查询的处理器要等 runtime 起来才有数据源，所以先留槽：就绪前一律回
// unavailable（不是 error——客户端会把无 id 的 error 判成「不支持 query」并永久停用）。
let handleQuery: ((req: QueryRequest) => Promise<QueryResultPush>) | undefined
const term = createTerminalServer(pipeName, {
  onQuery: (req) => handleQuery === undefined
    ? Promise.resolve(queryErrorPush(req.id, req.what, 'unavailable', '运行时尚未就绪'))
    : handleQuery(req),
})

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

// M3：工具活动上通道——UI 侧的活动流水（桌面客户端与 chat:remote 都能看到
// 模型调用的是哪个工具）。纯观测，不进入守卫/审批路径。
const detachToolFeed = attachToolFeed(app.ctx, term)

// 服务端会话 id 固定：重连沿用同一个会话与 agent，而不是每次连上都开新会话。
const serveSessionId = process.env.PRTS_SESSION_ID ?? `prts-serve-${process.pid}`
// 只读查询（桌面端任务 / 会话 / 记忆 / 意图页）：处理器与 terminal-pipe 的 rig 共用
// 同一实现（owner-query.ts）——「测试与入口同构」靠共用代码保证，不靠两边对齐。
// 当前会话可变（`/switch` `/new` 经 runChat 回调），所以传取值函数而不是值。
let currentSessionId = serveSessionId
handleQuery = createOwnerQuery({
  ledger: app.ledger,
  memory: app.memory,
  sessionsRoot: join(dataRoot, 'dsh-home', 'sessions'),
  agents: app.ctx.get('agents') as QueryAgentRegistry | undefined,
  currentSessionId: () => currentSessionId,
  sandboxModeFor: app.sandboxModeFor,
})
// 进程信号才整体退出；客户端断开不是退出理由（客户端寿命与运行时寿命解耦）。
process.on('SIGINT', () => term.close())
process.on('SIGTERM', () => term.close())

try {
  const hint = describeOpenTasks(app.ledger)
  if (hint !== '') term.pushHostOutput(hint + '\n')

  for (;;) {
    const lines = await term.accept()
    if (lines === undefined) break
    term.pushHostOutput('prts — 已连接。输入消息开始对话；/exit 断开连接（服务端继续运行）。\n')
    const result = await runChat({
      ctx: app.ctx,
      lines,
      out: (text) => term.pushHostOutput(text),
      cwd: workspace,
      dataRoot,
      sessionId: serveSessionId,
      ledger: app.ledger,
      authority: app.authority,
      approvalBridge: app.approvalBridge,
      draftTaskForSession: app.draftTaskForSession,
      // 只读查询的 boundTaskId 要跟着当前会话走。
      onSessionChange: (id) => { currentSessionId = id },
      // Wave 3 分派器：/dispatch 用。worker 与主会话同一 provider/model（与
      // start.ts 的 createSubtaskTool 取法一致），派生目录落在 workspace 下。
      dispatch: {
        workspace,
        provider: 'deepseek-official',
        model: 'deepseek-chat',
      },
      // 模型文本：与 out 互斥（A1 在 chat.ts 里做的分流），不会同时走两条。
      onAssistantDelta: (text) => term.pushModelDelta(text),
      approvalChannel: { ask: (info) => term.requestApproval(info) },
      onTurnEnd: (info) => term.pushTurnEnd(info.text ?? ''),
    })
    console.error(`prts chat:serve — 本代会话结束，共 ${result.turns} 轮；等待下一个客户端`)
    // `/exit` 或客户端断开都只结束本代：断开当前连接（幂等），回到 accept。
    term.endSession()
  }
} finally {
  // 3) 退出顺序与启动相反：先撤端点，再关管道。
  try { rmSync(endpointPath, { force: true }) } catch { /* 已被删 */ }
  detachToolFeed()
  term.close()
  await app.dispose()
}
