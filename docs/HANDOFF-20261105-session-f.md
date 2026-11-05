# 会话交接（2026-11-05 第六段）

**写给完全没有上下文的新会话**：本文自包含，不引用任何未落字的对话。

**起点**：上一份是 `docs/HANDOFF-20261104-session-e.md`（HEAD `9abd16d`，760 测试）。
**本段范围**：Wave 3 收尾三件——`/switch`、分派器、客户端寿命与运行时寿命解耦。

---

## 一、当前状态

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `55b0f61` | `git log --oneline -3` |
| 全量测试（并发） | **787 pass / 0 fail**，48.2s，exit=0 | 2026-11-05 实测（`/tmp/all_r2.log`） |
| typecheck | `tsc -p .` exit=0 | 同轮 |
| 工作树 | tracked 干净；未跟踪只有 `.rivet/`、`nul` | `git status` |

测试命令（并发）：`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/all.log 2>&1; echo "TEST_EXIT=$?"`——重定向后取退出码，不用管道。

---

## 二、本段提交

| 提交 | 内容 |
|---|---|
| `e482473` | `/switch` 会话切换：`agent`/`sessionId` 可替换、切换时重置流式/日志中间态、丢弃旧会话 pending 审批（`ApprovalBridge.dropSession`）、未注册目标先补注册 |
| `b484678` | Wave 3 分派器：`src/runtime/dispatcher.ts`（`planDispatch` 校验 + `dispatchTasks` 并发池，失败隔离）+ `/dispatch` 宿主命令 |
| `55b0f61` | 客户端寿命与运行时寿命解耦：`terminal-server.ts` 会话代际（`accept`/`endSession`/`close`）、`chat-serve.ts` accept 循环 + 固定 `serveSessionId` + 信号关闭、`runChat` 优先复用 `agents.get`（未注册才注册；续接时 `seenSeq` 对齐日志最大 seq） |

新测试：`test/cli/switch-command.test.ts`（7）、`test/runtime/dispatcher.test.ts`（6）、`test/cli/dispatch-command.test.ts`（5）、`test/runtime/terminal-reconnect.test.ts`（5）、`test/cli/resume-session.test.ts`（3）、`test/runtime/terminal-pipe.test.ts` ⑧（端到端重连）。

---

## 三、全量测试挂起的处理纪律（本段踩坑，**必须遵守**）

本段多次观察到全量测试「无汇总输出、进程挂住」；其中 01:20 / 01:29 两次相隔 9 分钟、
中间未做定位即重跑——**四次运行均无输出，重跑不能提供新信息**。约定如下：

1. **不要连跑全量碰运气**。挂死后先定位，再决定是否重跑。
2. **分批运行**：把 `test/` 按目录分成 3–4 批（例如 ledger+authority / runtime / memory+acceptance / 其余），
   逐批跑并记录各批的退出码与耗时。哪批挂住，范围就缩到该批。
3. **限制并发**：`node --disable-warning=ExperimentalWarning --test-concurrency=1 --test "test/**/*.test.ts"`
   ——默认并发按 CPU 核数，profile/sqlite/命名管道/子进程的资源竞争是首要嫌疑。
4. **单测超时**：定位到具体文件后单独复现，并加 `--test-timeout=30000`：
   ```sh
   node --disable-warning=ExperimentalWarning --test-timeout=30000 --test test/xxx/yyy.test.ts > /tmp/one.log 2>&1
   echo "EXIT=$?"
   ```
5. **读日志定位**：`tail -50 /tmp/all.log` + `grep -c '^✔' /tmp/all.log` 看跑到哪；
   spec reporter 按文件输出，最后一个完成的用例之后就是挂住点。
6. **本段已定位的机制（2026-11-05 实测）**：
   挂起点是 `test/sandbox/workspace-acl.test.ts` 的 **T3（appcontainer ACL 用例偶发失败）**。
   失败时断言抛出 → `out.app.dispose()` 被跳过（它写在断言之后）→ `startRuntime` 的持久
   pwsh 子进程/管道不关 → 测试文件子进程不退出 → 全量 runner 一直等它，报告写不完。
   判别与规避（都实测过）：
   - 单文件复现：`node --test --test-timeout=30000 --test test/sandbox/workspace-acl.test.ts`
     ——10 条测试全部跑完、文件级报告已输出、进程不退；**`--test-timeout` 管不到退出阶段**。
   - 排除法：`--test-name-pattern='^(?!T3 )'` 跑同一文件 → 正常退出（11/11，24.6s）。
   - 拿完整报告：加 `--test-force-exit` → 本次 11/11 pass（21.7s），说明 **T3 失败是间歇性的**，
     不是每次必现。
   - **已修**：T3 的 dispose 移入 `try/finally`（`test/sandbox/workspace-acl.test.ts:156-167`），
     失败也不会再挂住 runner。T3 的偶发失败本身（appcontainer ACL 时序）仍未查清，属预存问题。
7. 串行全量本身（`--test-concurrency=1`）同样会挂——**并发不是原因**；
   它会停在同一个文件之后（716 pass / 2 fail 时停住）。

### 第二次定位（2026-11-05，本轮修复）

单文件连跑 `workspace-acl.test.ts` 复现：**10 次里第 8 次挂住（exit=124）**。现场三链：

1. **T2/T3 的 `r[3]` 偶发空串**：`transcript()` 只要出现**任意一条** `tool/result` 就返回，
   5 条命令的用例会拿到半截日志（`Get-Content .git\HEAD` 那条还没落盘）。
   且旧实现每轮 `text += 读整个文件` 不重置，会让计数虚高、更早 break。
2. **T1/T2 的 dispose 在断言之后**（与 T3 同族）：任一条断言失败 → 跳过 `dispose()` →
   持久 pwsh 不关 → 测试子进程不退出 → runner 无汇总等待。
3. **after 钩子的 `rmSync` 遇 ACL 残留抛 EPERM** → 整个文件被标记为红。

修复（`workspace-acl.test.ts`）：
- `transcript(dr, expectResults)` 按期望条数等待，每轮重新读、不累加；
- T1/T2 的 `dispose` 移入 `try/finally`；
- `after` 的 rm 包 try/catch（清理失败不把文件标红）。

另修一处**产品时序**（`src/runtime/subtask.ts`）：`spawnSubtask` 在 `waitIdle` 返回后
立即读摘要，全量并发下日志可能还没落盘（实测偶发空串）——改为轮询最多 3s，
worker 合法无产出时仍返回空串。

验证：单文件 10 连跑 **0 挂起**；全量 5 连跑 **0 挂起**（4 次 796 全绿、1 次 1 fail 即
上述 subtask 时序问题），修复后全量 3 连跑 **796/796 全绿**。

---

## 四、未做清单

| 项 | 阻塞类型 |
|---|---|
| 常驻 Router 第二步：多入口并发（终端 + 其他通道）、Router 自身上下文预算 | 需要真实负载才能验收（R2） |
| ~~`/switch` 与真实 DSH agent 的端到端验证~~ | **已完成（2026-11-05，`4941f0b`）**：`test/acceptance/switch-real-agent.test.ts`，判据是 assistant/message 归属 |
| ~~`chat-client.ts` 自动重连~~ | **已完成（2026-11-05，`f6163cc`）**：重读 endpoint + 退避重连，`/exit` 主动退出 |
| ~~注册覆盖面 + 翻牌~~ | **已完成（2026-11-05）**：6 个 fixture 补注册，`decideSessionScoped` 未注册分支已翻为 deny，全量 787 绿 |

---

## 五、冒烟体检（2026-11-05，真实环境实测）

真实数据根 `C:/prts-data`、工作区 `C:/prts-workspace`，key 从 Windows 凭据管理器
（target `PRTS/DeepSeek`）读出，无警告。

- 最小冒烟：`printf '你好\n/exit\n' | env PRTS_DATA_ROOT=... PRTS_WORKSPACE=... PRTS_CONFIG=... node src/cli/chat-main.ts`
  → **exit=0**，真实模型回复，共 1 轮。
- 完整冒烟（设计 §四之二 的版本）：加 `PRTS_EMBED=1 PRTS_RERANK=1` → **exit=0**，
  `[prts] memory vector index warmed: 0 rows / dim 0 / 1 ms`。**dim 0 说明 embedding
  模型未实际加载**（空库）——启动链路通过，记忆向量功能本身未验证。

## 六、证据边界（不要当成已验证）

- **787 是并发模式的实测**；串行模式（`--test-concurrency=1`）的定位结果见下一条记录。
- **全量挂起的根因未独立验证**：只观察到「无汇总输出、进程挂住」的形态与 sandbox runner 附近的停点。
- **子会话端到端未真机验证**：`spawnSubtask`/分派器只在 fake agents 上测过。
- **`/switch` 的 `agents.get` 可用性已核实类型与实现**（`dsh-agent/lib/index.js:596-598`），
  但真实运行时上的切换未实测。

---

## 七、接手第一件事

先按 §三 的方式跑一次**分批**全量（或串行全量），确认基线；不要直接连跑默认并发的全量。
