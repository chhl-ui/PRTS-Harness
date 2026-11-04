# prts-system

## 项目定位（先读这节，再读代码）

**本仓是 PRTS 的受保护核心，不是 PRTS 的全体。**

PRTS 是博士的个人综合智能工作系统：独立进程、自有数据根与界面、模型提供方可替换、核心数据可导出迁移。产品目标是两个人格（PRTS / 普瑞赛斯）加「更像人」的四个方向——**人格与情感、记忆、上下文装配、进化**——以及科研与个人日常工作两类实际工作。定义原文在仓内：

- `docs/reference/PRTS-PROJECT-CHARTER-2026-10-09.md`：产品目标、C01—C12 能力、A01—A12 首版验收、七条产品行为原则。
- `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md`：§4 受保护核心与插件信任分级、§5 四方向、§7 V1-01—V1-18 第一版范围。

本仓实现的是 §4 那一层：任务账本（K1）、审计（K4）、权限入口（K2a）、启动完整性（K5）、运行沙箱（U3）、运行时与终端通道（P1/P2）。除此之外，四方向的**机制层**已陆续落地：`src/memory/`（长期记忆与检索）、`src/persona/`（人格设定）、`src/emotion/`（情感状态）、`src/skills/`（进化：候选/评估/采用/回退）、`src/cost/`（费用计量）、`src/proactive/`、`src/reminders/`、`src/spill/`（工具输出卸载）。护栏层仍是产品目的之外的那道边界——它服务的是架构需求 §5.4 那句「用得越久越懂博士，做事越熟练，同时不会变坏、不会悄悄改掉自己的底线」。

**机制存在 ≠ 验收通过**：V1-03/04/05/06/08/09 等仍是「有机制、缺真实流程或盲评」，判据对照 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §7 原文；当前项目的未完成事项见 `docs/HANDOFF-20261105-session-f.md` 与计划文件 `.rivet/plans/prts-后续建设方案-2026-11-04.md`。

两条约束直接抄自原文，动手前先认：

- 实现现状不缩减产品目标。目标书 §一：「既有架构的限制不得自动缩减产品目标」；§十：「现状只用于估算复用与迁移成本，不定义产品上限」。
- 阶段顺序：架构需求 → 内核与插件机制审查与决定 → **记忆/人格/情感/上下文审查与决定** → 其余模块 → 第一版实现（架构需求 §10）。内核层已按 §4.4 四项决定落地，继续加固不等于推进主线。

纯 TypeScript，`node:sqlite` 持久化，只追加哈希链事件 + 可重建投影。运行时以 DSH 为底座（`src/runtime/`），Cordis 插件框架由 DSH 维护，不自研。

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

### AppContainer 沙箱（U3 读隔离层，`src/sandbox/`）

- **它解决什么**：模型 shell 能读 `<数据根>/secrets/deepseek.key`。四条传统路径与「专用账号 + CreateProcessAsUser」都已实测证伪（`docs/u3-key-read-isolation.md`），AppContainer 是唯一在**未提权**上下文中可用的读隔离机制。
- **与 K2b 的分工**：`dsh-sandbox-windows-acl` 管**写**（WRITE_RESTRICTED token，restricting SID 只参与写检查）；`src/sandbox/appcontainer.ts` 是**读**侧的另一条通道。两者不是替代关系，不要拿一个去解释另一个的行为。
- **local 后端在 `C:\` 下 workspace 的 shell 故障根因是 WRITE_OWNER**（实测 2026-11-02，三轮 E2E ACL 实验）：`dsh-sandbox-windows-acl` 的 `grantWrite` 对 workspace 根做 `SetNamedSecurityInfoW(securityInfo=20=DACL|LABEL)`（`types-Cl_DXjhk.js:485`），其注释（`:583`）明说「the label lives in the SACL; owner-implicit rights cover only READ_CONTROL and WRITE_DAC」——目录必须被调用者所有**且授予 WRITE_OWNER**。UAC 未提权下 `C:\` 自建目录只有继承 ACL（`Authenticated Users:(M)`），没有显式 WO，于是 Win32 5。**修法已实现**：`src/sandbox/workspace-acl.ts` 的 `ensureWorkspaceWriteOwner` 启动时给当前用户 SID 授 `(OI)(CI)(WO)`（实测仅 WO 即可，D 臂），local 现在在 `C:\` 浅层 workspace 上可用。
  **现状**：WO 自动授权落地后 local 在 `C:\` 浅层 workspace 可用；`%TEMP%` workspace 原本就可用。WO 授权失败只降级为 shell 不可用（warn 给出管理员命令），不阻断启动。
  **两个后端的位置要求不同**：appcontainer 要浅层（`C:\prts-workspace`，否则祖先链 traverse 失败，见 `confine.ts` 的 `workspaceTraversalRisk`）；local 在 WO 自动授权后对浅层 `C:\` 路径也可用（深层路径未实测，仍不推荐）。启动时 WO 失败不阻断（warn 出确切的管理员命令），.git 保护失败则拒绝启动。
- **`.git` 对 shell 只读**（`workspace-acl.ts`，与 K2a `readOnlySubpaths` 共用 `DEFAULT_READ_ONLY_SUBPATHS`）：K2a 只挡 `fs.write`/`fs.delete`，pwsh 不受管，shell 层另有机制。local：`.git` 上对能力 SID（`workspaceWriteSid(realpathSync.native(ws))`，`S-1-4-…`）加显式 DENY `DE,WDAC,WO,WD,AD,WEA,DC,WA`——必须与 DSH `canonicalPath` 同源用 `realpathSync.native`（`dsh-sandbox/lib/index.js:150`）：JS 版 `realpathSync` 保留传入拼写（如小写盘符），SID 算错会让 DENY 落在错误 SID 上、读回照样「通过」而保护静默失效；appcontainer：容器包 SID **忽略 DENY_ACCESS ACE**（A0b/A1 实测 allow-only 模型），只能 `icacls .git /inheritance:d` → `/remove:g *CSID /T` → `/grant *CSID:(OI)(CI)(RX) /T`。两个坑：能力 SID 用 icacls/`FileSystemAccessRule(string)` 映射不了（IdentityNotMapped/1332），DENY 要走 `SecurityIdentifier` 对象 + `Set-Acl`；**每次 ACL 写入必须读回验证**（`Set-Acl` 对部分对象会报 SeSecurityPrivilege 假成功）。边界：只护根下 `.git`（启动后才 `git init` 的不受护直到下次启动；worktree `.git` 文件按文件分支处理；嵌套仓库不覆盖；appcontainer 修法断开 `.git` DACL 继承）。
- **模型在容器里跑不了 node / git，原因是「谁发起 CreateProcess」而不是笼统的「未授权」**（实测 2026-11-01，结论与初判相反，记下来免得再踩）：
  - 宿主（普通用户令牌）直接 `CreateProcess` 启动 `C:\Program Files\nodejs\node.exe` → **成功**，返回 `v24.19.0`；`git --version` → `2.55.0.windows.4`。
  - 容器内的 pwsh 再启动同一个 exe → **失败**：`where.exe node` 返回「找不到」，直调报「无法识别」。AppContainer 的读隔离生效——容器只被授予 workspace 与 `--read-path` 列表，Program Files 不在其中。
  - 差异的本质：访问检查发生在**发起方**上下文。宿主能读 `node.exe` 所以能加载映像；容器的受限令牌读不到。
  - **判据**：不要用「宿主直 spawn」的探针去证明「模型能用」，那测的是宿主的能力，模型走的是容器内 pwsh 那条路。写探针时必须让 pwsh 去执行目标程序。
  - **修法（已验证 2026-11-01）**：用管理员权限对这两处做一次 AppContainer SID 的读授权，脚本 `scripts/grant-sandbox-read.ps1`（未提权时只打印 SID 与待执行命令，不改动）。授权后容器内实测：`where node` → `C:\Program Files\nodejs\node.exe`、`node --version` → `v24.19.0`、`git --version` → `2.55.0.windows.4`；真机 `prts chat` 里模型自己跑出的结果相同。
  - **结论随之修正**：appcontainer 现在 **shell 与 node/git 都能跑**，「shell 能用但干不了活」不再是它的缺陷。默认后端要不要切过去是决策问题，不再是能力性阻塞。
- **横向对比见 `docs/harness-sandbox-comparison.md`**：Codex / NanoClaw / pi / goose / DSH / PRTS 六家在「Windows 上怎么给模型 shell」这件事上的取舍。结论：Windows 上默认不开沙箱是业界常态（Codex 这么重的实现也默认 `Disabled`）；PRTS 与 NanoClaw 同走「白名单而非黑名单」这条路，方向没偏。
- **依赖 koffi**（`^3.3.6`）。它是原生模块，install 时有预编译下载脚本——**新机器上 `npm ci` 若被 `allow-scripts` 拦下，koffi 的二进制不会就位，`require('koffi')` 会失败**。这是部署约束，不是代码缺陷。
- **实现要点（踩过的坑，别重踩）**：
  - `DWORD_PTR`（UpdateProcThreadAttribute 的 attr 参数）是 64 位，传 Number 会被 koffi 拒，必须 `BigInt`；`lpReturnSize` 可传 `NULL`。
  - `CreateProcessW` 的 `lpCommandLine` 必须可写缓冲区（UTF-16LE `Buffer`），传 `string` 会落到只读内存。
  - 模块加载时自检 `STARTUPINFOEX=112 / STARTUPINFO=104 / SECURITY_CAPABILITIES=24`，对不上直接抛。`cb` 错了会得到 `87 (ERROR_INVALID_PARAMETER)`，**87 是参数错误不是权限错误**——权限类是 `5` / `740`。
  - 任何 Win32 失败都抛，不降级成不受限运行。
- **第一版边界（写死的，不要当成 bug 去"修"）**：
  - **stdio 合并捕获**：stdout 与 stderr 走**同一个**管道。分开读两个管道时，若子进程写满其中一个（64KB）而父进程正在读另一个，写端阻塞、读端等 EOF——双死锁。合并后单一读端，读到 EOF 即结束。`wait()` 返回 `{ exitCode, output }`，`output` 是两者合并的文本。**不要为了「区分 stderr」改成两个管道**，除非同时实现异步并发读。
  - **读必须先于等**：`wait()` 里先 `drainPipe` 再 `WaitForSingleObject`。反过来「先等子进程退出再读」会在输出超过管道缓冲时死锁。父进程的写端必须在 `CreateProcessW` 之后立刻关闭，否则读端永远等不到 EOF。
  - 授权走 `icacls` 子进程而非手写 `SetNamedSecurityInfo`（后者有「pSacl 要 ACL 指针而不是整个 SD」的坑）。
  - **已接线到运行时**（2026-11-01 更正，原记「尚未接线」）：缺的那个实现层就是 `src/sandbox/provider.ts` 的 `AppContainerSandboxProvider`——它继承 `SandboxProvider`（`extends Service`，`new` 出来即顶替 `ctx.sandbox`），`start.ts` 在 `PRTS_SANDBOX_BACKEND=appcontainer` 时实例化它，DSH 的 shell 工具由此走到 `runner.ts`。**默认 `local` 时不实例化**：那条链路上是 `dsh-sandbox-local`，shell 根本不经过 AppContainer。所以「已接线」与「默认能用」是两件事，别混。
- **runner 协议（`src/sandbox/runner.ts`）**：`node runner.ts --profile <名称> --workspace <路径> -- <命令> [参数...]`。子进程 stdout/stderr 合并写入本进程 stdout，退出码**原样透传**；自身失败用 sysexits 风格（64 用法错误 / 70 内部错误），**失败绝不返回 0**——静默成功会让上游把「沙箱没起来」当成「命令跑完了」。实测两层管道（子进程→CreatePipe→runner→调用方）在 210KB 输出下不丢不死锁。
- **两条实测出来的硬约束**：
  1. **spawn 必须显式设 `cwd` 到已授权的工作区**。不设就继承 runner 的当前目录，AppContainer 对它没有 traverse：`cmd` 不敏感看不出来，**`pwsh` 直接报「当前目录无效」而根本不执行命令**。runner 早期漏了这一条，靠 pwsh 回归才暴露。
  2. **workspace 必须在祖先链可 traverse 的浅层路径下**。放在 `%TEMP%` 这类深层目录时，PowerShell 解析相对路径要 realpath 整条链，`AppData` / `Temp` 对 AppContainer 无权限 → 「对路径 … 的访问被拒绝」。`C:\prts-workspace` 符合要求；`C:\Users\ADMINI~1\AppData\Local\Temp\...` 不符合。node 那个 `EPERM: lstat 'C:\'` 是同一类问题。
- **`denialSignatures` 只能留空**（实测结论）：AppContainer 下越界操作的错误文本是**系统本地化**的——本机（中文）上读/写/删/列全是「拒绝访问。」，pwsh 是「对路径 … 的访问被拒绝。」，没有可跨语言匹配的稳定子串。填中文签名换台机器就失效，填英文在本机匹配不上。上游不能依赖 denial 分类做安全判断；沙箱是否生效要靠退出码与 ACL 本身，不靠文本嗅探。
- **接线形态：必须是 runner，不能直接接 `SandboxProvider`**（2026-11-01 查证）：
  `dsh-sandbox` 的 `SandboxProvider.confine()` 返回 `ConfinedArgv`，其 `argv` 是
  「runner + profile + 分隔符 + 调用方 argv」，由上层用普通 `child_process` 启动
  （`node_modules/@deepseek-ai/dsh-sandbox/lib/types/index.d.ts:79-112`）。
  AppContainer 不是 argv 包装——它要在父进程里 `CreateProcessW` 并传
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，没法表达成一段 argv。
  所以要接入 DSH，得写一个 **runner 可执行**：`[ac-runner, --profile X, --workspace W, --, cmd.exe, /c, ...]`，
  由 runner 内部建容器、起子进程、转发 stdio、透传退出码。**绕过 DSH 自己重写 shell 工具是另一条路，但会丢掉持久 shell 与既有沙箱策略，不推荐。**
- **容器生命周期（实测支撑）**：空工作区上 `create` 中位 9.8ms、`spawn+wait` 6.5ms、`dispose` 7.3ms
  （`.scratch/probe-ac-cost.mjs`）。建容器本身很便宜，**但 `icacls (OI)(CI)` 是递归的**——
  大工作区的授权会随树规模增长（`dsh-sandbox-windows-acl` README 记着「tens of seconds on large workspace trees」）。
  所以 runner 要么复用已建的 profile + 已授权的 ACL，要么在授权前先判断 ACL 里是否已有该 SID，别每次全树走一遍。

### 所有者通道（P2）：管道、双通道输出、断开语义、E10

- **端点**：随机管道名 `\\.\pipe\prts-term-<32 hex>`，服务端**先 listen 成功**再把名字**原子**发布到 `<数据根>/terminal.endpoint`（写 `.tmp` → rename）；退出顺序相反。反过来会有「文件已存在但还没人听」的窗口，固定名实现里更会变成抢注窗口。随机名只消除发布瞬间的抢注，**不是安全边界**——endpoint 在数据根下，而沙箱可读数据根（H3 实测），读到名字就能连。
- **安全边界只有 E10 那一道**：Low 完整性进程发起命名管道连接一律 `EPERM`。实测比「禁止向上写」更强：**Low 连 Low 也不行**（`.scratch/probe-pipe-il.test.ts` 臂 C 失败），所以凡涉及「Low 进程连管道」的推断不要写成「向上写被拦」。防线来自 Windows 完整性控制的默认行为，PRTS 没有给管道加安全描述符。
- **E10 的验收判据是 `npm run verify:e10` 的 exit 0**，不是 `npm test` 全绿。四臂缺一不可：A 普通连得上（基线）、B 沙箱被挡且 `EPERM`、B' 沙箱连不存在管道得到 `ENOENT`（证明 errno 可区分）、C' 普通进程能连沙箱创建的管道（对照臂，证明失败归因于发起方 IL 而非环境残缺）。环境不具备时脚本 exit 2——**2 不是通过**。
- **双通道输出**：模型文本走 `event{kind:'delta'}`（`deps.onAssistantDelta`），宿主回显走 `event{kind:'host'}`（`deps.out` 被 chat-serve 接到管道）。chat.ts 里这两条路径**互斥**：流式与日志兜底都走同一个分流判断，双写会让同一段模型文本以 host 身份再出现，而 `host 通道只承载宿主输出` 正是要被测的东西。
- **状态机由 `approvalChannel` 驱动，不靠文本推断**：`requestApproval()` 进入 awaiting 并记 pendingCallId；应答必须 `callId` 逐字相等，否则 `stale-approval` 且不结算；审批期内的 prompt 回错**不入队**（排队会让审批结束后凭空多出一轮对话）。
- **单客户端**：runChat 是单会话长循环，多客户端会争抢同一个输入迭代器，后来者收 `busy` 并被断开。这是会话语义，不是性能限制。
- **断开语义**：只做两件事——未结算审批按 false 结算（fail-closed），送 EOF。**不中断飞行中的回合**（收敛由 chat.ts 的 `waitIdle` 控制，默认 120s，本层拿不到 agent 句柄）。因此「断开后模型调用数还在涨」是预期行为；衡量「是否停止接新活」的指标是**新回合起始数**，不是模型调用次数——用后者断言会把正确实现判红。
- **词表无 `cancel`**：`/cancel` 在 chat.ts 是 `ledger.cancel`（账本相位变更），与「中止回合」是两回事。所有 `/` 命令当普通 prompt 文本发，由 chat.ts 解析；中止回合留 P2b。

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

### 记忆的所有者删除与纠正（P0-2a）

`MemoryStore.planForget / forget / correctFact` + `forget-flow.ts` 编排：turn/fact 级联删除（含 vectors/mentions/孤儿实体/sessions 重算 + FTS optimize + wal_checkpoint 物理收口），fact 可纠正（`superseded_by` 可逆）；turn 只能删不能改。入口：`prts memory find/forget/correct` 与 chat 的 `/memory /forget /correct`——全是所有者通道，模型面零工具。设计与边界（含 P0-2b 会话日志未做的原因）见 `docs/design-memory-forget.md`。

## 外部参考与选型

实现本项目没有的能力、或做技术选型前，先检索 GitHub（repo 看有没有、code 看怎么实现、issue 看坑）与论文（arXiv / Papers with Code，优先选有开源实现的），评估许可证、活性、真实度、契合度、代价，结论必须是「复用 / 适配 / 借鉴设计 / 自建」四选一并写理由。

归档到 `C:\Users\Administrator\Desktop\参考库\<项目名>`，记录来源 URL 与**固定 commit**（不是分支名）；归档目录只读，不当依赖 import。已有 11 个条目，新增前先看有没有重复（清单见文档）。

引用外部结论前，必须在本仓用 grep / read_file 核实该断言成立——「README 说支持」不等于「已实现」，「文档没提」不等于「没做」。归档 ≠ 采纳。

完整规则：`docs/external-reference-research.md`。
