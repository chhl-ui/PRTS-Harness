# 记忆与上下文：参考实现对账（2026-11-01）

## 这份文档回答什么

架构需求 §5.3 定义了记忆与上下文的一套结构：八种存储 + 五项过程（原文见
`docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §5.3）。
`C:\Users\Administrator\Desktop\参考库\` 里已有三个记忆类条目。本文回答三件事：

1. 它们各自覆盖了 §5.3 的哪几格；
2. PRTS 能从中拿到什么，按「复用 / 适配 / 借鉴设计 / 自建」四选一给出结论与理由；
3. 剩下哪几格没人做过，必须自建。

## 方法与证据纪律

对账清单固定为 §5.3 的十三项（八格存储 + 五项过程），判定三态：**有 / 部分 / 无**。
每条判定要落到实现文件；README 声称不算证据（`docs/external-reference-research.md` 的引用纪律）。

本文的 file:line 分两类，引用前先看标记：

- **[实测]**——写作本文时直接读代码确认，行号对应 2026-11-01 归档副本的 HEAD。
- **[探查]**——来自只读代码探查，未逐条复核。按引用纪律，采纳前自行到代码核实。行号会随上游提交漂移，**符号名与 grep 才是锚点**，行号只作快照。

「无」类判定经全仓 grep 与目录遍历；用到的检索词写在该条后面，便于复跑。
「文档没提」不构成「没做」的证据，所以「无」一律以 grep 零命中或结构缺失为准。

## 一、对账表：八格存储

| §5.3 要求 | hindsight | mempalace | 证据要点 |
|---|---|---|---|
| **事件日志**：一切原始事件只追加不可变，派生记忆都能追溯回这里 | 部分 | 部分 | h: 原文确实存在两处——`documents.original_text` **[实测]** `models.py:107,111`，与独立的 `chunks` 表（建表在迁移 `alembic/versions/b7c4d8e9f1a2_add_chunks_table.py`，读写在 `engine/retain/chunk_storage.py`）。但不满足「只追加不可变」：增量 retain 删 chunk 会级联删其事实 **[探查]** `chunk_storage.py:47-62`，且 `document_history` 只存 id 与计数不存文本、受 `OPERATION_RETENTION_DAYS` 限制 **[探查]** `engine/document_history.py:1-14`。m: WAL 与 drawer_revisions 是追加式 jsonl，但 WAL 主动脱敏 content 类键 **[探查]** `wal.py:29-31`，抽屉本身可更新/删除 |
| **情景记忆**：经历片段，原话与摘要两种粒度 | **有** | 部分 | h: 逐字粒度在 `chunks`；摘要粒度由 `memory_units.fact_type` 承载，取值受 CHECK 约束为 `world` / `experience` / `observation` **[实测]** `models.py:146,170`（`experience` 即 agent 做过的事与经历）；`observation` 由 consolidation 生成 **[探查]** `engine/consolidation/consolidator.py:1-15`。m: 原话按 exchange 成块 **[探查]** `convo_miner.py:1063-1075`；「摘要」只是索引层 200 字指针行，无独立情景摘要条目 **[探查]** `closet_llm.py:245-248` |
| **语义事实**：事实/偏好/项目知识；**区分明说与推断**；**有效时间与记录时间分开**；**冲突保留不静默覆盖** | 部分 | 部分 | 双时间两家都有：h `occurred_start`/`occurred_end`/`mentioned_at`/`created_at` **[实测]** `models.py:141-151`；m `valid_from`/`valid_to`/`extracted_at` **[探查]** `knowledge_graph.py:353-365`。冲突：h 淘汰旧 observation 只留 history **[探查]** `consolidator.py:3371`，m 有 `invalidate`/`supersede` 保留历史 **[探查]** `tool_capabilities.py:38-39`——**都不是「保留双方」**。**「明说 vs 推断」两家都没有字段**：h 的 `memory_units` 无 provenance 列 **[实测]**，m 的 `asserted_by`/`speaker` 缺失 **[探查]** |
| **关系记忆**：按人格/关系主体分开 | **无** | 有 | h: `relationship_state` 全仓 grep 0 命中 **[实测]**；最近的只有 `banks.disposition`（同一 bank 的固定人格参数）**[探查]** `models.py:331-344`。m: wing 是人与项目的作用域，每个 agent 有自己的 wing 与日记 **[探查]** `tools_diary.py:9`、`tools_read.py:466-478` |
| **技能与经验**：做法/教训/反例；**候选与启用分开，经评估采用** | **无** | **无** | h: 曾有 `learnings` 表，新知识架构迁移里 `DROP TABLE IF EXISTS learnings CASCADE` **[探查]** `alembic/versions/p1k2l3m4n5o6_new_knowledge_architecture.py:8,43-44`；全仓 grep `CREATE TABLE.*learnings` 命中 2 处，均在 alembic 迁移文件中，当前 `models.py` 的七张表里无 learnings **[实测 grep 计数 + 实测表清单]**。m: 全包 grep `skill\|procedure\|playbook\|lesson_learned` 只命中词表与 Claude skill 说明文本 **[探查]** |
| **意图库**（前瞻记忆）：将来要做的事 + 触发条件；触发/完成/取消有记录；不参与遗忘 | **无** | **无** | h: 抽取提示词把 `Goals, plans, or future intentions` 列进排除清单 **[探查]** `config.py:2262`；`refresh_cron` 是定期重建文档的调度器，不是意图存储 **[探查]** `mcp_tools.py:119-134`。m: grep `prospective\|reminder\|trigger_condition\|future_intent` 只命中 i18n 停用词与注入文本过滤 **[探查]** |
| **主题目录**（元记忆）：「我记得哪些主题、各多少条、最近一次何时」；可常驻；体积有上限 | 部分 | 部分 | h: knowledge pages 按主题存 name/description/summary，有独立索引并可 cron 刷新 **[探查]** `engine/response_models.py:690-724`——但那记的是「这个主题的内容」，不是「我记得哪些主题」的目录 **[探查]** `bank_stats_cache.py:1-8` 自述统计是近似值、只喂 UI。m: `tool_list_wings` 返回 total_drawers/wings/rooms 可随唤醒常驻 **[探查]** `tools_read.py:35-41`；**无「最近一次何时」**；体积上限只在单条 closet（1500 字符）**[探查]** `palace/closets.py:6` |
| **关联图**：实体/事件/主题间联系；检索时扩散激活；第一版可只做实体共现 | **有** | 部分 | h: `memory_links` 六种类型（temporal/semantic/entity/causes/caused_by/enables/prevents）+ `unit_entities` + `entity_cooccurrences`（注释即「Materialized cache of entity co-occurrences」）**[实测]** `models.py:238-329`；检索权重 0.3 激活 / 0.3 语义 / 0.25 时近 / 0.15 频次 **[探查]** `engine/search/trace.py:50-60`。m: hallways/tunnels + KG 三元组 + `palace_graph` 构图 **[探查]** `hallways.py:118-135`；**扩散激活的数学写好了但从未被调用**，`dynamics.py:13-16` 自述「nothing potentiates them on access and nothing decays them」**[探查]** |

## 二、对账表：五项过程

| §5.3 要求 | hindsight | mempalace | 证据要点 |
|---|---|---|---|
| **A 实时写入**：事件发生即写，不等会话结束 | 有 | 有 | h: retain 在请求内同步分块/抽取/写库，异步 worker 走同一批表 **[探查]** `engine/retain/orchestrator.py:1-6`、`worker/poller.py:70-73`。m: daemon 作业队列 + hooks 在 Stop/PreCompact/SessionEnd 触发（异步）**[探查]** `daemon.py:625-636`、`hooks_cli.py:1271` |
| **B 后台巩固**：提炼事实/更新关系/建关联/更新主题目录与重要性/生成技能候选；独立预算、可取消 | **有** | 部分 | h: consolidation 是系统心脏，「runs as a background job after retain operations complete」，带独立并发槽与墙钟上限、可取消（`raise_if_cancelled`）；测试密度印证（`tests/test_consolidation_*.py` 35 个文件）**[探查]** `engine/consolidation/consolidator.py:1-15`、`worker/poller.py:105`、`models.py:44-51`。m: 有后台队列与命令触发的重建，**无周期性提炼/更新重要性的巩固调度器**；KG 由工具显式写入而非后台抽取 **[探查]** `closet_llm.py:220`、`tools_kg.py:130` |
| **C 检索排序**：可见范围 → 时近/重要/相关/任务/扩散综合；读取独立判权 | 有 | 部分 | h: 四路召回（semantic/bm25/graph/temporal）+ 融合 + 重排 + recency/proof 加成，tags 做可见范围过滤 **[探查]** `engine/search/trace.py:117`、`fusion.py`、`recall_boost.py`、`graph_retrieval.py:57-59`。m: 向量+BM25 混合可配权重 + recency fallback，**重要性(★1-5)与图扩散不进排序公式** **[探查]** `searcher/ranking.py:85-103,170` |
| **D 重要性与遗忘**：降权 / 退役（默认不检索）/ 清除正文与派生；前两档可逆 | 部分 | 部分 | 两家都只有「可逆退役 + 硬删」两档，**都没有降权档与衰减函数**。h: `invalidate_memory`/`restore_memory` 保留原文以便还原 **[探查]** `engine/memories/base.py:2401-2420`；`memory_units` 无 importance 列 **[实测]**。m: `invalidate` 设 valid_to 可逆 **[探查]** `knowledge_graph.py:555`；`STRENGTH_FLOOR` 的衰减注释在，但 `dynamics.py` 自述未接线 **[探查]** |
| **E 主动回忆 + 用户控制权**：频率受控地主动提起；可查看/纠正/删除，删除覆盖索引与派生 | 部分 | 有 | h: 用户控制全有（invalidate/restore、删除、文档变更历史、retraction 重写知识页）**[探查]** `engine/memories/base.py:2401-2420`、`engine/reflect/retractions.py:1-20`；**主动回忆 0 命中**（grep `proactive` 只命中 OAuth 预刷新）**[探查]**。m: `PALACE_PROTOCOL` 强制「回答任何关于人或项目的问题前先查」**[探查]** `tools_read.py:431-439`；删除连带 purge closet 索引层与抽屉版本 **[探查]** `tools_write.py:1029-1042` |

## 三、逐家结论

### hindsight（vectorize-io/hindsight，MIT）——借鉴设计

**它做对了什么。** 它的核心不是 RAG，是**写时结构化**：retain 时把对话切块留原文，同时用 LLM 抽出句子级事实（what / when / where / who / why + 实体 + 因果），写成带双时间戳的行；后台 consolidation 把事实合成为带 `proof_count` 与 `source_memory_ids` 的 observation，冲突即淘汰旧 observation 并留 history；实体、类型化边、物化共现构成图，但图不是独立数据库，而是同一批行上的边。检索因此是对结构化事实库做四路召回后融合重排，chunk 只留作溯源。

这正好是 §5.3「事件流 + 后台巩固 + 工作区装配」那条路径已有的实现样本，也是 §5.3 里「刻意不学人类缺陷」第 1 条（回忆时改写记忆 → 原始事件不可变、巩固只生成带来源的派生条目）的直接对照。

**为什么不复用。** 存储前提不兼容，三条实测硬约束：

- `models.py` 用 `Vector(EMBEDDING_DIMENSION)`（pgvector）、`gen_random_uuid()`、`JSONB` —— **[实测]**
- `db_url.py:43` 注释明确拒绝非 PostgreSQL 输入（包括 sqlite）—— **[实测]**
- 它是 Python + PostgreSQL；PRTS 是 TypeScript + `node:sqlite`（架构需求 §4.4 第 4 条）

引入它的代价不是「加个依赖」，是加一个 PostgreSQL 服务到单机部署里。

**为什么是「借鉴设计」而不是「适配」。** 适配的前提是接口能嵌进现有架构、引入只需改几处。它的结构以 PG 的行/JSONB/pgvector 为地基，换 SQLite 等于重写存储层，那就不是适配了。

**可以借的四条**：写时结构化 + 后台巩固的两段式；observation 的 `proof_count`/`source_memory_ids` 溯源；图作为行上的边而非独立库；检索的四路召回融合。

### mempalace（MIT）——借鉴设计

**它的价值在分层索引与删除纪律，不在语义提炼。** wings（人/项目）→ rooms（每 wing 最多 12 个主题）→ drawers（原文块）→ closets（`topic|entities|→drawer_ids` 指针行）这套分层是 §5.3「主题目录 + 情景记忆」的一种落地形态；删除时连带清索引层与版本记录，正对 §5.3「删除要覆盖检索索引与派生摘要」。

**它的 README 有一处实质冲突，必须记下。** README 写「stores your conversation history as verbatim text… It does not summarize, extract, or paraphrase」，但代码里存在三条 opt-in 的抽取/摘要路径：

- `general_extractor.py`（15976 字节）docstring 第一行即「Extract 5 types of memories from text. Types: DECISIONS / PREFERENCES / MILESTONES / PROBLEMS / EMOTIONAL」—— **[实测]**
- `closet_llm.py:87,245-248` 让 LLM 生成 2-3 句 summary 写进 closet 指针行 —— **[探查]**
- `llm_refine.py:1-2` 对正则检测出的实体做 LLM 精炼 —— **[探查]**

三条都需显式开启，所以「原文层 verbatim」成立；但「不做抽取」这个宣称本身不成立。这条正好是引用纪律的实例：README 与代码冲突时，报冲突，不选边。

**为什么不复用。** `pyproject.toml` 强制 `chromadb>=1.5.4,<2` **[实测]**，另有可插拔后端（milvus / pgvector / qdrant / rust_exact）**[探查]**。PRTS 要复用它就得带一个向量库运行时，与单进程 TypeScript 的部署假设冲突。

**可以借的三条**：wings/rooms 的分层作用域（对「两个人格 + 多个项目」的划分直接可用）；协议层强制「回答前先查」而不是靠提示词自律；删除连带清派生索引的实现方式。

### codebase-memory-mcp（MIT）——不适用

**它是代码库结构记忆，不是个人长期记忆。** 实测 `nodes` 表 DDL：

```
nodes(id, project, label, name, qualified_name, file_path, start_line, end_line, properties)
UNIQUE(project, qualified_name)
```

（`src/store/store.c:342-353` —— **[实测]**）

无自由文本列、无用户/主体列、无事实时间列。节点标签全部是代码/文档/基础设施结构类型（Function/Method/Class/Section/File/Module/Route…）**[探查]**。唯一可写自由文本的是每项目一份 ADR，硬上限 8000 字符、整篇替换 **[探查]**。时间维度只有元数据时间戳（indexed_at / mtime / observed 首末次），没有事实有效时间与事件时序 **[探查]**。冲突是 last-write-wins（`UNIQUE(project, qualified_name)` + upsert）**[实测 DDL]**。

**结论**：它填不了 §5.3 任何一格。保留在参考库的理由只在另一条线——如果 PRTS 将来需要「代码/项目知识」这类结构记忆（C02 个人知识库的代码维度），它有现成实现（纯 C、17 个 MCP 工具、162 语言）。但那不是 §5.3 的事。

## 四、零覆盖的四格

三家合起来，以下四格**没有任何实现可参考**。它们恰好是 PRTS 相对通用 agent 记忆系统的差异所在：

| 格 | §5.3 要求 | 对应验收 | 现状 |
|---|---|---|---|
| **关系记忆** | 每个人格与博士的共同经历和关系变化，按人格分开；供情感状态与主动回忆使用 | V1-05（情感状态 10 项至少 8 项得体）| mempalace 的 wing 分区最接近，但它的分区是「人/项目」不是「人格」 |
| **技能与经验** | 做事方法、教训、反例与失效条件；**候选与启用分开，经评估采用** | V1-09（至少 1 次「经验→候选→评估→采用」+ 1 次回退演练）| 两家都无；hindsight 曾有 learnings 表后删除 |
| **意图库** | 将来要做或提醒的事 + 触发条件；触发/完成/取消有记录；不参与自然遗忘 | V1-14（10 条意图全部按时触发、重启不丢、取消不再触发）| 两家都无；**架构需求 §9 的候选表里也没有对应条目** |
| **明说 vs 推断的 provenance** | 语义事实层必须区分博士明说与模型推断 | V1-15（元记忆：有的能找回、没有的如实说「没记录」）| 两家都无此字段。这不是一个模块，是**一个必须加在事实行上的列**——没有现成的可以抄 |

前两格按 §9 的候选表还有项目没拉（Letta/MemGPT 的分层与自主编辑、Generative Agents 的重要性与反思）。后两格在 §9 表里没有对应候选，只能自建。

## 五、下一步

**补拉三个，每个补一个明确缺口**，不要成批拉：

| 目标 | 补哪一格 | 理由 |
|---|---|---|
| Letta / MemGPT | 关系记忆 + 人格分层 | 两人格共享事实记忆、各有独立关系记忆与情感状态，这是 §5.1 + §5.3 的交界，只有分层 agent 记忆系统有这个结构 |
| Generative Agents（开源代码，非论文） | D 的降权档 + B 的巩固触发 | 重要性评分与反思机制的最小完整实现，代码量小、可与论文逐条对照 |
| Graphiti | 语义事实的冲突并存 | 双时间知识图谱，hindsight 淘汰旧 observation 的做法与 §5.3「冲突保留，不静默覆盖」冲突，Graphiti 是另一个方向的样本 |

**不拉，直接判自建**：意图库、provenance 列。它们没有合适参照，拉了也只能借形状。

**先冻结的**：StreamingLLM / KV 持久化 / 测试时学习（§5.3 已明确「不进入第一版」，解冻条件是 PRTS 稳定运行本地模型且有记忆基准可比较）。

## 附：与架构需求的对账

- 本文覆盖 §5.3 的十三项，未覆盖 §5.3 的「工作区装配（上下文）」部分——那属于 §5.3 后半段，另需一组对账（V1-08 长对话约束保持、V1-16 装配 P95 ≤ 1s、V1-18 宿主装配 vs 模型自管对比）。
- 本文未涉及 §5.4 进化的完整机制，只在「技能与经验」格侧面碰到（可进化对象之一是技能，但候选/启用分离的评估流程在 §5.4）。
- 架构需求 §9 记忆一行的候选，本文核实了 `hindsight`，未核实 `hermes` / `openviking` / `llama-index`（不在参考库）。
