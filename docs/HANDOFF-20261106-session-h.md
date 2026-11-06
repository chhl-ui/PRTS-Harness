# 会话交接（2026-11-06 第八段）

**写给完全没有上下文的新会话**：本文自包含。起点是 `docs/HANDOFF-20261105-session-g.md`
（第七段，HEAD `01195d5`）；本段是它之后的 49 个提交。

---

## 一、当前状态（2026-11-06 收尾实测）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `5fd8908`（DSH 升级） | `git log --oneline -1` |
| 全量测试 | **848 pass / 0 fail × 3 连跑** | `/tmp/up2-1..3.log` |
| 依赖 | DSH 全线 **0.2.2-rc.1**（含 cordis 4.1.0 / include 1.1.0 / timer 1.2.0） | `package.json` |
| typecheck | `tsc -p .` exit 0 | `/tmp/final-tc.log` |
| 工作树 | tracked 干净；untracked 只有 `.rivet/`（工具产物） | `git status --short` |

测试命令：`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/all.log 2>&1; echo "TEST_EXIT=$?"`。

### DP5 flaky：已定位并修复（2026-11-06）

`test/runtime/dispatcher.test.ts` 的 **DP5 摘要归属**曾在全量并发下偶发失败
（`r[1].summary` 得 `''`，期望 `'摘要 d2'`；修复前 2 次全量里 1 次红）。

**根因**（探针实测，不是推断）：`waitIdle`（`src/cli/chat.ts:114`）有约 **410ms 的固定下限**——
`setTimeout(150)` 起步 → 循环里 `Date.now()-t0 > 200` 才肯相信 idle → 再加 50ms 轮询粒度，
实测单次 **411–414ms**。而 `env()` 给的是 `timeoutMs: 600`，**余量只有 ~190ms**。
全量并行时 setTimeout 抖动越界 → `waitIdle` 返回 false → `spawnSubtask` 抛
「未在时限内收敛」→ `runOne` 的 catch 返回 `summary: ''`。DP5 只断言 summary，
所以症状表现为「摘要归属错了」，把真正的「超时」藏了起来。

**修复**（`test/runtime/dispatcher.test.ts`）：

1. `env()` 的 `timeoutMs` 600 → **2000**（余量 190ms → ~1590ms）；
2. DP5 补 `ok` 断言，失败时把 `error` 打出来——下次再红能直接看到原因；
3. 新增 **DP7**：钉住「分派预算必须覆盖 waitIdle 的 ~410ms 下限（≥1500ms）」，
   防止将来又被调回贴着下限的值。

**注意**：`waitIdle` 是 PRTS 自己的代码，**DSH 升级到 0.2.2-rc.1 不会修掉这个 flaky**。

---

## 二、本段工作线（按类，非逐提交）

### 1. V1 验收推进（`docs/TODO.md` §A 有完整对照表）

本段把 V1-01 / V1-02 / V1-05 / V1-06 / V1-12 / V1-16 / V1-17 推到「有实测证据」：

- **V1-01**：插件名解析失败不再静默（`d1253ec`，`PRTS_STRICT_PLUGINS=1` 可升级为启动失败）；
  boot 失败时把 `cause.errors` 展开到顶层（`c7c1dc5`）。判据三条里「禁用时有明确提示」仍是 ⚠️。
- **V1-02**：五项独立性全部有实测（`21ce477`）——关 DSH 冷启动 / 对话 / 执行任务 / 读写记忆 / 第二提供方（Strata 双协议）。
- **V1-05**：系统侧生产者 `轮次失败 → 写「受挫」`（`e46da94`）；接线段 live 测试
  `test\runtime\emotion-wiring.test.ts`（`4fe0861`，摘掉 `start.ts:1142` 的 `onReport` 即红）。
- **V1-06**：真实链路验收（`e86742c`）——10 条对话 turn → `consolidateFacts` → 重启后 ≥9 可检索，含反证。
- **V1-12**：导出补 `persona.sqlite`（`f116399`），真实数据根 12 项核对相等。
- **V1-16**：装配 p95 1610→815ms（`2d6a4e0`），root cause 是 `turnEntities` 查询写法，不是候选宽度。
- **V1-17**：`npm run verify:memory` 成为硬门禁（`f6251b6`），基线 45.09%。
- **V1-18**：冻结（NInfer 每 9–14 分钟 CUDA 崩溃）。

### 2. 桌面端只读查询（`a39a545` + 桌面仓 `c651b3b`）

按 `PRTS-DESKTOP-QUERY-PROTOCOL-DRAFT-2026-11-06` 实装服务端：

- `src\runtime\owner-protocol.ts`：`QueryRequest` / `QueryResultPush` / 解码 / 构造器。
- `src\runtime\owner-query.ts`（新）：五类取数（tasks / sessions / intents / memory / sandbox），只读边界。
- `src\runtime\terminal-server.ts`：`onQuery` 旁路——任何相位可查（含审批期）、不推 status、不改 phase。
- `src\runtime\start.ts` 暴露 `sandboxModeFor`；`src\cli\chat.ts` 加 `onSessionChange`；`chat-serve` 延迟绑定。

**未验证**：桌面端 UI 没开窗看过。链路四层形状已核实一致（`pages.js:38` → `preload.cjs:15` →
`main.cjs:178-186` → `pipe-client.cjs:92`），服务端实测回 `ok:true`。

### 3. 工具补齐（`9db6320`）

对比 Claude Code 的 18 个工具后补的两个 DSH sibling 包：

- `dsh-tool-fs-search` → `glob` / `grep`。**坑**：只装 JS 时启动不报错、首次调用才失败
  （`allowScripts` 拦掉了 `@vscode/ripgrep` 的 postinstall），必须同时装
  `@vscode/ripgrep-win32-x64`（已放 optionalDependency）。
- `dsh-fs-observation-policy` → 写前必读。**坑**：实际语义是「写成功也算已观察」，
  同一会话写完立刻覆盖是允许的，只有从未接触过的文件才被拒（`dsh-fs-local:871`）。

回归 `test\runtime\fs-tools.test.ts`（F1 glob/grep 真调一次、F2 三段式；含 `disabled: true` 反证）。

### 4. 其他

向量重排被数据否决（`dc058a0`，45.0%→40.0%）；S10 空回复根因 `waitIdle` 120s 超时
（`eef25fe`）；回合超时可配且不 push 空串（`b847439`）；embedding 换 llama.cpp CPU
（`9f218ae`）；`/sandbox` 三档（`d3a7d80`）；工具活动推送 M3（`6b85a61`）。

### 5. DSH 升到 0.2.2-rc.1（`5fd8908`）

**不是改版本号，是一次小型迁移**，三条实测成本记在 `docs\TODO.md` §I：

- cordis 生态必须同升（include 1.1.0 / timer 1.2.0 / cordis 4.1.0）
- **tool executor 拆成独立 provider**：缺它则启动不报错、第一个真实回合才以
  `TOOL_EXECUTOR_UNAVAILABLE` 失败（第一次全量 46 个测试全红，3 次完全一致）
- 旧 lock 与已装 node_modules 会挡住 npm 解析，必须移开重新解析

收益是 0.2.2 的几条运行时修复（上下文前缀缓存复用、普通会话不再被误判为子智能体、
预设切换后委派工具缺失、sdk-minimal 恢复记录、`~` 路径展开等），但**大头是 DSH
自己的 GUI**，PRTS 自带界面、用不上。

---

## 三、未完成（接手续做时的候选）

| 项 | 状态 |
|---|---|
| V1-05 博士打分 | 10 情境 9/10 有回复，材料 `C:/prts-benchmark/v1-05-scenarios.json` |
| V1-03 / V1-04 盲评 | `/persona prts` 已可切换；当前 active 仍是 `priestess` |
| V1-18 扩样 100+ | 冻结（NInfer CUDA 崩溃） |
| **grep 超 cap 的 spill 行为** | **未验**：`grepMaxMatches` 默认 250，超出部分需 `dsh-spill-local`（未装），PRTS 自己的 `src\spill\` 不同层 |
| 真模型用 glob/grep | 未用：只用 scripted LLM 验过工具可调 |
| V1-01「禁用时给提示」 | 仍是 ⚠️（DSH 日志通道未探） |
| `npm audit` 54 漏洞 | 没有装前基线，不能判断是否本轮新增 |

---

## 四、接手第一件事

```sh
cd C:/prts-system
npm run typecheck
for i in 1 2 3; do node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/t$i.log 2>&1; echo "run $i exit=$?"; grep -E "^ℹ (tests|pass|fail)" /tmp/t$i.log; done
```

期望：typecheck 0 错误；全量 **848 左右**。DP5 已定位并修复（见 §一）。
若它再红，读 DP5 的 `ok` 断言输出——现在会把 `error` 打出来，不用再猜。
