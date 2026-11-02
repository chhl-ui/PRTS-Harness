# 记忆模块路线方案（2026-11-02）

基于本会话在真机库（246,607 turn）上的实测数据，对照 2026 年的前沿做法，给出下一步该做什么、
不该做什么，以及每条判据。

**外部资料仅作对照**：arxiv 直连被本机代理的 fake-IP 拦截（198.18.0.44），论文只读到检索摘要，
未读全文。凡引用外部结论都标了来源，且不作为本仓决策的唯一依据。

---

## 一、外部前沿（2026）

| 工作 | 核心机制 | 来源 |
|---|---|---|
| Human-Inspired Memory Architecture for LLM Agents | 六种认知机制：sleep-phase consolidation、interference-based forgetting、engram maturation、reconsolidation upon retrieval、entity knowledge graph、hybrid multi-cue retrieval | arXiv 2605.08538（摘要） |
| HIPPOCAMPUS（MLSys 2026） | 用紧凑二进制签名做语义搜索 + 无损 token-ID 流重建原文，绕开稠密向量的延迟与存储成本 | MLSys 2026 |
| AgeMem（ACL 2026） | 把记忆操作（存/取/更新/摘要/丢弃）暴露为工具动作，由 agent 策略自主决定 | ACL 2026 long.981 |
| MAGMA（ACL 2026） | 每条记忆同时挂在语义/时间/因果/实体四张图上，检索是策略引导的图遍历 | ACL 2026 long.1709 |
| LongMemEval (V2) | 把记忆设计拆成**索引 / 检索 / 阅读**三阶段；V2 转向 Web Agent 的长期环境经验 | long-mem-eval 站点、LongMemEval-V2 |

共同点很清楚：**没有一家把赌注押在「更好的向量」上**。都在做三件事——
(1) 写时结构化（索引阶段），(2) 多路/多图融合（检索阶段），(3) 把证据组织成可读上下文（阅读阶段）。

## 二、PRTS 对照：六机制与三阶段

| 机制 | PRTS 现状 | 证据 |
|---|---|---|
| sleep-phase consolidation | ✅ 规则 + 模型两套 | `consolidateRules` / `consolidateProfiles`，真机跑通 |
| interference-based forgetting | ✅ 退役 + 衰减 | `retireFacts` / `decayedImportance`，11 个单测 |
| entity knowledge graph | ✅ 153,304 实体 / 1,098,122 边 | 真机计数 |
| hybrid multi-cue retrieval | ✅ **已接生产**（2026-11-02，`PRTS_EMBED=1`） | 注入/召回工具走 `search({queryVector, semanticWeight:0.5})`，调度器空闲补 turn 向量；benchmark 级判据（@8/temporal）未复测 |
| engram maturation | ❌ 无 | 新记忆与旧记忆同等对待 |
| reconsolidation upon retrieval | ⚠️ 只有计数强化 | `reinforceFacts` 改 access_count，不改写内容 |

| 阶段 | PRTS 现状 |
|---|---|
| 索引 | ✅ 有（规则实体、画像、摘要、生命周期的 chunk 化= turn 原样） |
| 检索 | ✅ 混合路已上生产（opt-in `PRTS_EMBED=1`，Ollama 探活门控，失败降级纯 bm25） |
| **阅读** | ❌ **几乎没有**：注入 5 条原始 turn，不做时间线/实体卡片/冲突消解 |

## 三、实测数据支撑的判断（本会话产出）

| 事实 | 数字 | 结论 |
|---|---|---|
| bm25 recall@8 | 31.8% | 单路天花板 |
| 向量（bge-m3）recall@8 | 30.5% | 不比 bm25 好，**不是模型问题** |
| 混合（等权 RRF）recall@8 | **34.7%** | 两路互补，但只 +2.9pp |
| 混合 recall@32 | **55.5%**（bm25 44.9） | 候选池扩大是真实收益 |
| 分型：temporal | bm25 64.7 → 混合 52.9 | **简单融合有损**，不能直接上线 |
| 分型：preference | bm25 3.3 → 向量 @32 30.0 | 语义路是唯一解 |
| 词干化实验 | 题内 −1、全库 −2 | 负结果，已回滚 |
| 注入条数 5→20 | 12/20 → 12/20 | 不是瓶颈 |
| recency 权重 0/0.1/0.3 | 13/12/13 | 非单调，噪声内 |
| 注入链路 | 20/20 发生，真机模型用上记忆 | 通路已通 |

**已被数据排除的方向**：换 embedding 模型、加注入条数、调 recency 权重、词干化、画像路线（30 题 A10/B9/C11）。

## 四、方案

### P0：混合检索产品化（唯一有硬数据的改动）

- 做法：`search` 支持 turn 的语义路（`mem_vectors.owner_kind='turn'`），与 bm25 做**加权** RRF。
- 权重：bm25 : 向量 = 1.0 : 0.5 起步（等权会牺牲 temporal，实测 −11.8pp）。
- 判据：**@8 ≥ 34.7% 且 temporal ≥ 60%**。达不到就再加门控（含时间词的查询只走 bm25）。
- 成本：向量化 44 分钟 / 1.0 GB 已就绪；查询 +0.25 s；需处理 Ollama 不可用时的降级（退化为纯 bm25，不能报错）。
- 风险：内存常驻 1 GB；Ollama 的 embedding runner 连续跑 1–2 万条会崩（分片绕过）。

### P1：补「阅读」阶段（当前最大的结构性缺口）

现在只做「检索 top-k 原始 turn」，模型自己拼。LongMemEval 的三阶段框架里，PRTS 缺的是最后一段。
这也直接对应 `830ce83f` 那类失败：答案分散在多条 turn 里，top-5 只取到一条。

- 做法：注入前把命中按 session/实体聚合成「卡片」——同一实体的不同取值按时间排序，
  冲突时显式标「较早值 / 最新值」。
- 判据：multi-session 分型的 recall@8 从 27.2% 提升，且 knowledge-update 不再因旧值干扰掉分。
- 成本：纯本地拼接，无模型调用；改的是注入层的组织方式。

### P2：时间图（对应 recency 偏置的根因）

`6a1eabeb` 的失败是「新而无关」压过「旧而相关」。调 recency 权重已证明是噪声内无效，
说明问题不是权重而是**没有时间结构**。

- 做法：按实体维护 `(entity, value, valid_from)` 的时间线，检索时对同实体只保留最新值作为「当前态」，
  旧值降级为「历史态」。
- 判据：knowledge-update 分型 recall@8 回到题内口径水平（当前全库 1/3，题内 3/3）。
- 成本：需要一次数据迁移（从现有 turn 抽实体-值对），可复用 `extractEntities`。

### 不做清单

| 不做 | 理由 |
|---|---|
| 换 embedding 模型 | bge-m3 与 bm25 持平，短板在结构不在模型 |
| 继续调参（条数/权重） | 三组实验全部落在噪声带内 |
| 复活画像路线 | 30 题全量 A10/B9/C11，画像单独无增益 |
| 扩散激活 | −31.2pp，已否决 |
| engram maturation | 有论文依据，但 PRTS 连「检索」都还没做扎实，加成熟度曲线属于过早优化 |

## 五、如果只做一件事

**P0 的加权混合**。它是唯一有实测支撑、成本已付、判据可判的改动；而且它能把 recall@32 从
44.9% 拉到 55.5%——候选池扩大对「阅读阶段」（P1）也是前置条件：池子里没有证据，再怎么组织上下文也没用。

---

## 七、读了论文正文后的修正（2026-11-02 追加）

arxiv HTML 版可直连（`arxiv.org/html/2605.08538v1`，curl 抓取），以下是直接影响方案排序的三条。

### 事实一：在 M-tier 规模上，记忆系统与「全塞上下文」打平

论文自称首次做 LongMemEval **streaming M-tier**（475 sessions / ~540K turns）：
200K token 预算下，他们的管线 **70.1%** vs 原始检索 **71.2%**（95% CI 重叠）。

PRTS 用的正是同规模数据集（`longmemeval_s_cleaned.json`，246k turn 库）。
这条意味着：**在这个规模上，「记得更准」不是记忆系统的卖点，「用更少上下文达到同等准确」才是**
（论文同时报 58% 存储缩减）。如果 PRTS 的目标是提高答对率，需要正视这条外部证据。

### 事实二：`+13.3pp preference` 来自「去重式巩固」，而且只在 S-tier 成立

论文的 S-tier（50 sessions）消融显示去重巩固让 preference recall +13.3pp；M-tier 上这个
收益没有重现。去重巩固的具体做法是：巩固时做**时序验证**（乱序 / 重复 / 因果倒置 → 隔离 15 分钟，
防「agent déjà vu」）+ **合并冗余痕迹** + 转成语义摘要入图。

PRTS 的对照：**完全没有去重/合并这一层**，246k 条 turn 原样堆积，每条独立参与检索。
这正是 preference 只有 3.3% 的结构性原因之一——同一事实被多轮对话反复陈述，散在几十条 turn 里，
每条都只命中一点。

### 事实三：两个机制 PRTS 现在做不了，也不该现在做

- **engram maturation**：论文自己也说需要「数周内反复检索」才能激活，LongMemEval 的结构里不存在这种条件。
- **reconsolidation**：需要跨会话矛盾才会触发，同样不在基准构造里。

论文承认这两个只是「implemented for operational completeness」。PRTS 没有对应的真实使用场景，
现在做就是纯负债。

### 修正后的优先级

| 新序 | 事项 | 依据 | 判据 |
|---|---|---|---|
| **P0** | **会话级去重合并**（把同一 session 内重复陈述的同一事实合成一条语义记忆，保留来源 turn） | 论文 S-tier +13.3pp preference，且 PRTS 的 preference 是 3.3% | 题内口径（≈480 turn/题，接近 S-tier 规模）preference recall@8 从 10%（向量）/3.3%（bm25）提升 ≥5pp |
| P1 | 加权混合检索 | 本仓实测 @32 +10.6pp，但 temporal −11.8pp 要修 | @8 ≥ 34.7% 且 temporal ≥ 60% |
| P2 | 时间图（同实体只留最新值为「当前态」） | `6a1eabeb` 的 recency 偏置诊断 | knowledge-update 分型回到题内水平 |
| 不做 | engram 成熟、reconsolidation 窗口 | 论文自述需「数周重复检索」「跨会话矛盾」，基准里没有 | — |

**为什么把去重提到 P0**：它是唯一有外部证据 + PRTS 恰好完全缺失 + 能解释 preference 3.3% 的机制。
混合检索虽然本仓实测有效，但它只提高「候选池里有没有」，去重提高的是「同一事实的多个碎片能否被合成一条可用证据」——
后者对 preference 和 multi-session 都是前置。

### 验证成本的现实约束

论文 S-tier 是 50 sessions；PRTS 的**题内口径**（每题约 480 turn）规模接近，可以低成本先验：
一次题内召回 + 判分约 2 分钟，不需要再向量化。
如果题内不成立，全库更不会成立（全库已有 246k 干扰）。

---

## 八、P0 探针结果：负结果，且我对论文机制的读法是错的

按第七节的 P0 做了探针（`.rivet/scratch/probe-dedup-merge.mjs`）：同 session 内
token Jaccard ≥ 0.4 的 turn 合并成一条，腾出的名额由后续命中回填。

| 组 | 可答对（20 题，题内口径） |
|---|---|
| 原样 top-5 | 12/20 |
| 合并 top-5 | **11/20（−1 题）** |

**更要紧的是触发率**：20 题里 **17 题根本没发生合并**（5 条仍来自 5 条）。只有 3 题合并，
其中唯一合并强度大的 `7161e7e2`（10 条→5 条）反而从 Y 变 n——合并后文本被截断，信息丢了。

### 这否定了什么

**LongMemEval 的 session 内几乎没有近重复 turn。** 题目共享的 haystack 是精心构造的多话题对话，
同一 session 里不会把同一句偏好说三遍。所以「同 session 文本合并」这类做法在这份数据上无所施其技——
不是实现不好，是前提不成立。

### 论文的「去重式巩固」不是文本合并

重读原文：*"Promoted events are transformed into **semantic summaries via LLM-generated gists and
clustering**, then integrated into the knowledge graph"*。它做的是**用 LLM 把一批事件提炼成语义摘要**，
不是把相似句子拼在一起。我在 P0 里做的是后者，形态就不对。

### 这个机制在 PRTS 里其实已经有了

`mem_summaries` + `putSummary` + `writeSummary` 就是 LLM 生成的语义摘要层，`search` 里也有
`summaryQuota` 开关——**只是默认 0（关闭），且真机 `summaries = 0`**。

所以正确的 P0 不是「新写一个去重合并」，而是**启用已有的摘要层并测量它**。
但要先算成本：真实库 246k turn / 约 10 turn 每 session ≈ 24k 个 session，
本地 27B 每个约 4 秒 → **约 27 小时**。题内口径验证（20 题 × 48 session）约 1 小时。

### 结论

| 判断 | 依据 |
|---|---|
| 同 session 文本合并：**否决** | 触发率 15%，净 −1 题 |
| LLM 摘要层：**未验证，但形态与论文一致** | PRTS 已有实现，默认关闭 |
| 摘要层的成本：高 | 全库约 27 小时本地推理 |
| 建议顺序 | 先题内验证摘要层（1 小时），再谈全库 |

## 六、口径警告

外部系统在 LongMemEval 上报的多是 **QA accuracy**（强模型阅读 + 判分），本仓的 31.8%/34.7%
是**检索层 recall@8**。两者不可直接比较——要对外对标，必须先把 PRTS 的阅读阶段补齐，
再在同一口径下跑 QA accuracy。
