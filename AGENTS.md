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
