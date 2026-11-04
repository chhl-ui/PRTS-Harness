# 会话交接（2026-11-04 第五段）

**写给完全没有上下文的新会话**：本文自包含，不引用任何未落字的对话。

**起点**：上一个交接是 `docs/HANDOFF-20261104-session-d.md`（HEAD `1d2659c`，701 测试）。
**本段范围**：Wave 0–2 全部完成、Wave 3 第一步（会话表 + `/sessions`）、两份设计稿。

---

## 一、当前状态

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `c53ec97` | `git log --oneline -1` |
| 分支 | `main` | — |
| 全量测试 | **760 pass / 0 fail** | `/tmp/all19.log`（`5ab6f49` 提交时实测，44.3s） |
| 类型检查 | `tsc -p .` exit=0 | 同一轮 `TYPECHECK_EXIT=0` |
| 工作树 | tracked 干净；未跟踪只有 `.rivet/`、`nul` | `git status` |

**注意**：`c53ec97` 是纯文档提交（`/switch` 设计），之后**没有再跑全量**——数字 760 属于 `5ab6f49` 时的代码状态，两者代码相同（只多了 `.md`）。

**测试命令**：`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/all.log 2>&1; echo exit=$?`——重定向后取退出码，不用管道。

---

## 二、本段 19 个提交

| 提交 | 内容 |
|---|---|
| `babc2bc` | **Wave 0 授权收窄**：once 跨会话拒绝、grant 会话归属（`audit_grants.session_id` + 幂等迁移）、空会话 fail-closed |
| `2aebec4` | **Wave 1 装配器**：最外层 pre-step 统一计费、按链优先级裁剪、装配总账 |
| `7e443ef` | 提醒投递成功后才留痕 + 记投递会话 |
| `ee2a639` | Wave 1 尾巴：intent 投递确认经装配器 `onDelivered`，留痕带会话 |
| `7e25fa8`/`ffead69` | 文档：Router + Workers 方向更新与前置三问（`ChatDeps` 行号、命令全集修正） |
| `5c5b813`/`eb9e13a` | `docs/design-session-identity.md`：会话身份设计 + handler 行号修正 |
| `d1c290a` | **会话身份注册表**：事件 `session.registered`/`session.released` + 投影 `audit_sessions` + 重建 |
| `c03c31c` | **会话身份 API**：`registerPrimarySession`/`registerSessionRoots`/`releaseSession`/`isSubagentSession`/`hasSessionScope`（读投影、无缓存） |
| `dca93cf` | **写入口径**：`decideSessionScoped` 只收窄已注册子会话；`chat.ts:512` 主会话注册接线 |
| `9c2ea1c` | 翻牌实测 #1：未注册 deny 打穿 11 条 → 回退 defer，数据入设计稿 |
| `4cd6b28` | `test/support/drive.ts` 的 `runTurn` 支持注册主会话 |
| `d9cdaa5` | 翻牌实测 #2：仍 10 fail（6 个测试 fixture）→ 维持 defer |
| `efac6bb` | `src/runtime/subtask.ts` 纯函数层：taskId 白名单 + 目录越界复验 |
| `bc52a89` | `spawnSubtask` 编排（先注册后 create、失败释放）+ `prts_subtask` 派生闸 |
| `e34c27f` | `prts_subtask` 接进运行时（动态父会话 + `output.render`） |
| `5a92358` | 会话表：live（`AgentRegistry.list()`）∪ disk（`dsh-home/sessions`） |
| `f46c8f5`/`5ab6f49` | `/sessions` 命令 + CLI 级验收 |
| `c53ec97` | `docs/design-switch-session.md`：`/switch` 状态重置清单与协议 |

---

## 三、关键设计决定（下一个人必须知道）

1. **会话身份是一等概念**：`audit_sessions` 是授权事实（事件 + 投影 + 重建），不是缓存；读写直查、无进程内缓存（与 `authority.ts:22-25` 同一不变量）。
2. **未注册 = 主会话（defer），不翻牌**。两轮实测：11 → 10 条失败，全部是测试 fixture 的未注册会话；生产只有 `chat.ts:499` 一处 `agents.create`（已注册）。翻牌的剩余成本是改 6 个测试 fixture，不是产品缺陷。数据在 `docs/design-session-identity.md` §3.5。
3. **子会话收窄只对已注册子会话生效**：`decideSessionScoped` 空→deny、未注册→defer、主会话→defer、已释放子会话→deny、活跃子会话 roots 内 allow / 全局 workspace 内 roots 外 deny。
4. **子任务派生顺序写死「先注册后 create」**：反过来会留一个「已创建但未注册」的窗口，子会话会以主会话权限运行。
5. **`prts_subtask` 的派生闸**：子会话调用一律拒（深度上限 1，不依赖 `delegationDepth`——框架没有上限逻辑）。
6. **装配器必须最先注册**：Cordis waterfall 是「先注册 = 最外层」（`cordis/src/events.ts:234-243`），只有最外层能看到七条链的全部追加。

---

## 四、未做清单（按阻塞类型）

### 无外部阻塞（可直接做）

| 项 | 说明 |
|---|---|
| **`/switch` 实现** | 设计在 `docs/design-switch-session.md`（状态清单 10 项、协议、验收 7 条）。实现前必须核实 §六 的 3 个前提：`agents.get(id)` 能否直接 followup、旧 agent 是否 dispose、pending 审批的清理钩子 |
| **注册覆盖面** | 6 个测试 fixture 的未注册会话（`authority.test.ts`、`read-only-subpaths.test.ts`、`session-scoped-write.test.ts`、`guard-wiring.test.ts`、`ledger-step.test.ts`、`task-loop.test.ts`）——补齐后可重跑翻牌 |
| **Wave 3 分派器** | `prts_subtask` 已具备，Router 侧分派逻辑可复用它 |

### 需要外部条件

| 项 | 阻塞 |
|---|---|
| Wave 4 产品能力 | V1-15 主题目录 section、V1-05 情感样本、V1-09 真实进化流程、V1-10 真实任务、V1-17 公开基准、V1-12 全新安装核对 |
| V1-02 第二提供方 / V1-11 语音 | 缺第二个 key / 音频栈 |

---

## 五、踩过的坑（会复发）

1. **team_orchestrate 的 worker sessionId 含空格即非法**（`worker-team-Task 1-59809`）——任务标题不要带空格，用 `Task-1` 或 `T1`。
2. **interference_search 的 apply 会因主工作区与搜索基线不一致被拒**——搜索期间不要动同一批文件；被拒后只能手工落地。
3. **DSH 工具注册要求 `output: { schema, render, presentationMeta? }`**——漏 `render` 会让整个 `startRuntime` 抛错，表现为「全量测试大面积崩」，不是单测失败。
4. **全量偶发挂起**：本段遇到一次 300s 超时（无汇总输出），重试 44.9s 全绿。已知根因指向 appcontainer 同步 ffi（`CreateAppContainerProfile`），与代码改动无关；不要因一次超时就改代码。
5. **议事会 30+ 次否决的根因不是描述问题**，是「会话身份缺一等概念」——每次补一个洞会在下一个缝被否决。设计稿 §一 的四件必须同时成立。
6. **`edit_file` 同文件多处修改要在一次 operations 里做**（带 `expected_version`），否则第二处会因版本漂移失败重试。

---

## 六、证据边界（不要当成已验证）

- **翻牌数据是两轮实测**（11 条、10 条失败），不是推测；但「6 个 fixture 补齐后能翻牌」是**推断，未实测**。
- **子会话端到端未真机验证**：`spawnSubtask` 只在 fake agents 上测过（SP1–SP5），真实 DSH agent 的 followup/摘要提取未跑。
- **`/switch` 设计未实现**，§六 的 3 个前提未核实。
- **760 绿是 `5ab6f49` 时的状态**；`c53ec97` 只加了一份 `.md`。
- **议事会记录**：`council_convene` 多次流会（席位 `missing_artifact`），最终用两席通过；席位模型是 `deepseek-flash`，其贡献建议复核后再采纳。

---

## 七、接手第一件事

```bash
cd C:/prts-system
npm run typecheck
node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/t.log 2>&1; echo "exit=$?"; grep -E "^ℹ (tests|pass|fail)" /tmp/t.log
```

期望：exit=0、**760 pass / 0 fail**。

两条都绿之后，按 §四「无外部阻塞」挑一项：
- 想推进 Router → 先核实 `/switch` 的 3 个前提，再按设计实现；
- 想收口翻牌 → 补 6 个 fixture 的注册，重跑「未注册 → deny」实验。
