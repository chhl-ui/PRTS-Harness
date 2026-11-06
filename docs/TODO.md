# PRTS 待办清单

> 详细判据与恢复命令见 `docs/PENDING-2026-11-05.md`。最后更新：2026-11-06（第二轮）

## 0. 初版范围变更

- **V1-11 语音移出初版**（2026-11-05 决定）：`src/` 里零音频代码（`tts|speech|audio|voice` 无一命中），
  判据「按键说话往返 / 播报可打断 / 打断不等于取消任务」没有实现基础。改为**后续作为插件单独做**。
  理由：语音是可选能力，不该拖住核心；它同时是 V1-01「可选功能插件化」的第一个真实用例。

## A. 实现 vs 验收（初版 18 项）

「实现」= 代码在且有调用方；「验收」= 有真实流程证据。两者不是一回事。

| 项 | 实现 | 验收 | 说明 |
|---|---|---|---|
| V1-01 插件机制 | ✅ | ✅ | 30+ DSH 插件；禁用仍启动；写错包名会指名（`d1253ec`） |
| V1-02 独立性 | ✅ | ✅ | 无常驻进程；对话/执行任务/读写记忆/第二提供方全实测 |
| V1-03 PRTS 人格 | ✅ | ❌ | 需博士盲评 20 段 + 5 道陷阱题（前置：切回 `prts` 预设） |
| V1-04 普瑞赛斯 | ✅ | ❌ | `priestess` 已激活，需博士盲评 20 段 |
| V1-05 情感 | ✅ | ✅（机制） | 系统侧生产者已补（`e46da94`）：轮次失败自动写「受挫」，10 分钟节流，写失败不拖垮上报；**接线段已有 live 测试**（`test/runtime/emotion-wiring.test.ts`，摘掉 `start.ts` 的 `onReport` 即红）；owner 入口 `prts emotion`；10 情境 9/10 有回复，**博士打分未做** |
| V1-06 记忆 | ✅ | ✅（链路） | 机制层 10/10；**真实链路已验**（`e86742c`）：10 条对话 turn → `consolidateFacts` → 重启后 ≥9 可检索，含反证（stub 返回空则测试红）。提炼**质量**（真模型抽得准不准）未验 |
| V1-07 主动回忆 | ✅ | ❌ | 7 天试用 ≥70% 恰当（需真实使用） |
| V1-08 上下文 | ✅ | ❌ | 超窗口 3 倍 + 跨天未完成事项（成本最高的自动化项） |
| V1-09 进化 | ✅ | ✅ | propose→evaluate→adopt→retire→restore + 人格核心守卫（验收脚本 7 项） |
| V1-10 干活 | ✅ | ❌ | 需 1 个日常 + 1 个科研真实成果（要真实任务） |
| **V1-11 语音** | ❌ **零代码** | ❌ | **已移出初版，见 §G** |
| V1-12 停止权与导出 | ✅ | ⚠️ | 导出导入 12 项核对过；**停机权未验**（等真实误报率） |
| V1-13 连续使用 | ✅ | ❌ | 7 个跨日周期（自动化部分已有，人工待） |
| V1-14 前瞻记忆 | ✅ | ✅ | 10 条意图/重启不丢/取消不触发（验收脚本 4 项） |
| V1-15 元记忆 | ✅ | ✅ | 5/5 找回 + 5 个无关查询各 0 命中（验收脚本 2 项） |
| V1-16 延迟与费用 | ✅ | ⚠️ | 延迟 p95 815ms ✅；**费用分账未端到端验** |
| V1-17 公开基准 | ✅ | ✅ | 基线 45.09%；`npm run verify:memory` 是硬门禁（下降即退出码 1） |
| V1-18 宿主 vs 自管 | ✅ | ❌ | 冻结（host 74/100、self 0/100） |

**小结**：V1-11 移出后，初版 17 项**全部有实现**；验收完成 **9 项**（+V1-05 机制）、部分 2 项（V1-12 停机权 / V1-16 费用）、待博士或外部条件 6 项。

## B. 等博士（判据是主观认定，无法代做）

- [ ] **V1-03 盲评**：20 段 ≥17 段「像 PRTS」+ 5 道陷阱题。**前置已解除**：`/persona prts` 可切换（2026-11-06 加入口），切换后需重启 `prts chat`；当前 active 仍是 `priestess`
- [ ] **V1-04 盲评**：20 段 ≥17 段「像普瑞赛斯」。`priestess` 已激活，正常使用即积累
- [ ] **V1-05 打分**：10 情境 ≥8 得体 + 事实不变项。材料 `C:/prts-benchmark/v1-05-scenarios.json`，
  摘要见 `docs/v1-05-scenario-run-2026-11-05.md`。S10 已定位为 `waitIdle` 120s 超时（实测 123470ms），非崩溃

## C. 可自动化，尚未做

- [ ] **appcontainer 三档端到端**：**confine 层已有真机证据**——`mode: 'read-only'` 下 pwsh 写工作区被 OS 拒（`test\sandbox\live-wiring.test.ts` 新增 pwsh 用例；pwsh 7.6.9 实测：版本可读、workspace-write 能写、越界写与读密钥 denied）。**未验**的是 `/sandbox view` → `sandbox/mode` 事件 → `sandboxPolicy.resolve` 回读这条端到端（命令本身有 fake ctx 单元覆盖）。原判据：起 `prts chat` 切 view 后让模型写文件，期望守卫拒绝且审计留痕
- [ ] **V1-08 上下文**：超模型窗口 3 倍仍答对开头 5 个约束；跨天新会话说出未完成事项（成本最高）
- [ ] **V1-06 的提炼质量**：链路已验（`e86742c`），但用的是 stub generator；真实模型抽得准不准未验
  （要真实模型 + 标注集，属 LongMemEval 的 fact 抽取范畴）

## D. 冻结

- [ ] **V1-18 扩样 100+**：NInfer 每 9–14 分钟 CUDA 崩溃。恢复：`scripts/v1-18-watchdog.sh` 续跑，或换 Strata 底座

## E. 可选决策

- [ ] **K2b 默认后端是否切 `appcontainer`**：代码默认仍是 `local`，但 `prts-chat.cmd` 已设 `PRTS_SANDBOX_BACKEND=appcontainer`（2026-11-06：部署层已切、代码默认未改）。待评估：性能（`live-wiring` 实测 895ms / 995ms）、icacls 非管理员环境的失败回退
- [ ] **`PRTS_STRICT_PLUGINS` 是否默认开**：现在默认只警告，设 1 才阻断启动
- [ ] **`.rivet/` 是否入库**：`knowledge/` `plans/` `meridian.db` 等工具产物目前 untracked
  （`.rivet/artifacts|cache|checkpoints|scratch` 已忽略）

## F. 需外部条件

- [ ] **V1-07** 7 天试用 / **V1-10** 真实任务 / **V1-13** 连续 7 日 / **V1-12** 停机权真实误报率
- [ ] **V1-16 费用分账**：7 天试用的模型费用 vs 巩固费用分开计量、不超冻结额度

## G. 后续插件（新增工作线）

- [ ] **语音插件（原 V1-11）**：按键说话往返、播报可打断、打断不取消任务。
  作为 V1-01 插件机制的首个真实用例——它能把「可选功能插件化」从判据变成实践

## H. 已闭环（本会话）

- [x] **模型后端切换**（`5cece79` + 桌面端 `f654e59`）：侧栏「模型后端」磁贴 / 终端 `/model`，
  写 `<dataRoot>\model-profile.json`，`chat-serve` 启动时读并覆盖 env。
  **必须重启 serve 才生效**——provider id 硬编码 `deepseek-official`
  （`dsh-llm-deepseek-api-key\lib\index.js:47`），同进程注册两个会互相覆盖；
  上下文窗口也在启动期定（`config\prts.yml:20` + `start.ts:1027`）。
  端到端实测三种：strata → 「本地 Strata（256K）（窗口 262144）」、
  deepseek → 「官方（1M）（窗口 1000000）」、**没有 profile 文件 → 不接管**（保留手动 env）。
  ⚠️ Strata 的 256K 来自口述，`docs\v1-02-second-provider-strata-2026-11-05.md` 实测是 `32768`——
  以实测为准，profile 文件支持 `contextWindow` 覆盖，别把默认值当已知事实。

- [x] **桌面端二级页面读通道**（`a39a545` + 桌面仓 `c651b3b`）：所有者通道 `query` 协议实装
  （`owner-protocol` 词表 / `owner-query` 取数层 / `terminal-server` 旁路注入点 / `chat-serve`
  延迟绑定）。tasks / sessions / intents / memory / sandbox 五类；未知 `what` 回 `query.result`
  而不是 `error`（无 id 的 error 会让客户端永久停用查询）。回归 `test\runtime\terminal-pipe.test.ts` ⑩⑪。
- [x] **glob / grep + 写前必读**（`9db6320`）：补 `dsh-tool-fs-search`（ripgrep）与
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

- [x] **沙箱三档 `/sandbox view|edit|full`**：confine → runner `--mode` → appcontainer 授 RX / RX,W，fs 侧守卫拒写删；`prts-chat.cmd` 切 `appcontainer`（`d3a7d80`）
- [x] **工具活动推送 M3**：`attachToolFeed` 把 tools/execute·result 翻成 `type:'tool'` 推给客户端（`6b85a61`）；README 修正 local 后端档位语义（`861f69d`）
- [x] 全量 **843 pass / 0 fail**（2026-11-06 实测，49.8s），`tsc -p .` exit=0

- [x] V1-14 4 项 / V1-06 3 项 / V1-15 2 项 / V1-09 7 项 → `scripts/verify-v1-acceptance.mjs` **16 项全 PASS**（`47ed24a`、`27a154e`）
- [x] **V1-06 真实链路**：10 条对话 turn → `consolidateFacts` → 重启后 ≥9 可检索；含反证（stub 返回空则测试红）与解析失败不污染（`e86742c`）
- [x] **V1-05 系统侧生产者**：轮次失败 → 自动写「受挫」（system 通道、10 分钟节流、写失败不冒泡）（`e46da94`）
- [x] V1-17 回归守卫 `npm run verify:memory`（`f6251b6`）
- [x] V1-02 五项（`21ce477`）、V1-01 三项（`d1253ec`、`5cd52e5`）
- [x] 回合超时可配 + 空回复不静默（`b847439`）；启动报错指名插件（`c7c1dc5`）
- [x] V1-16 装配延迟 p95 1610→815ms（`2d6a4e0`）；V1-12 导出导入（`f116399`）
- [x] 向量重排否决（45.0%→40.0%，`dc058a0`）；S10 根因定位（`eef25fe`）

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
