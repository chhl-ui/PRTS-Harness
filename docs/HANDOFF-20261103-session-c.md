# 会话交接（2026-11-03 第三段）

**写给完全没有上下文的新会话**：本文自包含，不引用任何未落字的对话。读者看不到上一个会话的消息。

**范围**：7 个提交，把「人格 / 情感 / 进化」三块从零覆盖推到有机制，并修了一个并发测试缺陷。

**起点**：上一个会话交接于 `486908b`，当时 494 测试、上下文装配 ⑦ 未做。

---

## 一、当前状态（2026-11-03 实测）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `fe8fe2f`（写本文时；本文自身提交后会变，核对以 `git rev-parse --short HEAD` 为准） | `git log --oneline -1` |
| 分支 | `main` | — |
| 工作树 | tracked 干净；未跟踪项只有 `.rivet.md` 与 `nul` | `git status --porcelain` |
| 全量测试 | **629 pass / 0 fail**，连续两次（41.8s / 43.8s，均 exit=0） | 见第二节「正确的测试命令」 |
| 类型检查 | `tsc -p .` 未报告错误 | `npm run typecheck` |
| 规模 | src 105 个 `.ts`（18,948 行）；test 123 个 `.ts` | `find` + `wc -l` |

---

## 二、正确的测试命令（上一个会话踩过，别重犯）

**不要用管道取退出码**：

```bash
# ❌ 管道让 $? 变成 grep 的退出码——测试挂了也会显示「通过」
node --test "test/**/*.test.ts" | grep -E "^ℹ pass"

# ✅ 三种正确形态
npm test                                                    # 退出码由 npm 传播，最省事
node --test "test/**/*.test.ts" > test.log 2>&1; echo "exit=$?"
node --test "test/**/*.test.ts" 2>&1 | tee test.log > /dev/null; echo "exit=${PIPESTATUS[0]}"
```

上一个会话因此把一次 **300 秒超时**误读成「测试失败」——真实退出码从来没被测到过。改掉之后才发现：那次是超时（`exit=-1` 是 bash 工具杀的），不是测试红。

---

## 三、本次 7 个提交

| 提交 | 内容 |
|---|---|
| `974ef12` | **跨会话连续 S4**（⑦）：新增 `MemoryStore.recentTurns` + `src/runtime/session-recall.ts`。新会话开场从「未结任务 / 待触发意图 / 近期情景」重建「上次聊到哪里」 |
| `6017e9e` | 补 RTX4：`recentCorrections` 的 NaN limit 曾直接抛 `ERR_SQLITE_ERROR`（回滚验证过） |
| `1061e67` | **V1-09 进化**：`src/skills/` 技能与经验的「候选 → 评估 → 采用 → 回退」 |
| `459c5a7` | 技能进上下文：`src/runtime/skill-inject.ts`，只注入 `active` |
| `206201d` | **人格底座**：`src/persona/`，核心设定只有 owner 能改，接进 `bootPatches` 覆盖 `personaPrefix` |
| `eea60c9` | 修 AppContainer profile 全局冲突：并发跑测试不再互踩 |
| `fe8fe2f` | **V1-05 情感**：`src/emotion/`，持久化 + 读时衰减 + 事实隔离，接进 pre-step |

### 关键设计决定（改之前先读）

- **同一条安全边界的四次出现**：账本「模型只能建 draft」→ 技能「模型只能 propose」→ 人格「只有 owner 能改核心」→ 情感「模型不能设定情绪」。这不是重复，是同一个原则在四个模块的落地：**模型不能自己给自己加能力，也不能自己改自己的底线**。
- **技能**：`evaluate`（取证）与 `adopt`（决策）分开，合并就分不清「评估过了但没采用」与「根本没评估」。
- **人格**：`verifying` 属于未结——`claimDone` 的落点是 `verifying`（`fold.ts:104-106`），`ownerAccept` 才到 `done`（`:107-109`）。「交上来等博士点头」正是最典型的没做完的事。
- **情感**：衰减是**读时计算**，不写链。写链会让「情绪」变成事件流，读一次涨一条。

---

## 四、模块状态

### 已做（本段新增能力）

| 模块 | 状态 |
|---|---|
| 记忆检索/巩固/删除/纠正/阅读/精排 | 代码收口；产品口径 @5 28.8% → rerank 后 38.1%（离线基准） |
| 前瞻记忆 V1-14 | 表 + 状态机 + 触发注入 + `/intent` 命令 |
| 上下文装配 ⑦ 跨会话连续 | 三源已完成；关系记忆属 V1-05，未做 |
| 上下文装配 ⑧ 清单 | 注入与跳过都留痕；缺另三条早退 |
| **V1-09 进化（技能与经验）** | 完整：状态机 + 护栏 + 工具面 + 上下文注入 |
| **人格底座 V1-03/04/05/09** | 机制完整（核心/风格分层、切换、审计、bootPatches 接线）；**人设文本待博士审定** |
| **V1-05 情感** | 可自动化部分完成：持久化 + 衰减 + 事实隔离 + 表达层注入 |
| 导出导入 V1-12 | 记忆/人格/任务历史三项齐全 |
| 权限 K2a + K2b(net) | `authority.ts:176-190` 三种判定齐全 |

### 未做

| 项 | 阻塞 |
|---|---|
| **V1-07 主动回忆** | `src/` 零覆盖。`design-memory-v1.md:1077` 明确把它排除在记忆模块外，是独立一格 |
| **V1-11 终端与语音** | 按键说话 / 播报 / 打断，`src/` 零覆盖 |
| **V1-03/04 人格内容** | 机制已建，口头禅/播报格式/对博士的态度按架构需求 §10 第 7 条**需博士审定** |
| **V1-05 的 10 个情境样本** | 人工验收，测试只用占位文本 |
| ③ 预算裁剪 | 等 `used_chars` 真实分布；8000 这类常量两端都不成立 |
| ② 顺序通道 | `includeRuntimeContext` 打开后模型是否真看到未验证（`markerIndex: -1`） |
| ⑥ 子任务上下文 | 依赖权限收窄能力 |
| H3 shell 读隔离 | 四条系统层路径实测证伪，待架构决策 |

---

## 五、接手第一件事

```bash
cd C:/prts-system
npm run typecheck                                              # 期望未报告错误
node --test "test/**/*.test.ts" > test.log 2>&1; echo "exit=$?"  # 期望 exit=0，629 pass
```

两条都绿之后，按 ultar-mode 的序列做下一个模块：**先写验收测试（基线必须红）→ `interference_search(action="search", ...)` → apply → 逐条复核审查意见 → 全量 + typecheck**。

本段 7 个提交里，有 4 个走得通「极限思考」全流程（人格、情感、skills 注入、sandbox 修复），每次 5/5 写工、16–21 分钟、5M–8M token。

---

## 六、踩过的坑（会复发）

1. **管道掩盖退出码**。见第二节。上一个会话因此把超时当成失败。
2. **并发跑测试会冲突**。`PRTS.Sandbox` 是 Windows 用户级全局 AppContainer profile，两个 `node --test` 同时跑 sandbox 测试必有一个失败。已修（`appContainerProfileName()` 在 `NODE_TEST_CONTEXT` 下按 pid 隔离）。**但若有人开 `--experimental-test-isolation=none`，隔离会失效**——那个前提写在 `src/sandbox/provider.ts` 的注释里。
3. **`bootPatches` 是顶层键整体覆盖，不是深合并**（`dsh-app-boot/lib/index.js:96` 的 `target[key] = value`）。只给 `config.personaPrefix` 会把 `includeHarnessIdentity` / `includeRuntimeContext` 一起抹掉——三个字段必须写全。
4. **`verifyChain` 的 `toFields` 必须回填 `seq`**。`appendChained` 写入时算的是 `chainHash(prev, {...fields, seq})`，`verifyChainRows` 把 `toFields` 的返回值原样喂给 `chainHash`（`chain.ts:53`）。少一个字段，**正常链也会被判成断链**——而「断链测试」恰好断言 `ok:false`，漏字段的实现照样通过，是假绿。每个新模块的断链测试都要先钉「正常链 ok:true」。
5. **写工可能把测试文件放进 `src/`**。那里不会被 `node --test "test/**/*.test.ts"` 收集，等于一份没人执行的断言。落地候选后检查文件位置。
6. **Windows 句柄释放滞后**。PRTS 现在打开 5 个 sqlite（core/memory/skills/persona/emotion），`runtime.test.ts` R4 在 shutdown 真实 main.ts 后删临时目录会间歇 EPERM。`test/support/tmp.ts` 已放宽到 30×100ms（3 秒）——正常情况第一次就成功，只有真泄漏才耗满，**仍然会失败**，不掩盖问题。
7. **`{...store}` 展开会丢原型方法**。测试里 spy 一个 store 方法不能用展开，用 `Proxy` 或 `Object.assign(Object.create(store), {...})`。
8. **不要用 python/shell 打补丁改代码**（除非是刻意的回滚验证）。含转义的代码改动一律走 `edit_file`。

---

## 七、证据边界（不要当成已验证）

- **真实 chat 极少**：所有对话链路的效果判断都来自离线基准与单测。`persona-live` / `session-recall-live` 用 scripted LLM 跑真实 runtime，证明了「接线生效」，**不证明模型行为变好**。
- **真实库 `C:/prts-data/memory.sqlite` 是空的**（0 turn / 0 session / 0 向量）。
- **`used_chars` 没有真实分布**：注入清单只在测试库里产生过数据。
- **`tool.loop.suspected` 没有真实样本**：阈值 5 是设计文档建议值。
- **技能库 / 人格库 / 情感库没有真实使用数据**：全部是测试里造出来的。V1-09 的「越用越熟练」、V1-05 的「反应得体」都还没有被真实使用验证过。
- **记忆 38.1% 是离线基准数字**，不是使用级结论。

---

## 八、文档位置

- 设计与计划：`C:\Users\Administrator\Desktop\设计和计划\`（先读其中 `README.md`）
- 仓内最新：`docs\context-assembly-status.md`（七条对账与 S1–S5 切片）、`docs\design-superagent-fusion.md`（五模块对账、W1–W3、否决清单）
- 资产总索引：`C:\Users\Administrator\Desktop\PRTS-INDEX.md`（其中验证数字已过期，以 `npm test` 当前输出为准）
