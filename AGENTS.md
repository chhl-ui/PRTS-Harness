# prts-system

PRTS（Primitive Rhodes Island Terminal Service）受保护核心的首个组件：K1「任务账本」。
纯 TypeScript 库，`node:sqlite` 持久化，只追加哈希链事件 + 可重建投影。暂不接 DSH/Cordis。

## 命令

```sh
npm install        # 仅 devDependency: typescript
npm test           # node --test（node:test + assert/strict）
npm run typecheck  # tsc -p .（strict + erasableSyntaxOnly + noEmit）
```

## 语法约束（Node 原生类型剥离直接运行 .ts）

- 只用可擦除语法：不要 `enum`、`namespace`、参数属性、`import =`、装饰器。
- tsconfig 已开 `erasableSyntaxOnly`、`allowImportingTsExtensions`、`noEmit`、`strict`、`nodenext`。
- 本地导入一律带 `.ts` 后缀。
- Node 类型由 `@types/node`（devDependency，主版本 24）提供；tsconfig 已设 `"types": ["node"]`。

## 固定 actor 通道契约

`verify / ownerAccept / ownerReject / setBudget / stopByOwner / resumeFromStop / chargeUsage / recoverOnStartup`
的 actor 由库内固定，属于所有者/系统通道。面向模型的工具适配层必须把传入 actor 固定为
`{ kind: 'model', sessionId }`，且不得暴露上述方法；本库不验证 actor 的真实来源。

## 工具层接线事实（2026-11-01 核对）

写工具、改接线、动绑定之前先读这节。行号会随提交漂移，**符号名与 `grep` 才是锚点**，文中行号只对应核对时的快照（HEAD `39bfbb7` + D1/D2 在办工作区）。

### 工具面 ↔ `MODEL_OPS`：谁能做什么，闸在哪一层

- **注册点**：PRTS 自有工具经 `tools.register` 注册——`src\runtime\start.ts`（`prts_task_create`）与 `src\runtime\task-tools.ts`（D2 起收拢 `prts_task_*` 工具集）。权威清单是 `grep -rn "name: 'prts_task_" src`，不抄文档。其余工具全部来自 DSH 插件（`config\prts.yml`：`tool-fs` 的 `read`/`read_image`/`write`/`edit`、`working_directory`、`pwsh`（win32）/`bash`（非 win32，两者互斥））。
- **actor 固定发生在工具内部**：`execute` 里写死 `{ kind: 'model', sessionId }`，`sessionId` 取 `exec.agent?.session?.id`；参数 schema 没有 actor 字段，模型无从传入。
- **固定 actor 通道没有工具封装**：`verify` / `ownerAccept` / `ownerReject` / `setBudget` / `stopByOwner` / `resumeFromStop` / `chargeUsage` / `recoverOnStartup` 在工具面不存在入口，它们由库内常量 actor 驱动（`src\ledger\ledger.ts` 的 `OWNER` / `VERIFIER` / `BUDGET` / `STOP` / `RECOVERY`）。
- **第二道闸在库层**：`MODEL_OPS`（`ledger.ts:121`）是 model actor 的白名单，`perm()`（`ledger.ts:304`）对 model 只放名单内的 op、其余抛 `FORBIDDEN`，对 `system` 一律 `FORBIDDEN`（system 只能走固定 actor 路径），owner 全放。名单外的方法即使日后被工具包起来，model 调用也会被库拒。
- **已知缺口：「模型永不绑定」只在工具面成立**：`MODEL_OPS` 里仍有 `bindSession`（`ledger.ts:123`）——工具面没暴露它，但库层允许 model actor 绑定，任何新工具或内部调用走到那里就会静默失去这条不变量。收紧方案是从白名单删掉并补库层负向断言（工具面已有负向①断言工具名不含 bind 语义，那验的是工具面，不是库层）。**本轮未做，记为遗留。**

### 账本工具集（D2 落地）与两处未接/取舍

- **工具面**：`src\runtime\task-tools.ts` 的 `createTaskTools()` 注册 13 个 `prts_task_*` 工具（create / list / get / note / set_resume / step_begin / step_end / add_evidence / claim_done / block / unblock / pause / resume）。返回的 `names` 是**注册回执**，`startRuntime()` 以 `toolNames` 透出——工具面清单不手抄常量，避免与注册漂移。
- **draft 指针**：`draftTaskForSession(sessionId)` 是进程内易失提示（`Map`），只为无参 `/task-approve` 寻址。**它不是绑定**：draft 仍不属于任何会话（`task-tool.test.ts:70` 钉住这条）。重启丢指针只影响便利性，显式 id 路径仍可用。
- **会话绑定的唯一入口是 owner 通道**：`/task <目标>`（开即绑），或 `/task-approve` 批准模型 draft 时的 `bindSession → activate`。顺序不能反：`bindSession` 允许 draft，失败时任务停在 draft、无半途副作用；反序会在 bind 失败时留下「已 active 但无人推进」，而 `activate` 要求 draft、无法回退。
- **归属校验在工具层**：`ledger.perm` 只判 `actor.kind`，不判「这个任务是不是你的」（`ledger.ts:303-312`）。`taskIdOf()` 要求显式 `taskId` 必须等于 `taskForSession(sessionId)`，否则拒——没有这一步，模型拿到任意 taskId 就能改写别人的任务。
- **`/accept` 不要求证据：这是取舍，不是缺陷**：`claimDone → verifying` 不校验证据（`fold.ts:104-108`），`ownerAccept` 只查 phase，所以零证据的任务也能被验收。门在博士，账本只负责让人知情——`/accept` 会打印步骤/证据摘要，零证据时额外提示「无证据支撑」。**不要把它"修"成硬门槛**：那会把「帮我查个资料」这类没有文件产物的任务判成永远无法完成。验收用例负向⑦同时钉住两侧：零证据 accept 必须成功，且必须打出提示。
- **`chargeUsage` 未接线（D5 未完成）**：`ledger.chargeUsage` 存在且至今无人调用。接线点应是回合结束事件里的 usage，但**事件名与载荷形状本轮未实测**，不凭记忆写死。后续接线前先写探针打印回合结束事件的实际载荷，再落代码——猜错事件名会得到一条永远不触发的死代码，而它不会以任何方式报错。

### stepNo 单一分配器 / 账本工具排除名单 / active 相位门

三件是同一处设计的三面：自动记账钩子（`tools\execute` → `beginStep`）与模型侧任务工具写的是同一张 `task_steps`，发号与记账必须各自只有一个决定点。

- **stepNo 单一分配器**：`src\runtime\task-tools.ts` 的 `createStepAllocator(ledger).next(taskId)` 是唯一发号点。冷启动取账本投影的 `max(step_no) + 1`，**不是 `steps().length + 1`**——`step_no` 允许空洞（owner retry unknown、上一进程发号后写失败），`length+1` 在空洞场景会撞已有行。进程内 Map 只是可重建缓存，事实是账本里的 `(task_id, step_no)`。**新增任何记账路径都要走这个分配器**：自己推导必撞号，`ledger.beginStep` 对同号不同名抛 `UNEXPECTED_STEP`。跨进程各自冷启动不协调，当前写入路径单进程，不引入跨进程发号。
- **账本工具排除名单**：`task-tools.ts` 的 `LEDGER_TOOL_NAMES`（显式集合，每项要写排除理由）+ `isLedgerTool()`；`start.ts` 的 `tools\execute` 钩子进门第一件事是 `if (typeof exec.name === 'string' && isLedgerTool(exec.name)) return next()`。存在理由：账本工具自身要写 K1，它的调用若再被自动记账，stepNo 序列会被「模型调了几次任务工具」驱动，模型显式 `step_begin` 还会与钩子自动发号撞同一 `stepNo`。名字带 `prts_task_` 前缀但漏登记仍按前缀排除，但该名字首次出现会打一条 stderr——这是防名单静默漂移的告警，**不是许可：加了工具必须补登记**。
- **active 相位门**：`start.ts` 钩子仅在 `task.phase === 'active'` 时 `beginStep`；库层另有 `checkStepGate`（`ledger.ts:328`）兜底——非 active 抛 `INVALID_TRANSITION`，`cancelled` / `stopped-by-owner` 抛 `TASK_STOPPED`，`beginStep` 与 `retryUnknownStep` 都过它。理由：step 是「模型在 active 任务上的执行痕迹」，`draft` 期没有执行权。**代价已显式化**：非 active 的调用不入账，但按 `(taskId, phase)` 打一次 `console.warn`（`warnedPhaseSkips`）——账本从「拒绝记录」退化成「无记录」时不能无声。放宽为「记录 paused-work step」属未做项。

### 绑定归属：只由 owner 通道建立，模型永不绑定

- **绑定的唯一建立点是 owner 通道**。当前 `/task` 走 `create(owner) → activate(owner) → bindSession(owner, …, sessionId)`（`src\cli\chat.ts` 的 `runTaskCommand`）；`/task-approve`（`runTaskApprove`）只 `activate`、**不绑定**——模型 draft 批准后是「active 但不属于会话」，后续工具调用不会被记 step（`start.ts` 的 `taskForSession` 查不到）。复核方式：`grep -rn bindSession src`，非测试调用点以它为准，文档过时算文档输。
- **draft 不绑定会话**：`bindSession` 的相位白名单本身含 `draft`（`ledger.ts:467`），但没有任何路径会对 draft 调它。改顺序前先想清后果：`activate` 只接受 `draft`（`ledger.ts:453`），若改成 `bind → activate`，绑定成功而 activate 失败后重跑会因 `phase=active` 抛 `INVALID_TRANSITION`——**不自愈**，必须先读 `taskForSession` / `get().phase` 再决定是 bind 还是只 activate。同一会话绑到另一个未结任务被拒（`ledger.ts:468`）；绑到同一任务幂等（投影是 `ON CONFLICT(task_id) DO UPDATE`，`src\ledger\fold.ts` 的 `task.session-bound` 分支）。
- `/task` 自身是 `activate → bind`，绑定失败会留下「active 但无归属」的任务，`describeOpenTasks` 里与正常任务看不出差别。两条 owner 通道对同一类失败给出不同后果，要改就一起改。

### 两类边界：授权判定 ≠ 输入域校验

| | 授权判定 | 输入域校验 |
|---|---|---|
| 在哪 | `Authority.decide` / `Authority.guard`（`src\authority\authority.ts`） | 工具自己的入参检查 |
| 依据 | `classify()` 给出的 capability + 审计链里的 grant / once 事实 | 参数形状与范围（绝对路径？在工作区内？文件存在？） |
| 有状态 | 有：`audit_grants` 投影 + 一次性批准（`getOnce` / `consumeOnce`） | 无 |
| 强制点 | DSH `tools.guard`（唯一强制点）；`tools\pre-execute` 只决定「问不问人」 | 工具内部，失败直接 `raise` |
| 拒绝什么 | 一次调用 | 一次入参 |

**中间有一条旁路，它是叠加结果、不是设计**：`classify`（`src\authority\classify.ts`）对未登记的工具名走 `default`，返回 `tool:<name>`；而 `start.ts` 给 `guard` 与 `pre-execute` 的过滤只认 `fs.read:` / `fs.write:` / `fs.delete:` 前缀。两者叠加 → 任何带文件路径参数但不叫 `read`/`write`/`edit` 的工具，capability 被整体丢弃，guard 与 E3 都不碰它。**「账本工具不走 guard」不代表「被授权豁免」，它只是没被分类覆盖 + 过滤没命中。**

所以路径域收敛必须由工具自己承担：D2 的 `prts_task_add_evidence` 用 `isWithin(realpathBestEffort(...))` 做「工作区包含 + dataRoot 排除」的双重硬判（`realpathBestEffort` / `isWithin` 在 `src\authority\paths.ts`；规范化必须与 authority 同源，否则比较域不一致会产生假阴性）。库侧 `ledger.addEvidence` 只校验「非空 + 绝对路径 + 文件存在」，**不做域判定**——库不持有 workspace/dataRoot 配置，那是运行时的知识。

**硬规则**：新增任何带文件路径参数的工具，都要在这条工具里自建路径域收敛（工作区包含 + protectedRoots/dataRoot 排除），不得假定「账本工具不走 guard」是安全的——它不安全，只是还没人传越界路径。这条同时要写进实现文件的头注释，不能只留在本文档里。

## 工作方式

- 先写失败测试，再实现。测试用 `os.tmpdir()` 下独立临时目录，结束删除。
- 数据规则：`ledger_events` / `audit_events` 各自是事实来源（只追加、sha256 链）；
  `tasks`/`task_steps`/`evidence` 只能由 `fold.ts` 的 `applyEvent` 更新，
  `audit_deletions` 只能由 `audit/fold.ts` 的 `applyAuditEvent` 更新；
  每个变更在一个 SQLite 事务内「追加事件 + 应用投影」。
- 共享链原语在 `src/chain/`（canonicalJson/sha256hex/ZERO_HASH + chainHash/appendChained/verifyChainRows）；
  新组件复用它，不要各自实现哈希链。
- K4 审计：`src/audit/`（同一 SQLite 文件、独立表独立链）；`deletion.completed` 只允许库内部
  在最后一个派生项完成的同事务自动追加；`src/core/startup-check.ts` 用只读连接双链校验。
- Ledger/AuditLog 均支持 `{ readOnly: true }` 打开：所有写方法抛 `READ_ONLY`。
- 运行时启动顺序：`startupCheck` → 正常则 `initCoreDb` → 打开 Ledger/AuditLog；
  `startupCheck` 返回 `read-only`（断链或缺表）时不得调用 `initCoreDb`，只能只读打开。
- K2a 授权（`src/authority/`）：`Authority.guard(call)` 与 DSH `tools.guard` 同签名（同步、
  返回理由串即拒绝）——**守卫是唯一强制点**，pre-execute 瀑布与审批应答可被前置插件伪造；
  decide 每次直查 SQLite（无进程内缓存），跨进程撤销即时生效。
  pwsh 命令体内的写/删操作守卫无法识别，shell 写入范围留待 K2b 沙箱处理。
- K3 停止权与守护进程（`src/stop/`、`src/supervisor/`，仅 Windows）：
  `StopController` 执行运行时内分级停止；`Supervisor` 在进程外把运行时放进
  kill-on-close Job，S0–S2 经控制管道转发、超时升级 S3 强杀整树；
  运行时意外退出按限额自动重启。**所有者命名管道只接受 `stop` 和 `status`**，
  其他消息一律 `UNSUPPORTED`，畸形 JSON 不崩守护进程。
  控制管道连接须 2s 内发送 `{type:'hello',pid,token}` 认证（token 每次重启换新、
  timingSafeEqual 比对、pid 必须等于 Job 内运行时 pid，先认证者胜）；
  **真实运行时必须在派生任何子进程之前调用 `connectControl`**（读 env 即删），
  防止模型 shell 经继承的 `PRTS_CONTROL_*` 冒充运行时。
- K5 启动完整性（`src/integrity/`、`src/cli/prts.ts`）：受保护包与源码树哈希进清单，
  清单文件的 sha256 由审计链最新 `integrity.manifest-updated` 锚定——清单只能经
  `node src/cli/prts.ts upgrade --install-root <d> --manifest <f> --db <f> --spec <f> [--init] [--yes]`
  修改（`--init` 仅首装、`--yes` 原子覆盖+写事件，否则 dry-run 退出码 2）。
  `Supervisor` 配 `integrity` 时校验失败不启动运行时。
- 预算：`blocked_json` 记 `by`（owner/model/system）；model 只能 unblock 自己造成的阻塞，
  且 `resume`/`unblock` 时 usage 已超 budget 抛 `BUDGET_EXCEEDED`（判定走 `fold.ts` 的 `usageExceeded`）。

## K6（运行时集成 2a）：真实组合与运行时入口

- `config/prts.yml`：sdk-minimal 展开蓝本，去掉 sdk-app/jsonrpc 与账户链（credentials-local/authorization/account-platform/llm-deepseek-account）；`sandbox-policy` workspace-write + `!!js process.env.PRTS_WORKSPACE`；`user-approval` policy=ask。
- `src/runtime/start.ts` `startRuntime()`：boot 前设 `DSH_HOME=<dataRoot>/dsh-home`、`PRTS_WORKSPACE`；`prepare` 里 `provideCmdline` + `ctx.provide('credentials',{resolve})`（key 仅内存）。
- `src/runtime/main.ts`：真实入口，**connectControl 先于一切派生**，读 PRTS_* env + `<dataRoot>/secrets/deepseek.key`，boot 后挂完整 StopController。
- 测试支撑（test/）：`scripted-llm.ts` 按脚本应答的 llm adapter（registerAdapter(['deepseek-official'],a)）；`drive.ts` runTurn 发 followup 等 idle。**事件订阅走 `ctx.events.on`，`ctx.on` 是生命周期钩子**；boot() 返回 Runtime 包装对象，Context 经 `ctx.get('agents')`/`ctx.events` 取用。
- 会话持久化落在 `<dataRoot>/dsh-home/sessions/--<cwd>--/<sessionId>/session.v4.jsonl`。
- `agent/assistant-stream` 是进程内 transient 事件，payload 为 `{ frame: AssistantStreamFrame }`（`dsh-agent/lib/types/runtime-types.d.ts:107-140`，事件声明同文件 `:366-369`，emit 站点 `dsh-agent-loop/lib/index.js:1080`）：frame 分 `start` / `chunk` / `end`，可见文本只出现在 `frame.type === 'chunk' && frame.chunk.type === 'text-delta'` 的 `chunk.text`（`dsh-llm/lib/types/types.d.ts:434-441`）。durable 事实仍是 `assistant/message`，事件只作展示。
  **不要用递归白名单「猜」payload 形状**：`src/cli/chat.ts` 曾因白名单只含 `chunks/delta/message/content`、不含 `frame`/`chunk`，导致 7 个事件全部提取为空、终端只能等回合结束走日志兜底；而一旦放宽到能命中 `frame`，同一次回复又会被 `block-end` 的 `block: {type:'text',text}` 重复计入。按契约精确取 `text-delta`，日志兜底只在没收到任何 delta 时启用。
- `prts chat` 的 readline 必须在 `startRuntime()` 之前建立并立即开始收集行（`src/cli/chat-main.ts` 的 `lineSource`）。`startRuntime` 要几秒，这期间 stdin 无消费者会丢行：`printf 'hi\n/exit\n' | node src/cli/chat-main.ts` 曾出现只收到 `/exit`、`hi` 静默丢失，表现为「共 0 轮」且无报错。
- **K2a 已挂到 DSH 唯一强制点 `tools.guard`**（`src/runtime/start.ts`）。挂载点是 **boot() 返回之后**——`prepare` 在 config-tree 挂载前执行（`dsh-app-boot/lib/types/index.d.ts:335`），那时 `tools` 服务还不存在。库路径与守护进程一致：`dbPath ?? PRTS_DB ?? <dataRoot>/core.sqlite`（`supervisor.ts:62`、`:158`），open 前 `initCoreDb` 幂等建表（全是 `CREATE TABLE IF NOT EXISTS`）。sessionId 取 `exec.agent?.session?.id`；`classify` 抛错转成拒绝理由（DSH 对抛异常 guard 的行为未核实，不依赖）；`tools` 服务缺失或 `Authority.open` 失败即 **throw**，不允许以无守卫状态启动；`dispose()` 里必须先 `authority.close()` 再销毁 ctx，否则 Windows 上 sqlite 文件被锁、临时目录清理报 EPERM。
  **当前只覆盖 `fs.read` / `fs.write` / `fs.delete`**：三类命中 `protectedRoots` 一律 deny（`fs.read` 此前是无条件 allow，等于 `<dataRoot>/secrets/*.key` 对模型 shell 敞开——`dsh-sandbox-windows-acl` 只做写限制，读侧原本无人管）。范围到此为止——`exec` / `net` / `system` / `tool` 未受管辖，归 K2b。原因——K2a 对 pwsh 只能整体放行或整体拒绝（命令体内的写/删识别不了，见 `src/authority/index.ts` 头注释），整体拒绝会让 `test/runtime/runtime.test.ts` 的 R2（pwsh 写区内文件并断言存在）必红，而且那不是真正的安全边界。
- `ctx.jobs` 作业接口：`start(spec)` 需先 `attachController(name)`；`JobSpec={kind,label,owner?,run(job):JobHooks}`，`JobHooks={cancel(reason?),done:Promise<JobOutcome>}`（done 必须 resolve 不能 reject）；`kill(id,caller?,reason?)`、`wait(id,ms)` 按 JobId 操作，`list()` 返回视图（无 kill 方法）。
- `agent.cancel({kind:'user'})` 同步方法；`agent.whenIdle()` 等回合收敛；回合内错误只经 `throwError()`（`dsh-agent-loop` 0.2.1-rc.2 `lib/index.js:877-886`：先 `emit('agent/error')`（:880）再 `throw`）上报；`kick()`（:887）的 `catch {}` 随后吞掉异常，所以不经 `throwError` 的抛出既无 emit 也无外部迹象（`unhandledRejection` 也不会响）。要拿错误**必须订阅 `agent/error`**，不能依赖异常传播。
- `agent.followup/steer/inject` 的入参必须是 `createUserMessage()` 等 `createMessage` 系列的结果（`dsh-llm` 0.2.1-rc.2 `lib/index.js:37-43` 补 `id`，`:59-64` 补 `role:'user'`）；三者本身不归一化入参（`dsh-agent-loop/lib/index.js:803` 原样 `inbox.splice`，:806/:809/:812 只转 target+wakeup）。传裸 `{content,source}` 缺 `role`/`id` → `serialize()`（`dsh-llm-deepseek/lib/index.js:1590`，由 `request()` :2190 调用）抛 TypeError，被 `generate()` 的 catch 包成 `LlmError(code:'TRANSPORT')`（:2156）——报错码指向传输，实为入参结构不合法。
- 上述行号按 `dsh-agent-loop`/`dsh-llm`/`dsh-llm-deepseek` 0.2.1-rc.2 实测；升级 RC 后行号会漂，以符号名（`throwError`/`kick`/`createUserMessage`/`serialize`/`TRANSPORT`）为准重核。
- credentials `resolve(ref)`：`credentialRef()` 返回品牌字符串（ref 即 'DEEPSEEK_API_KEY'）；适配器取 `hit.value`；DeepSeek 请求头是 `x-api-key`（无 Authorization）。
- llm 消息 `content` 是块数组 `[{type:'text',text}]`；`baseURL` 经 patch `config:{baseURL}` 可指向假端点（请求路径 `/v1/messages`）。

## 外部参考与选型

实现本项目没有的能力、或做技术选型前，先检索 GitHub（repo 看有没有、code 看怎么实现、issue 看坑）与论文（arXiv / Papers with Code，优先选有开源实现的），评估许可证、活性、真实度、契合度、代价，结论必须是「复用 / 适配 / 借鉴设计 / 自建」四选一并写理由。

归档到 `C:\Users\Administrator\Desktop\参考库\<项目名>`，记录来源 URL 与**固定 commit**（不是分支名）；归档目录只读，不当依赖 import。已有 10 个条目，新增前先看有没有重复（清单见文档）。

引用外部结论前，必须在本仓用 grep / read_file 核实该断言成立——「README 说支持」不等于「已实现」，「文档没提」不等于「没做」。归档 ≠ 采纳。

完整规则：`docs/external-reference-research.md`。
