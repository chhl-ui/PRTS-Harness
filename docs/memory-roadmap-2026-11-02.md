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
| hybrid multi-cue retrieval | ⚠️ **仅离线验证** | 三路对比完成，产品 `search` 不对 turn 走向量路 |
| engram maturation | ❌ 无 | 新记忆与旧记忆同等对待 |
| reconsolidation upon retrieval | ⚠️ 只有计数强化 | `reinforceFacts` 改 access_count，不改写内容 |

| 阶段 | PRTS 现状 |
|---|---|
| 索引 | ✅ 有（规则实体、画像、摘要、生命周期的 chunk 化= turn 原样） |
| 检索 | ⚠️ 单路 bm25 上生产，混合只在离线验证 |
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

## 六、口径警告

外部系统在 LongMemEval 上报的多是 **QA accuracy**（强模型阅读 + 判分），本仓的 31.8%/34.7%
是**检索层 recall@8**。两者不可直接比较——要对外对标，必须先把 PRTS 的阅读阶段补齐，
再在同一口径下跑 QA accuracy。
