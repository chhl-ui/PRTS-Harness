# prts-system

PRTS 受保护核心：任务账本、授权、停止、审计、启动完整性，以及把这些接进 DSH 运行时的入口。
纯 TypeScript，`node:sqlite` 持久化，只追加哈希链事件 + 可重建投影。

**这是 PRTS 当前唯一在办的主线。** 其它 PRTS 目录的地位见 `C:\Users\Administrator\Desktop\PRTS-INDEX.md`。

## 跑起来

```sh
npm install       # 依赖：@deepseek-ai/dsh-* 0.2.1-rc.2（RC 版本，升级需复验接口）
npm test          # node --test，106 例，约 33 秒（2026-11-01 实测 106 pass / 0 fail，32.4s）
npm run typecheck # tsc -p .（strict + noEmit + erasableSyntaxOnly）
npm run chat      # 所有者终端：进程内 REPL（需下面三个环境变量）
```

`prts chat` 的用法：

```sh
PRTS_DATA_ROOT=C:\prts-data PRTS_WORKSPACE=C:\prts-workspace \
PRTS_CONFIG=C:\prts-system\config\prts.yml npm run chat
```

输入消息开始对话，`/exit` 退出，Ctrl-C 中断当前轮次。工作区外的越界操作会弹审批提示（见「E3 审批」）。

**API key 存哪**——按「被随手读到的门槛」从高到低取第一个可用的：

1. **Windows 凭据管理器**（推荐，磁盘上无明文）：`npm run secret:set` 交互输入（不回显），`npm run secret:del` 删除。存好后可删掉明文密钥文件。
2. **环境变量** `DEEPSEEK_API_KEY`：读到后立刻从本进程环境删除，防派生子进程继承。
3. **明文文件** `<dataRoot>\secrets\deepseek.key`：向后兼容保留，启动时打印警告——模型 shell 用 `Get-Content` 就能读走它。

诚实边界：同用户下的任何持久化存储都可能被同用户的恶意进程提取。本方案消除的是「明文文件可被随手读」，不是「同用户主动提取」。

## 目录

```
src/
  chain/        共享链原语（canonicalJson / sha256hex / chainHash / verifyChainRows）
  ledger/       K1 任务账本：append-only 事件 + fold.ts 投影
  audit/        K4 审计：同一 DB、独立表、独立链
  authority/    K2a 授权：Authority.guard 是唯一强制点（同步、返回理由串即拒绝）
  stop/         K3 分级停止 StopController
  supervisor/   K3 进程外守护：Job Object、控制管道认证、崩溃重启限额
  integrity/    K5 启动完整性：受保护包与源码树哈希，锚在审计链
  cli/          prts upgrade（清单只能经它修改）
  runtime/      K6 运行时入口 main.ts + start.ts（boot 组合 + 内存 credentials + 守卫/审批/记账接线）
                task-tools.ts：模型侧任务工具与 stepNo 单一分配器、账本工具排除名单
config/prts.yml 组合树（sdk-minimal 展开，自 sdk-app/jsonrpc 与账户链中剥离）
test/           106 例；test/support/ 是驱动、脚本化模型替身、临时目录
.scratch/       一次性诊断探针（gitignore，不参与测试）
```

## 模型侧工具

模型能调的工具 = DSH 插件提供的 + PRTS 自己注册的。下面只是索引，权威清单看代码：

- **PRTS 自有工具**：经 `tools.register` 注册在 `src\runtime\start.ts` 与 `src\runtime\task-tools.ts`。起点是 `prts_task_create`——提一个 `draft` 任务，不能自己批准、不能自己激活；D2 在同一文件补齐 `prts_task_note` / `step_begin` / `step_end` / `add_evidence` / `claim_done`。权威清单：`grep -rn "name: 'prts_task_" src`，不要抄文档。
- **DSH 插件工具**（`config\prts.yml`）：`read` / `read_image` / `write` / `edit`（`tool-fs`，经 K2a 守卫）、`working_directory`（只切会话 cwd，不产生能力）、`pwsh`（win32）/ `bash`（非 win32，两者互斥）。`pwsh`/`bash` 不归 K2a 也不归 E3——命令体内的写删识别不了，归 K2b。
- **模型侧不接受 actor 入参**：actor 在工具内部写死为 `{ kind: 'model', sessionId }`；账本里属于 owner/system 的固定通道（`verify` / `ownerAccept` / `ownerReject` / `setBudget` / `stopByOwner` / `resumeFromStop` / `chargeUsage` / `recoverOnStartup`）没有任何工具封装。工具面与授权层的逐条对应见 `AGENTS.md` 的「工具层接线事实」。

## 必须守住的不变量（细节见 AGENTS.md）

- 守卫是唯一强制点。`pre-execute` 瀑布与审批应答都可能被前置插件伪造，守卫在后面仍会拒。
- 真实运行时必须在派生任何子进程之前调用 `connectControl`，并把控制 env 读即删。
- 所有者命名管道只接受 `stop` 和 `status`；控制管道 token 每次重启换新、`timingSafeEqual` 比对、pid 必须等于 Job 内运行时 pid。
- key 只存在于内存 credentials 服务，不进环境变量，不落模型可读的位置。
- 账本/审计是事实来源；投影只能由 `fold.ts` 的 `applyEvent` 更新。
- `startupCheck` 返回 read-only 时不得调用 `initCoreDb`，只能只读打开。

## 当前状态

- 最近的功能提交是 `ddc511d`（2026-10-31 22:55）"任务入口设计同步到实现状态"。在此之前 `b3cb34b`（2026-10-30）"Runtime integration 2a" 让真实 DSH 组合在自有守护进程下跑通、模型由脚本替身驱动；此后不再只有文档提交——K1 任务入口已按 `docs/task-entry-design.md` 的 W0–W5 全部落地（`306d240` W0 至 `a9e3dbf` W5），模型只能建 `draft`、`owner` 才能 `activate`。取准看 `git log`。
- **测试稳定性（2026-10-31 实测）**：曾观察到 1 次 `fail 1`（85 例时代，详情因日志被 grep 过滤而丢失）。随后 **20 轮连续采样**（90 例，共 1800 次用例执行）**0 失败**，原始失败未复现——若真实概率是 1/5，20 轮全绿的概率仅 1.15%，故该频率假设可以否定；95% 置信的失败率上界约 15%（rule of three, 3/20）。**仍未定位**：头号嫌疑是 R2 等待 LanguageMode 落盘的轮询窗口（原 10s，已放宽到 15s，并把「等待超时」与「语言模式错误」拆成两条断言，避免下次复现时把定位引到错误的层）。单次全绿仍不作结论，判据是**连续两次全绿**。
- O1 已修（2026-10-31）：驱动路径改用 `createUserMessage()` 构造消息，真实适配器经 agent 轮次能发出请求；回归见 `test/runtime/o1-real-adapter.test.ts`。
- **E1 已通（2026-10-31）**：真实 key、真实 `api.deepseek.com`、出厂默认配置（`reasoningEffort` 缺省 = `high`，未改 `config/prts.yml`），连跑 4 次全部成功，`assistant/message` 含 `reasoning` + `text` 块，`turn/end` 为 `completed`，单次约 1580ms，`agent/error` 0 条。thinking block 被正确映射为 `reasoning`，不需要关掉推理。
- **`prts chat` 已流式输出（2026-10-31）**：`agent/assistant-stream` 的 payload 是 `{ frame: AssistantStreamFrame }`（`dsh-agent/lib/types/runtime-types.d.ts:107-140`，事件声明 `:366-369`）；可见文本只在 `frame.type === 'chunk'` 且 `frame.chunk.type === 'text-delta'` 的 `chunk.text` 里（`dsh-llm/lib/types/types.d.ts:434-441`，emit 站点 `dsh-agent-loop/lib/index.js:1080`）。`src/cli/chat.ts` 按此契约取增量、逐片写终端；真实 key 实测首片比回合结束早约 250ms 到达。某 provider 只发完整 block 不发 `text-delta` 时，仍走 `<dataRoot>/dsh-home/sessions/**` 的 `assistant/message` 兜底——两条路径互斥，不会重复。
- **U4：step 现在有 started 中间态（2026-10-31）**：`beginStep` 从 `tools/result` 挪到 `tools/execute`（waterfall，位置在 guards 之后、工具真正执行之前——`dsh-tools/lib/index.js:3427` 晚于 `:3337` 的 guardReason），`endStep` 仍在 `tools/result`。收益是进程在工具执行中途崩溃时账本里留着孤儿 step，`recoverOnStartup` 才看得见；代价是被守卫拒绝的调用不再产生 step——拒绝不是「执行失败」，它压根没执行。回归见 `test/runtime/ledger-startstep.test.ts`。
- Devin 留下的孤儿脚本 `enum-tools.ts` 已移入 `.scratch\`（一次性探针，不参与测试）。

## 已知缺陷

- **O1（已修，2026-10-31）**：根因是 `agent.followup()` 不归一化入参——传裸 `{content, source}` 的消息缺 `role`，`serialize` 里 `previous?.role === wireRole` 在首元素上双 `undefined` 相等，解引用 `previous.content` 抛 TypeError（`dsh-llm-deepseek/lib/index.js:1688:45`），被 `generate()` 兜底 catch 包成误导性的 `TRANSPORT`。修法：`agent.followup/steer/inject` 一律传 `createUserMessage()`（`dsh-llm`）；接线事实与各处 file:line 见 `AGENTS.md`。
- **错误曾全程静默（随 O1 一并修掉）**：`agent/error` 是 turn 内失败的唯一上报通道（`throwError()` 先 emit 再 throw，`kick()` 的 catch 只吞异常传播）。此前无订阅方，失败在对话里表现为一直不回复。`src/runtime/error-report.ts` 现将其脱敏后写 stderr，由 `startRuntime()` 挂载、`dispose()` 解绑。
- 复现脚本 `.scratch/o1-probe.test.ts` 仍自持裸对象调用，可复现原始症状，用于对照。

## 已知限制

- **K2a 守卫已接线，但只覆盖文件系统能力**（2026-10-31）：`src/runtime/start.ts` 在 boot 返回后挂 `tools.guard`，模型发起的读/写/删先过 `Authority.guard`——越界写/读返回拒绝理由并写 `tool.denied` 审计，工作区内读写正常放行（回归见 `test/runtime/guard-wiring.test.ts`）。`exec` / `net` / `system` / `tool` 暂不判定（归 K2b 沙箱）：K2a 对 pwsh 只能整体放行或整体拒绝，整体拒绝会破坏现有 pwsh 用例，而且那不是真正的边界。**这与下面的审批问题是两件事**——审批不可达是 fs backend 的问题，守卫接线是工具流水线的问题，不要互相代替。
- **请求重试会重复输出片段**：`frame` 带 `attemptId` / `revision`，模型请求失败重试会起新 attempt 从头重发 delta，而已经写进终端的片段撤不回来。`chat.ts` 按 `attemptId` 变化重置游标，但不做终端回滚——重试路径下用户可能看到重复片段。正常对话（无错误、无工具重试）不触发。
- **E3 审批已实现（2026-10-31），走 K2a 侧而非 DSH 的 fs escalation**。DSH 的 `resolvePolicy` 路径被 K2a 守卫遮蔽——越界写在 `authority.ts:148-152` 就被拒，到不了 `dsh-tool-fs/lib/index.js:1134-1150`。可用的钩子是 `tools/pre-execute`：它是异步 waterfall 且在同步 guards 之前（`dsh-tools/lib/index.js:3321` / `:3337`）。链路：pre-execute 用 `classify(name, arguments)` 算 capabilities → `decide()` 返 `ask` → 按 callId 暂存 → `approval/request` answerer（`src/cli/chat.ts`）弹终端提示 → `recordOwnerDecision({outcome:'allowed-once'})` → 同步 guard 读到 once 放行。回归见 `test/runtime/e3-approval.test.ts`。
- **三层授权语义**：`protectedRoots` 内 → `deny`（绝对禁止，审批救不了）；工作区外且非 protected → `ask`（可审批）；工作区内 → `allow`。`decide()` 的优先级是 `deny > ask > allow`，所以越界写的 E3 用例必须落在「工作区外、非 protectedRoots」。
- **审批只覆盖文件能力**：`exec` / `net` / `system` 不归 E3（归 K2b）——pre-execute 对非 `fs.*` 能力直接放行。
- ~~dispose 后进程不退出~~（2026-10-31 复测不复现）：`startRuntime` → `dispose` 与 `startRuntime` → 一次完整 turn → `dispose` 两个场景，结束后 `_getActiveHandles()` 只剩 stdin/stdout/stderr（fd 0/1/2）、`_getActiveRequests()` 为空，不加 `--test-force-exit` 也正常 `exit 0`。若日后在 supervisor / job 路径上再观察到挂住，按那条路径单独记，不能笼统写成「dispose 后不退出」。

## 文档

- 设计与计划：`C:\Users\Administrator\Desktop\设计和计划\`（先读其中的 README.md）
- 最新设计：`PRTS-DESIGN-02-RUNTIME-INTEGRATION-2026-10-30.md`（§8A/§8B 是 2a 步的实测记录）
