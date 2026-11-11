# PRTS 待办清单

> 详细判据与恢复命令见 `docs/PENDING-2026-11-05.md`。最后更新：2026-11-11（DESIGN-08 落地，耦合边全部接齐）

## 0. 初版范围变更

- **V1-11 语音移出初版**（2026-11-05 决定）：`src/` 里零音频代码（`tts|speech|audio|voice` 无一命中），
  判据「按键说话往返 / 播报可打断 / 打断不等于取消任务」没有实现基础。改为**后续作为插件单独做**。
  理由：语音是可选能力，不该拖住核心；它同时是 V1-01「可选功能插件化」的第一个真实用例。
- **本地生成（Strata）冻结**（2026-11-09 决定）：`prts_memory_summarize` 需要本地生成端点（默认
  `127.0.0.1:8080`）。本机 Strata 跑 `qwen3.8-flash-next-iq3_xxs`（40 GiB 权重）加载后只剩
  **379–501 MiB VRAM / 0.6–0.7 GiB commit**，任何需要额外分配的请求都会 `0xC0000409` 崩溃
  （连 100 字符的 prompt 也会；与摘要、与上下文长度无关，详见 `docs/v1-10-real-tasks-2026-11-09.md` §六）。
  **决定：先不上本地生成**，摘要功能维持不可用（错误信息已可诊断，不再只报 `fetch failed`）。
  重新评估的前置：换更小权重的模型，或扩大页面文件（当前 4.4 GiB、自动管理关闭、commit limit 65.9 GiB）。

## A. 实现 vs 验收（初版 18 项）

「实现」= 代码在且有调用方；「验收」= 有真实流程证据。两者不是一回事。

| 项 | 实现 | 验收 | 说明 |
|---|---|---|---|
| V1-01 插件机制 | ✅ | ✅ | 30+ DSH 插件；禁用仍启动；写错包名会指名（`60b58b1`） |
| V1-02 独立性 | ✅ | ✅ | 无常驻进程；对话/执行任务/读写记忆/第二提供方全实测 |
| V1-03 PRTS 人格 | ✅ | ❌ | 2026-11-10 盲评**未过**——人格辨识度不足，病因归耦合边未接（博士拍板）；证据与重跑条件见 `C:/prts-benchmark/blind-v1-2026-11-10/VERDICT-2026-11-10.md` |
| V1-04 普瑞赛斯 | ✅ | ❌ | 同 V1-03 当轮未过；切换机械项**已过**（`switch-check.json` 双 true） |
| V1-05 情感 | ✅ | ✅（机制） | 系统侧生产者已补（`ea23bcf`）：轮次失败自动写「受挫」，10 分钟节流，写失败不拖垮上报；**接线段已有 live 测试**（`test/runtime/emotion-wiring.test.ts`，摘掉 `start.ts` 的 `onReport` 即红）；owner 入口 `prts emotion`；2026-11-10 重跑 10/10 有回复（deepseek），**打分未做**，随当轮盲评整体记未过（VERDICT-2026-11-10.md） |
| V1-06 记忆 | ✅ | ✅（链路） | 机制层 10/10；**真实链路已验**（`6ae72da`）：10 条对话 turn → `consolidateFacts` → 重启后 ≥9 可检索，含反证（stub 返回空则测试红）。提炼**质量**（真模型抽得准不准）未验 |
| V1-07 主动回忆 | ✅ | ❌ | 7 天试用 ≥70% 恰当（需真实使用） |
| V1-08 上下文 | ✅ | ❌ | 超窗口 3 倍 + 跨天未完成事项（成本最高的自动化项） |
| V1-09 进化 | ✅ | ✅ | propose→evaluate→adopt→retire→restore + 人格核心守卫（验收脚本 7 项） |
| V1-10 干活 | ✅ | ✅ | 2026-11-09 真机跑通（`docs/v1-10-real-tasks-2026-11-09.md`）：日常＝磁盘盘点 `task-adb68f47`（33 步全成功、报告 3,824B、SHA256 与账本逐字符一致）；科研＝谐振子基态 `task-5df74571`（29 步全成功、E₀=0.50000000019、**独立实现 0.500000000191**、收敛比 4.000 对应 h²）。两条都 verifying→done。未覆盖：任务中断后的 resume 路径 |
| **V1-11 语音** | ❌ **零代码** | ❌ | **已移出初版，见 §G** |
| V1-12 停止权与导出 | ✅ | ⚠️ | 导出导入 12 项核对过；**停机权未验**（等真实误报率） |
| V1-13 连续使用 | ✅ | ❌ | 7 个跨日周期（自动化部分已有，人工待） |
| V1-14 前瞻记忆 | ✅ | ✅ | 10 条意图/重启不丢/取消不触发（验收脚本 4 项） |
| V1-15 元记忆 | ✅ | ✅ | 5/5 找回 + 5 个无关查询各 0 命中（验收脚本 2 项） |
| V1-16 延迟与费用 | ✅ | ⚠️ | 延迟 p95 815ms ✅；**费用分账未端到端验** |
| V1-17 公开基准 | ✅ | ✅ | 基线 45.09%；`npm run verify:memory` 是硬门禁（下降即退出码 1） |
| V1-18 宿主 vs 自管 | ✅ | ❌ | 冻结（host 74/100、self 0/100） |

**小结**：V1-11 移出后，初版 17 项**全部有实现**；验收完成 **10 项**（+V1-05 机制）、部分 2 项（V1-12 停机权 / V1-16 费用）、待博士或外部条件 5 项。

## B. 等博士（判据是主观认定，无法代做）

- [ ] **V1-03 盲评**：20 段 ≥17 段「像 PRTS」+ 5 道陷阱题。**2026-11-10 已跑未过**（人格辨识度不足，病因归耦合边未接通，博士拍板；逐段打分未做，判定为 owner 整体判定，映射未拆）。证据与重跑条件：`C:/prts-benchmark/blind-v1-2026-11-10/VERDICT-2026-11-10.md`。重跑用同一批冻结 20 题。**前置进度（2026-11-11）**：耦合边已**全部接齐** ✅（DESIGN-04/05/06/07/08，见 §G2）；**仅剩人格文本两处小修待博士审定**（owner-only，V1-09）——① prts 预设 style 为空（core 仅 142 字通用助手指令）；② priestess core「不能自行采用技能」与 2026-11-09 adopt 放权矛盾（VERDICT §病因口径）。底座味能否被盖过仍待重跑实证，不预判
- [ ] **V1-04 盲评**：20 段 ≥17 段「像普瑞赛斯」。2026-11-10 同轮未过；切换机械项已过（`switch-check.json` 双 true）。重跑条件同 V1-03
- [ ] **V1-05 打分**：10 情境 ≥8 得体 + 事实不变项。2026-11-10 已用 deepseek 重跑、10/10 有回复（材料在盲评包 `emotion-scenarios.md`），打分未做，随当轮盲评整体记未过。旧材料 `C:/prts-benchmark/v1-05-scenarios.json` 是 Strata 底座跑的（已冻结，不沿用），摘要见 `docs/v1-05-scenario-run-2026-11-05.md`

## C. 可自动化，尚未做

- [x] **appcontainer 三档端到端 —— 全段已验（2026-11-09）**：**confine 层已有真机证据**——`mode: 'read-only'` 下 pwsh 写工作区被 OS 拒（`test\sandbox\live-wiring.test.ts` 新增 pwsh 用例；pwsh 7.6.9 实测：版本可读、workspace-write 能写、越界写与读密钥 denied）。
  新增 `test\runtime\sandbox-mode-live.test.ts`（live）：SM1 部署默认档位可 resolve 出（不是 undefined）；SM2 写 `sandbox/mode` 事件后 `sandboxModeFor` 立即跟上、**第二次切换覆盖第一次**；SM3 档位 per-session 不串。
  依据：`chat.ts:670` 的 append 与 DSH 官方写路径（`dsh-sandbox-policy/lib/index.js:40-42` 的 `setSandboxMode`）是同一行代码，`start.ts:193` 的 `resolveSandboxMode` 调 `ctx.sandboxPolicy.resolve`。
  **「切档 → 模型真写 → 被拒 → 审计留痕」整段也已验**（同日）：真机 `/sandbox view` 后让模型调 write，文件未创建、模型正确报因，审计链出现 `tool.denied`（actor `model`，`reason: sandbox-mode:read-only`，`tool: write`）。
  这一条**原先不成立**——sandbox 拒绝由 DSH 的 fs 后端自己拒、不经过 `Authority.guard`，所以 K4 一条记录都没有。修法：新增 `src\runtime\tool-denial.ts`（判定纯函数）+ `start.ts` 的 `tools/result` 钩子补写审计。回归 `test\runtime\tool-denial.test.ts`（TD1—TD4）
- [ ] **V1-08 上下文**：超模型窗口 3 倍仍答对开头 5 个约束；跨天新会话说出未完成事项（成本最高）
- [ ] **V1-06 的提炼质量**：链路已验（`6ae72da`），但用的是 stub generator；真实模型抽得准不准未验
  （要真实模型 + 标注集，属 LongMemEval 的 fact 抽取范畴）

## D. 冻结

- [ ] **V1-18 扩样 100+**：NInfer 每 9–14 分钟 CUDA 崩溃。恢复：`scripts/v1-18-watchdog.sh` 续跑，或换 Strata 底座

## E. 可选决策

- [ ] **K2b 默认后端是否切 `appcontainer`**：代码默认仍是 `local`，但 `prts-chat.cmd` 已设 `PRTS_SANDBOX_BACKEND=appcontainer`（2026-11-06：部署层已切、代码默认未改）。待评估：性能（`live-wiring` 实测 895ms / 995ms）、icacls 非管理员环境的失败回退
- [ ] **`PRTS_STRICT_PLUGINS` 是否默认开**：现在默认只警告，设 1 才阻断启动
- [ ] **`.rivet/` 是否入库**：`knowledge/` `plans/` `meridian.db` 等工具产物目前 untracked
  （`.rivet/artifacts|cache|checkpoints|scratch` 已忽略）

## F. 需外部条件

- [ ] **V1-07** 7 天试用 / **V1-13** 连续 7 日 / **V1-12** 停机权真实误报率
- [ ] **V1-16 费用分账**：7 天试用的模型费用 vs 巩固费用分开计量、不超冻结额度

## G. 后续插件（新增工作线）

- [ ] **语音插件（原 V1-11）**：按键说话往返、播报可打断、打断不取消任务。
  作为 V1-01 插件机制的首个真实用例——它能把「可选功能插件化」从判据变成实践

## G2. 「更像人」的三个架构缺口（2026-11-09 评估结论）

结论原文：**学得会了，但还是不会自己动。** 三条按「改动性质」排序——第一条是产品边界，后两条是接线。

**状态（2026-11-11）：§G2 全部闭环。** ① 时钟 / ② 跨模块耦合（含 M→E）/ ③ 效果反馈 / ④ 长时间未见 / 学习→情感 / 记忆↔学习 均已落地并验证（全量 1035/1035）。人格基础（记忆/情感/学习耦合）至此接通——下一步是 §B 的盲评重跑，前置只剩人格文本两处小修待博士审定。

- [x] **① 时钟 / 自主唤醒（2026-11-10 落地，方案 B 离屏自主）**
  **落地**：`src\runtime\wake-clock.ts`（调度）+ `src\runtime\start.ts`（接线）；
  单测 `test\runtime\wake-clock.test.ts`（W1—W9）、live `test\runtime\wake-clock-live.test.ts`（CL1，真起回合 + 审计留痕）。
  **博士批准的取舍**：方案 B——时钟自己起离屏会话（`prts-clock-<ts>-<rand>`），
  不依赖任何活跃会话，客户端断开也能触发。
  **四项语义**：① 会话身份每次唯一（复用 id 会撞 `SessionAlreadyExistsError`）；
  ② **不绑任务、不动账本**（自主回合只说一句话，不产生工作项）；③ 审计 actor
  `{kind:'system',component:'clock'}`，事件 `clock.fired` / `clock.stopped`；
  ④ 费用走 dsh 自己的 usage 记录，不记进任何任务预算。
  **节流与自停**：`PRTS_CLOCK_MIN_GAP_MS`（默认 30min）、`PRTS_CLOCK_DAILY_CAP`（默认 8）、
  连续失败 3 次自停（不自动恢复）。数据源：`mem_intents` 到期 + 停滞任务
  （blocked/verifying 超 `PRTS_CLOCK_STALE_HOURS`，默认 2h）。
  **首版只说不做**：正文明确「不要调用工具」，且不改变模型可调用面——K2a 照常兜底。
  `PRTS_CLOCK=off` 关闭；测试上下文默认关（`NODE_TEST_CONTEXT`），live 测试用 `PRTS_CLOCK=on` 打开。
  **未做/已知**：`PRTS_CLOCK_STALE_HOURS=0`
  表达不出来（`envNum` 要求 `>0`，传 0 静默回落 2h，已实测）。
  ④「长时间未见」情感事件源已于 2026-11-10 接上（DESIGN-06，见 §G2 ④ 条目）——
  寄生时钟 `onTick`，只写情绪不说话，不占 dailyCap。
  **2026-11-10 补第三路数据源「惦记着的事」**：`MemoryStore.lonelyFacts`（`store.ts`）——
  读 `importance` + `last_access_ms`，是唯一一条**不看时间截止**的理由。阈值
  `PRTS_CLOCK_FACT_MIN_IMPORTANCE`（默认 0.6，基线 0.5 的事实不进候选）、
  `PRTS_CLOCK_FACT_IDLE_DAYS`（默认 14）；去重复用 `proactive_mentions` 的冷却（7 天），
  不另造一套。一次只挑一条、提过就闭嘴。测试 `test/memory/lonely-facts.test.ts`（L1—L6）+
  `wake-clock-live.test.ts` 的 CL2（真机起回合 + 冷却生效）。
  **注意**：生产库现有 9 条事实 importance 全是 0.5，**这条路径目前不会触发**——
  要么等新事实（情绪写入后 importance 可 >0.6），要么回填旧数据（未做）。
  **2026-11-11 自主性第二步（L2a/L2b）：自主会话的工具面白名单（机制边界）**——
  `src\runtime\clock-tools.ts` + `start.ts` 的 `agents.create({setup})`：离屏会话在发布前
  调 `tools.restrict({ allow })`，名单外的工具对它**不可见**。此前 L1 的「不要调用任何工具」
  只是正文请求（机制上全量工具可用），这一步把边界从提示词搬到机制。
  白名单 6 个：`prts_memory_recall` / `prts_session_recall` / `prts_task_list` /
  `prts_intent_list` / `prts_skill_list`（五个只读）+ `prts_intent_create`（唯一的写：
  给自己安排未来提醒，写 `mem_intents`，博士可 `/intent` 查看与取消）。
  两条工程约束：① **名单与真实注册集合取交集**——技能链断/记忆库打不开时那些工具
  根本没注册，而 `restrict` 对未注册名抛错；直接交静态名单会把「一个模块降级」放大成
  「时钟每次 tick 失败、连续失败后自停」。② 降级兜底——`restrict` 仍失败时退**空集**重试
  （更窄，绝不更宽），同一轮提示词跟着降级，不再宣称工具可用。
  回滚开关 `PRTS_CLOCK_TOOLS=off`（只认字面量 off，拼错保持收紧）。
  **验证**：CT1—CT4（常量与 env 语义）、G1—G7（条件注册 / 降级 / 提示词与机制一致）、
  CL5—CL6（真实运行时：`prts_intent_create` 真落库 / `pwsh` 不执行、文件不产生）。
  **未做**：L2c（写文件/跑命令）、L2d（账本状态机）仍不开——判断力未验证。
  **2026-11-11 自主性第三步（反馈闭环）：应答闸门（DESIGN-09）**——
  时钟开始看自己说的话有没有被接住。`wake-clock.ts` 新增 `deps.lastOwnerTurnAtMs`
  （口径复用 `MemoryStore.lastOwnerTurnAtMs`，排除 prts-clock-*/subtask-*）与
  `deps.silentLimit`（默认 2，0=关闭）；`stats.unanswered` 记连续未获回应的开口数。
  规则：**有到期项时**判断「上次开口之后博士有没有说话」——没有则 streak+1，有则归零；
  连续到 `silentLimit` 次只保留 `kind==='intent'` 的到期项（博士自己定的时间承诺必须准时），
  其余（停滞任务/惦记的事）闭嘴，直到博士开口。due 为空时不累积 streak——
  闲置一夜后第一次有到期项不该被误挡。
  **验证**：W13—W17（单元）+ S1—S6（`test\runtime\clock-silent-limit.test.ts`：默认阈值、
  streak 单调、缺 `lastOwnerTurnAtMs` 时闸门不工作、0 关闭、`parseSilentLimit` 允许 0）。
  接线：`start.ts:1452` 传 `lastOwnerTurnAtMs`、`:1453` 传 `silentLimit`；
  `PRTS_CLOCK_SILENT_LIMIT` 单独解析（`envNum` 要求 >0，传 0 会被静默吃掉——第二个同类坑）。
  **未做**：回应质量（她只知道有没有人理，不知道自己说得好不好）。
  ——以下为落地前的判断，保留作背景——
  ~~现状：全仓无 cron/定时器~~（已过时，`memory-scheduler` 与 `wake-clock` 都是定时器形态）。
  现状：全仓无 cron/定时器（`grep -rn "cron|scheduleJob|wakeup|autonomous" src` 只命中注释与 memory 表的 CHECK）。
  所有"主动"行为都挂在 `agent/pre-step` 或 `agent/turn-stopping`，**必须先有人开口**。
  缺的是「无人时能否主动做事」这个产品决定 + 一个调度器组件。
  判据（待定）：24 小时内无用户输入时，能自己发起一次有意义的动作（提醒 / 整理 / 继续未结任务），且失败不放大。
  **前置**：先答"允许她在无人时做什么、范围多大、停在哪"，再谈实现。
- [x] **② 跨模块耦合（接线，成本低）** —— **三处全部落地**（2026-11-10）
  ~~情绪不调制记忆写入权重~~ / ~~`mem_facts.importance` 无赋值者~~ **已做**：
  `memory/lifecycle.ts:importanceFromValence`（valence +1→0.85、0→0.5、-1→0.15，夹 [0.1,0.95]）
  + `store.ts` 的 `consolidateFacts({ emotionValence })` 每批取一次
  + `memory-scheduler` 的 `currentValence` + `start.ts` 接线 `emotion?.get()?.valence`。
  **隔离约束没破**：记忆库仍不 import 情感库（`emotion/store.ts:24`），走的是取值函数注入。
  测试 `test/memory/importance-valence.test.ts`（P1—P3 纯函数 + E1—E4 端到端；
  E1/E2 带「权重被写小就红」的幅度下限，防止 0.4999<0.5 式的假绿）。
  **真机已验（2026-11-10）**：同一段对话用 `deepseek-chat` 真实抽取两遍——
  valence=+0.8 → importance **0.78**，valence=−0.8 → **0.22**（各 2 条事实，折算逐条一致，
  耗时 1.1s / 1.8s）。证明这条链路在真模型下成立，不只是 fake generator 里成立。
  **已知近似**：巩固是异步的，用的是**巩固那一刻**的情绪，不是原始对话发生时的——
  `mem_turns` 没有时间维情绪快照。回合刚结束那档误差≈0；启动 kick 补积压那档是近似。
  精确做法要在 turn 落库时记效价，是下一层的事。
  ~~剩两处：记忆命中不引发情绪；提到反复失败的项目时情绪有可观测变化~~
  **已做（2026-11-10，M→E，DESIGN-07）**：`runtime/emotion-memory.ts` 两个生产者——
  **想起**：memory-inject 新增 `onHits` 旁路（回调自吞 + 调用点独立 try/catch，
  情绪不成为记忆的新失败面），fact 类命中取注入序第一条 → 每条 fact 链上冷却 7 天
  （`lastEventAtMs` 扩展可选 refId 过滤，payload 加 `refId`，fold 不读 → 重建不变）
  → 「想起」+0.1/0.15；**顾虑**：独立 pre-step handler 注册在 memory-inject **之前**
  （waterfall 的 next() 后副作用逆注册序，外层后写——同轮两写顾虑覆盖想起），
  `trailingFailures ≥ 2`（先拒后收归零）+ 标题共享 token ≥2 或全标题包含 →
  无新结局不重写 → 「顾虑」-0.2/0.3。不做 importance 门控（命中面无该字段、
  生产全 0.5，门控=死边）。零新事件种类、零 schema、零新投影。
  **验证**：ME1–ME17 全绿，全量 **1020/1020**；`npm run verify:memory-emotion`
  27 项对照全绿、零真实模型调用（真实运行时想起+顾虑同轮两写、同会话去重、
  重启后链上冷却仍在、三库重建链逐字节不变）。
  设计文档 `设计和计划\PRTS-DESIGN-07-MEMORY-TO-EMOTION-2026-11-10.md`
  （参考库审查：29+11 仓无「回忆→情绪」「失败史→情绪」实现，自建；
  mood/冷却/阈值为待验证假设）。
- [x] **③ 效果反馈（2026-11-10 落地，归因这一半补上了）**
  原缺口：「这条技能用过之后任务成没成」——采用是闭眼自评，采用之后没有回音。
  **落地**：offer 载荷补 `{sessionId, taskId?}`（`skills/store.ts` recordOffered context）；
  注入层查 `ledger.taskForSession` 带任务上下文、(会话,任务) 去重 + 链去重防重启重复
  （`runtime/skill-inject.ts`）；读侧 `Ledger.outcomeEvents()` 窄口径结局通道 +
  `SkillStore.offers()` + 纯函数 `attribute()`（`runtime/skill-attribution.ts`）读时 join，
  零新事件种类、零新投影；`/skill show` 显示「任务归因：成功 X · 失败 Y（相关性非因果）」。
  **口径**：只认验收结局（owner-accepted / owner-rejected / verified ok±）；
  **claimDone 不算**——它是模型自报，判据要求 M 来自验收而非自述（做法句与判据句冲突时以判据句为准）。
  cancelled / stopped 不归因；无 taskId 的 offer 计 N 不归因；不溯及历史。
  **验证**：设计文档 `设计和计划\PRTS-DESIGN-04-SKILL-ATTRIBUTION-2026-11-10.md`（A1–A7）；
  新增/扩展测试 24 条（AT1–AT9 / OE1–OE4 / SU5–SU9 / SI11–SI14 / K9–K10），全量 969/969 过；
  `npm run verify:skill` 真实路径二跑全绿（真模型注入→claimDone→accept→show 成功 1，
  两库重建数字不变、链校验过；usage in 2592 / out 447）。
  **顺带修了一个既有缺陷**：A7 首跑撞出 `rebuildProjections` 漏清 `task_bindings`——
  凡有会话绑定的账本重建即报外键错（原单测不带绑定测不出来）。已修 + OE4 回归。
  **生产注意**：上线初期归因数字全 0 是预期——历史 offer 无 taskId（普查 offered=0），不溯及。
  **下游解冻**：学习→情感 的前置（③ 验收过）已满足，2026-11-10 博士批准开工，当日落地（见下条）。
- [x] **学习→情感（2026-11-10 落地，DESIGN-05；③ 的下游）**
  带在场技能的任务验收成功/失败 → 一条 `skill-outcome` 情绪（成功「欣慰」0.5/0.35、
  失败「失落」-0.35/0.3），替代当次泛化反馈（一次结局只写一条）；无技能任务走既有
  owner-feedback 逐字不变。钩子在 chat.ts 命令路径（生产唯一结局入口；
  `ledger.verify()` 无生产调用方，不接），纯函数 `runtime/emotion-skill-outcome.ts`
  选择 mood，零新事件种类、重建不重放、写失败吞掉不影响裁决。
  **验证**：新增 16 测试（SE1–SE8 / EM-S2a–f / EM-S3 / EM-S5），全量 **985/985**；
  `npm run verify:emotion` 真实路径 20 断言全绿（先拒后收 失落→欣慰、无技能对照组不变、
  重开库保留、重建后情绪链逐字节不变；usage in 2594 / out 775）。
  **顺带修既有缺陷**：/reject 把 `ref.id` 字符串传给 `ownerReject(TaskRef)`，命令自上线起
  必败（生产 owner-rejected=0、旧测试只走 /accept，一直没露）；已修 + 三条回归。
  设计文档 `设计和计划\PRTS-DESIGN-05-LEARNING-TO-EMOTION-2026-11-10.md`（含参考库审查：
  全库 30 项目无「验收结局→持久情感」实现，自建；最接近的 Tianshu vigor 层不持久、非验收粒度）。
- [x] **④ 情感事件源第四类：长时间未见**（2026-11-10 落地，DESIGN-06；依赖 ① 的时钟）
  §5.1 四类事件源至此接齐（error / turn 收尾 / 博士反馈 / 长时间未见）。
  时钟新增 `onTick` 依赖（守卫后、说话闸门前；抛错只 log 不计投递失败），
  每次 tick 经 `memory.lastOwnerTurnAtMs()`（排除 prts-clock-*/subtask-* 合成会话、
  已删、NULL 时间戳）+ `emotion.lastEventAtMs('long-absence')`（链上去重，零新状态）
  → 纯函数 `shouldWriteMiss` → 超 24h（`PRTS_MISS_AFTER_HOURS`）写一条
  「想念」-0.15/0.25，actor system{long-absence}。**只写情绪不说话**：不起离屏会话、
  不占 dailyCap；博士回来第一回合由既有 emotion-inject 自然带出语气。
  一次离别只写一条，回来后再离别才写第二条；重启/重建后判定不变。
  **验证**：新增 18 测试（AB1–AB13 / W10–W12 / CL3–CL4），全量 **1003/1003**；
  `npm run verify:absence` 26 断言全绿、零模型调用（含合成会话污染对照、
  重开库去重、两库重建链逐字节不变）。
  设计文档 `设计和计划\PRTS-DESIGN-06-LONG-ABSENCE-EMOTION-2026-11-10.md`（含参考库审查：
  全库 29+11 仓无「缺席时长→持久情绪」实现，自建；阈值与 mood 为待验证假设）。
  **下游**：M→E（记忆→情感）已于 2026-11-10 随「④→M→E 连开」落地（见 §G2 ② 条目）。
  耦合边至此**全部接齐**（记忆↔学习 2026-11-11 落地，见下条）。
- [x] **记忆↔学习（2026-11-11 落地，DESIGN-08；最后一条耦合边）**
  带在场技能的任务验收结局 → 一条可召回的**经验事实**（subject=我 / predicate=做过 /
  confirmationBasis=`verifier`（来自账本验收非模型自报）/ provenance=inferred / retirable /
  importance 0.5），正文带标题+结局+在场技能标题，slot=任务标题；`derivedFromTaskId`+`outcomeSeq`
  进 fact.asserted **载荷**（fold 不读 → 重建不变；记忆侧 derived_from=taskId 满足契约 §4）。
  钩子与 DESIGN-05 同点（chat.ts `recordOutcomeEmotion`），复用同一次 offers 读，情绪写后
  **独立 try/catch** 写经验，写失败吞掉不影响裁决与情绪。无技能任务不写（D2 门控）；
  identity_key 原生去重（per-正文：先拒后收两条，同任务同结局重复一条）。M→L 经**既有**
  memory-inject fact 通道按话题召回闭合，零新召回路。**零新事件种类、零 schema/列、零 fold 改动、零新投影**。
  **验证**：新增 15 测试（MX-S1a–f / MX-S2a–e / MX-S3 / MX-S4a–b / MX-S5），全量 **1035/1035**；
  `npm run verify:memory-experience` 26 项对照全绿、**零真实模型调用**（真实注入 offer 带 taskId→
  accept→经验事实落库 verifier 可追溯→话题召回命中/无关不命中→重开库去重仍在→三库重建链逐字节不变）。
  设计文档 `设计和计划\PRTS-DESIGN-08-MEMORY-LEARNING-2026-11-11.md`（参考库审查：全库 29+11 仓
  无「外部验收结局×技能归因→可回忆语义事实」实现，自建；importance 0.5 不分档、factQuota 竞争、
  召回质量为待验证假设）。
  **生产注意**：上线初期经验事实为 0 是预期（历史 offered=0，不溯及）。

## H. 已闭环（本会话）

- [x] **时钟（§G2 ①）落地**（2026-11-10，方案 B 离屏自主）：`src\runtime\wake-clock.ts`
  + `start.ts` 接线 + K4 事件 `clock.fired`/`clock.stopped`。live 测试证明**模型真被调用**
  （不只是消息入队——`inbox.append` 不唤醒，只有 `agent.followup` 唤醒）。
  偏离计划：计划按 A 方案写的（复用活跃会话），博士选了 B（离屏自主），所以第 4 步
  「chat.ts 注册活跃 agent」整条取消，改为时钟自己 `agents.create`。

- [x] **模型后端切换**（`cc8a6b4` + 桌面端 `f654e59`）：侧栏「模型后端」磁贴 / 终端 `/model`，
  写 `<dataRoot>\model-profile.json`，`chat-serve` 启动时读并覆盖 env。
  **必须重启 serve 才生效**——provider id 硬编码 `deepseek-official`
  （`dsh-llm-deepseek-api-key\lib\index.js:47`），同进程注册两个会互相覆盖；
  上下文窗口也在启动期定（`config\prts.yml:20` + `start.ts:1027`）。
  端到端实测三种：strata → 「本地 Strata（256K）（窗口 262144）」、
  deepseek → 「官方（1M）（窗口 1000000）」、**没有 profile 文件 → 不接管**（保留手动 env）。
  ⚠️ Strata 的 256K 来自口述，`docs\v1-02-second-provider-strata-2026-11-05.md` 实测是 `32768`——
  以实测为准，profile 文件支持 `contextWindow` 覆盖，别把默认值当已知事实。

- [x] **桌面端二级页面读通道**（`e846f25` + 桌面仓 `c651b3b`）：所有者通道 `query` 协议实装
  （`owner-protocol` 词表 / `owner-query` 取数层 / `terminal-server` 旁路注入点 / `chat-serve`
  延迟绑定）。tasks / sessions / intents / memory / sandbox 五类；未知 `what` 回 `query.result`
  而不是 `error`（无 id 的 error 会让客户端永久停用查询）。回归 `test\runtime\terminal-pipe.test.ts` ⑩⑪。
- [x] **glob / grep + 写前必读**（`171824c`）：补 `dsh-tool-fs-search`（ripgrep）与
  `dsh-fs-observation-policy`。两个坑记在这里：① 只装 JS 时启动不报错、首次调用才失败，
  必须同时装 `@vscode/ripgrep-win32-x64`（optionalDependency）；② 写前必读的实际语义是「写成功
  也算已观察」，同一会话写完立刻覆盖是允许的，只有从未接触过的文件才被拒。回归
  `test\runtime\fs-tools.test.ts`（F1/F2，含 `disabled: true` 反证）。

- [x] **V1-05 接线段 live 测试**：`test/runtime/emotion-wiring.test.ts` 用真实 `startRuntime` +
  空脚本 LLM 制造 `agent/error`（`dsh-agent-loop` 的 `throwError()` emit，`:880`），断言
  EmotionStore 落盘「受挫」；E3 连续两轮失败 `revision` 仍为 1（节流是单实例，不是每轮新建）。
  反证：摘掉 `start.ts:1142` 的 `onReport` 两条即红。顺带修正此前误述——消费方是
  `ctx.events.on`（`error-report.ts:122`），不是 `emit`

- [x] **人格切换入口 `/persona`**：chat 侧此前零入口（`grep -c persona src\cli\chat.ts` = 0），库层 `switchTo` 早已存在；现加查看/切换命令，切换后显式提示重启（`renderPrefix` 只在启动装配）；V1-03 的前置由此解除

- [x] **「模型永不绑定」收紧到库层**：`MODEL_OPS` 删掉 `bindSession`（`ledger.ts:121`），model 调用抛 `FORBIDDEN`；补库层负向断言（`test/ledger/task-binding.test.ts`，先红后绿）；owner 通道不受影响

- [x] **沙箱三档 `/sandbox view|edit|full`**：confine → runner `--mode` → appcontainer 授 RX / RX,W，fs 侧守卫拒写删；`prts-chat.cmd` 切 `appcontainer`（`55339e9`）
- [x] **工具活动推送 M3**：`attachToolFeed` 把 tools/execute·result 翻成 `type:'tool'` 推给客户端（`77d1307`）；README 修正 local 后端档位语义（`109c1f9`）
- [x] 全量 **843 pass / 0 fail**（2026-11-06 实测，49.8s），`tsc -p .` exit=0

- [x] V1-14 4 项 / V1-06 3 项 / V1-15 2 项 / V1-09 7 项 → `scripts/verify-v1-acceptance.mjs` **16 项全 PASS**（`51e0c72`、`2223c36`）
- [x] **V1-06 真实链路**：10 条对话 turn → `consolidateFacts` → 重启后 ≥9 可检索；含反证（stub 返回空则测试红）与解析失败不污染（`6ae72da`）
- [x] **V1-05 系统侧生产者**：轮次失败 → 自动写「受挫」（system 通道、10 分钟节流、写失败不冒泡）（`ea23bcf`）
- [x] V1-17 回归守卫 `npm run verify:memory`（`bb7e340`）
- [x] V1-02 五项（`165a862`）、V1-01 三项（`60b58b1`、`1a13e0d`）
- [x] 回合超时可配 + 空回复不静默（`90dff61`）；启动报错指名插件（`2d64782`）
- [x] V1-16 装配延迟 p95 1610→815ms（`a1ab651`）；V1-12 导出导入（`53b1e20`）
- [x] 向量重排否决（45.0%→40.0%，`26aa48a`）；S10 根因定位（`3fd8ac7`）

## I. 工具链事实（DSH 升级必读）

2026-11-06 从 `0.2.1-rc.2` 升到 `0.2.2-rc.1` 实测出的三条，下次升级会重踩：

1. **cordis 生态必须同升**：dsh 全线要求 `cordis@~4.1.0`，而旧的
   `cordis-plugin-include@1.0.10` / `cordis-plugin-timer@1.1.7` 要 `~4.0.5`。
   实测同升到 include `1.1.0` + timer `1.2.0` 才解冲突（cordis 4.1.0 与
   loader 1.1.0 随传递依赖上来）。
2. **tool executor 被拆成独立 provider**：0.2.1 里它是 `dsh-tools` 的隐式部分，
   0.2.2 缺它则**启动不报错**、跑第一个真实回合才以 `TOOL_EXECUTOR_UNAVAILABLE`
   失败（第一次全量 46 个测试全红、3 次完全一致）。`config\prts.yml` 的 `tools`
   之后必须装配 `@deepseek-ai/dsh-tool-executor-native`（PTC 走 `run_code`，PRTS 不用）。
3. **旧 lock 与已装 node_modules 会挡住解析**：npm 拿 lock 里的旧树当基线，
   `npm install` 与 `--package-lock-only` 都会报 peer 冲突。必须把旧 lock 与
   node_modules 移开，从 `package.json` 全新解析。

升级后的验证基线：全量 **848 pass / 0 fail × 3**、`tsc` exit 0、不带 `--force`
的 `npm install` 也 exit 0（新 lock 自洽）。
