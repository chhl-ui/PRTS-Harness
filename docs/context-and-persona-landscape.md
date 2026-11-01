# 上下文装配与人格：参考实现对账（2026-11-01）

## 这份文档回答什么

`docs/memory-landscape.md` 覆盖了架构需求 §5.3 的存储与过程。本文补剩下两块：**§5.3 后半段的上下文装配**、**§5.1 的人格与情感**。同样回答三件事：参考库里做到什么程度、按四选一能拿什么、哪几格必须自建。

## 方法与证据纪律

判定三态：**有 / 部分 / 无**。每条落到实现文件或 URL。三类标记，引用前先看：

- **[实测]**——写作本文时直接读代码确认。
- **[探查]**——来自只读代码探查，未逐条复核。
- **[摘要级]**——来自 web 搜索摘要，**未读到页面正文**。本文出现的所有外部论文证据都是这一级（原因见文末「证据限制」），按引用纪律不能当实现依据用。

搜索范围：参考库 11 个条目全部按目录结构过了一遍，相关的读实现（逐条的排查记录在探查产出里）。本地没有的才走 web。

## 一、上下文装配：九条对账

| §5.3 要求 | 判定 | 证据 |
|---|---|---|
| **1 宿主确定性装配 + 模型主动回忆** | **有** | DSH 每步由宿主 assemble 系统提示词，经 `system-prompt/assemble` waterfall 让插件按序贡献段落，**同一步的重试复用同一份组装结果不再重装** **[探查]** `packages/core/agent-loop/tests/system-prompt-admission.spec.ts:301-320`。mempalace 是最小干净形态：`wake_up()` 固定拼 Layer0（身份 ~100 tok）+ Layer1（情景摘要），`recall()`/`search()` 作模型深挖入口 **[实测]** `layers.py:622,642` |
| **2 稳定性排序吃提示词缓存** | **有** | DSH 的 `SystemPromptProjection` 只在序列起点或提示词清空时重写 surface node 0；能力支持的连续序列把变化文本 append 到缓存历史之后；**同样文本不搬迁节点**（避免无意义的前缀变化）**[探查]** `packages/core/agent-loop/src/runtime-context.ts:63-113`。缺口：未取证到显式供应商缓存断点标记（`cache_control`/`ephemeral`）；`pi` 里的 `cacheRead`/`cacheWrite` 只做成本统计，不是装配依据 **[探查]** |
| **3 输入预算 `min(上限, 窗口−输出预留−安全余量)`** | **部分** | 三处各有一半，**没有一处实现完整公式**：DSH 有 `contextPressure()` 返回 `{pressureTokens, contextWindow}` 与字节预算 **[探查]** `packages/llm/token-meter/src/index.ts:122`；deer-flow 有 `input_budget`/`carry_budget` 二分裁剪 **[探查]** `summarization_middleware.py:559-586`；mempalace 只有字符硬上限（`MAX_CHARS=3200`，注释「~800 tokens」）**[实测]** `layers.py:343` |
| **4 压缩：先移低相关再压旧对话；**保留指向原文的引用**；**不对旧摘要反复摘要**** | **部分** | deer-flow 有可跑的压缩管线：读 checkpoint、拒绝压缩有 pending 执行的线程、生成摘要后以 `preserved_messages + summary_text` 覆盖写回 **[探查]** `runtime/context_compaction.py:146`。但**它正好踩了 §5.3 禁止的那条**——`previous_summary` 被带进摘要输入并占同一份 `trim_tokens_to_summarize` 预算，等于对旧摘要再摘要，只靠 carry 预算限长缓解 **[探查]** `summarization_middleware.py:674`。另：压缩后摘要能否指回原文 id 未取证到写入路径 |
| **5 工具结果卸载** | **有（完成度最高）** | 两个独立实现。DSH 的 spill seam：完整 content 存到会话私有目录（0700 根、`wx+0600` 写入），返回面向模型的 locator + `retrievalHint`（提示用 read/grep 回读）；超过 `maxInlineTokens` 时替换为 head/tail 片段 + 溢出地址；**保存失败时保留原始内联结果**而不是把成功的调用变成 isError **[探查]** `agent-code/20261029/repos/deepseek-harness/docs/subsystems/spill.md:90-92`（路径已核 **[实测]**）+ `spill-policy.spec.ts:166-233`。pi 的 durable 包同样落盘并用 `spillPath` 指路，测试覆盖「未超限不落盘」与「字节一个不漏流式写出」**[探查]** `pi/packages/durable/test/tools.test.ts:731,745` |
| **6 子任务在干净上下文执行，只交回结论与引用** | **部分** | 机制在场、强约束缺。DSH 子 agent 有独立会话与作用域上下文、失败可回滚 **[探查]** `agent-code/20261019/dsh-bundled/dsh-agent-loop/README.zh.md:110`；deer-flow 摘要中间件区分 `is_subagent` 与 `sandbox_lease_owner_id`，注释「Subagents sharing a parent thread still own separate executions」**[探查]** `summarization_middleware.py:560-575`。**没有任何项目强制「只交回结论与产物引用」** |
| **7 跨会话接续，不塞上一段完整聊天** | **有** | mempalace `wake_up` 正是该形态：只注入身份 + 从 palace 取高权/最近抽屉重组的摘要（~600-900 tok），历史对话不进上下文 **[实测]** `layers.py:642` + **[探查]** `:335-430`。deer-flow 用 checkpoint + `summary_text` 恢复线程而非回放全量消息 **[探查]** |
| **8 上下文清单：每轮记材料/版本/预算用量** | **部分** | DSH 记每步 surface/header 与 token 用量并注册投影 **[探查]** `token-meter/src/index.ts:96-125`、`src/projection.ts:36-38`。**没有取证到「材料 + 版本 + 逐项预算」这种能回答「她当时为什么这么说」的清单结构** |
| **9 可度量：装配 P95 ≤ 1s、50 轮后仍答开头 5 个约束、宿主装配 vs 模型自管 A/B** | **无** | 只有延迟统计零件：deer-flow 有 nearest-rank 百分位实现可用于基准 **[探查]** `backend/tests/test_bench_concurrency.py:79-128`；hindsight 有 recall 计时脚本。**三项 SLO/实验在任何项目里都没有** |

## 二、人格与情感：六条对账

| §5.1 要求 | 判定 | 证据 |
|---|---|---|
| **1 人格设定是数据不是写死提示词** | **部分** | 两个源码级实现。Tianshu-harness：**类型化数据表定义 16 个域人格**，字段含 `id/name/motto/volatileBlock/decisionStyle/courageThreshold/keywords/toolWhitelist/systemPromptSuffix/uiPersona` 等 **[实测]** `src/agent/star-domain-data.ts:24-59`（接口）、`:61`（`STAR_DOMAINS` 数据表）。hermes：YAML 配置，内置 13 个人格 + 用户按名覆盖，支持 `dict{system_prompt,tone,style}`，且**只有一条受控写路径** `persist_personality`（原子 round-trip、`0600`）**[探查]** `hermes_cli/personality.py:19,58,100,127`。**两者都没有版本化、没有「修改需博士确认」**（无内容版本号、无 diff/审批/回滚）|
| **2 多个人格共存、共享任务/工具/权限、各有独立设定与关系记忆** | **部分** | Tianshu 是本地最接近的：16 域共存可切换（`/domain` 显式 + 关键词路由 + 委派），**各域 `toolWhitelist` 逐字相同**—— **实测**：16 个数组去重后只剩 1 种（692 字符），域间差异只在 `volatileBlock`/`systemPromptSuffix`/`courageThreshold`/`decisionStyle`。这直接对应 V1-04「切换前后任务与权限不变」。**缺口：无 per 域独立的情感状态与关系记忆**（`StarDomain` 接口无任何状态字段）**[实测]**。hindsight 的 memory bank 提供另一形态的隔离先例（每 bank 独立记忆/实体/关系 + 可选 disposition，「completely isolated... no data leakage」）**[探查]** |
| **3 情感状态是持久化状态量、由事件更新、随时间回落、不影响事实** | **无** | 本地 11 个条目**零实现**。hermes 的 `derive_pet_state` 是纯函数（优先级 error→FAILED / celebrate→JUMP / … / IDLE），入参只有本次 turn 的布尔信号，**无持久字段**；`cli_init_mixin.py` 的 `_pet_event` 是会话内 mutable state **[探查]**。mempalace 只在写入时抽情绪标签；Open-LLM-VTuber 是情绪 tag→Live2D 表情的单轮映射 **[探查]**。hindsight 的 `disposition`（skepticism/literalism/empathy 各 1–5 分）是**静态特质**，不成曲线、不回落 **[探查]** |
| **4 状态维度与更新规则** | **理论有、实现无；参数可直接照** | Sentipolis 已拿到正文（**[正文]** arXiv 2601.18027v2, 2026-04-21）：PAD 三维各维取值 `[−1, 1]`；**半衰期 120 分钟**的指数衰减 `s(t+Δt) = s(t)·2^(−Δt/T½)`；双速更新（快＝会话轮次级，慢＝ reflection 期整合检索历史，依据 EMA 的 appraisal/inference 之分）；**不把裸数值交给 LLM**，而是 KNN 到真实人类 PAD 数据点映射成 Plutchik 情绪标签再注入 prompt。另：OCC 评估式情绪生成（per-emotion 强度衰减）仍未取到正文 |
| **5 事实规则高于角色表演** | **部分** | hindsight 的 reflect 是好的工程形态：`directives`（硬规则）压制 `disposition`，答案必须基于实际检索到的记忆**且逐条校验引用 ID**（只允许引用真正检索到的），guardrail 禁止空答复 **[探查]** `skills/hindsight-docs/references/developer/reflect.md:40,193`。Tianshu 把证据纪律写进人格文本（「把未读实现的推断当事实写进方案，会把错误传染给下游」）——**但那是提示词自觉，不是代码强制** **[实测]** `star-domain-data.ts` 的天枢 `systemPromptSuffix` |
| **6 人格隔离的工程质量：不持有权限、卸载不影响他人格、版本化与回滚** | **部分** | 隔离有先例：hindsight bank 无数据泄漏 **[探查]**；DSH 把 persona 做成 preset 级可插拔插件、可 disable **[探查]** `dsh-superagent-prototype/cordis.patch.yml:28,123`；hermes 单写路径 + `0600` **[探查]**。**「人格设定的版本化和回滚」在 11 个条目中零实现** |

## 三、结论：两块都是「借鉴设计」，没有可复用的

| 目标 | 四选一 | 理由 |
|---|---|---|
| 上下文装配 | **借鉴设计** | 单点机制成熟（工具结果卸载有两个独立实现），但没有任何一个项目把九条做全；DSH 是 TypeScript 但在 DSH 生态内、依赖 Cordis 的 waterfall，不能直接嵌 |
| 人格设定与切换 | **借鉴 + 一处可评估「适配」** | Tianshu-harness 是**同语言 TypeScript**、字段模型与 §5.1 逐条对得上（结构化数据表 + 全域共享白名单 + 差异只在提示词块），是这轮唯一值得正式评估「适配」的候选。但要先确认它与 PRTS 的插件/配置体系能否共存 |
| 情感状态量 | **自建，但参数已可照** | 零实现。Sentipolis 正文已到手，维度（PAD）、范围（[-1,1]）、回落速率（半衰期 120 分钟）、更新节奏（双速）都有明确取值；需自建的是与 PRTS 账本、人格版本化的接合 |

## 四、三条最值得拿的机制

**一、工具结果卸载（DSH spill）。** PRTS 现在**完全没有这一层**——模型 shell 的输出、文件读取的大块内容直接进上下文。它的做法可以整段照搬：完整内容落会话私有目录（0700 根 + `wx` 独占创建），上下文里只放 locator + 提示「用 read/grep 回读」，超阈值换 head/tail，**保存失败时保留原始内联结果**（这条最关键：不能因为卸载失败把一次成功调用变成错误）。

**二、宿主装配 + 前缀冻结（DSH SystemPromptProjection）。** 对应 §5.3「装配顺序按稳定程度排列，以提高提示词缓存命中率」。它的实现要点是「同样文本不搬迁节点」——变化的内容 append 到缓存历史之后，冻结的前缀不动。这条在 PRTS 现在的 `chat.ts` 里没有对应物。

**三、全域共享白名单（Tianshu StarDomain）。** 「16 个域、白名单逐字相同、差异只在提示词块」正是 V1-04 要验的东西。它是**已经跑起来的东西**，不是设计稿——比任何论文都可靠。

## 五、必须自建的两格

- **情感状态量**（持久化 / 事件更新 / 时间回落 / 不影响事实）：本地零实现，外部只有理论。这是 §5.1 的核心，也是最没有现成参照的一块。
- **人格设定的版本化与回滚**：11 个条目零实现。PRTS 有 K1 账本的哈希链，这块可以长在自己的账本上，不需要外面借鉴。

## 附：证据限制（必须记下）

这些结论取证时有两条路径：`web_fetch` 被本机代理的 fake-IP 拦截（`aclanthology.org` / `arxiv.deeppaper.ai` / `airi.moeru.ai` 解析到 `198.18.0.x`），但 **`curl` 直连不受影响**。Sentipolis 因此拿到了正文；其余仍未取到。因此：

- **已解决**：Sentipolis 正文已下载（`arxiv.org/html/2601.18027` 全文 + PDF），PAD 维度范围、半衰期 120 分钟、双速更新、语义富集管线均已核实，证据等级从 [摘要级] 升为 **[正文]**。
- **仍未解决**：OCC 的 per-emotion 衰减系数（Springer 章节未取）、SillyTavern CCv3 的 `version` 字段语义（只到摘要）、AIRI（站点被 fake-IP 拦截）。这三项不影响情感状态量动工；写人格设定的版本化时要另行取证。
- 方法结论：`web_fetch` 工具被代理 fake-IP 拦截时，`curl` 直连是最短的解法——下次遇到“摘要级”阻塞先试它，不要直接判定为不可取。

本地四项关键断言已回代码核实：Tianshu `StarDomain` 接口字段与 16 域 **[实测]**、16 个 `toolWhitelist` 去重后 1 种（692 字符）**[实测]**、mempalace `Layer0`/`Layer1`/`MemoryStack`/`MAX_DRAWERS=15`/`MAX_CHARS=3200` **[实测]**、DSH `spill.md` 与 hermes `personality.py` 路径存在 **[实测]**。探查给的一条路径需修正：DSH spill 文档在 `agent-code/20261029/repos/deepseek-harness/docs/subsystems/spill.md`，不是 `agent-code/20261029/docs/...`。
