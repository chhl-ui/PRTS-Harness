# Graphiti / HippoRAG 对账（2026-11-02）

承接 `memory-landscape.md`（2026-11-01）末尾的「下一批该看谁」。那篇列了三家候选：
Letta/MemGPT（关系记忆 + 人格分层）、Generative Agents（重要性评分与反思）、Graphiti（语义事实的冲突并存）。
本篇先把 **Graphiti** 与 **HippoRAG** 拉下来逐格对了一遍——它们分别对着我们两条未决的事：
P2 的时间图，和被否掉的扩散激活。

**归档位置**：`C:\Users\Administrator\Desktop\参考库\graphiti`（graphiti_core，Python，31 MB）、
`C:\Users\Administrator\Desktop\参考库\HippoRAG`（114 MB）。均 `--depth 1` 克隆，未固定 commit。

---

## 一、结论先给

| 项目 | 能不能复用 | 给我们什么 |
|---|---|---|
| **Graphiti** | **不能**——硬依赖图数据库（`neo4j>=5.26.0`，另有 falkordb/kuzu/neptune driver），我们是 SQLite 单文件 | **P2 时间图的现成语义**：新事实到来时把旧边的 `invalid_at` 设为新边的 `valid_at` 并保留旧边，不是删除、不是覆盖 |
| **HippoRAG** | **不能**——igraph 内存图 + 向量库；且它的图是 OpenIE 三元组二部图，我们的图是实体共现图 | **扩散激活的另一种数学形态**：无向投影上的 Personalized PageRank（damping 0.5），而不是把邻居分数加权求和。我们 −31.2pp 的否决不覆盖这个形态 |

两家都只能「借鉴设计、不复用代码」——与 hindsight / mempalace 的结论同类，但理由不同：
前两家是 Postgres 依赖，Graphiti 是图数据库依赖，HippoRAG 是内存图结构不匹配。

## 二、Graphiti：时间失效的真实做法

### 做对了什么

它不是「删除旧值」，也不是「保留双方」，而是**给旧边打失效标记并保留**。
`resolve_edge_contradictions`（`graphiti_core/utils/maintenance/edge_operations.py:748-786`）的逻辑：

```
新边合法 → 若 旧边.valid_at < 新边.valid_at（且区间不重叠）：
    edge.invalid_at = resolved_edge.valid_at   // 旧边失效时刻 = 新边生效时刻
    edge.expired_at = utc_now()                 // 系统标记时刻
    旧边进入 invalidated_edges，不删除
```

两个时间分开：`valid_at` / `invalid_at` 是**事实在世界上有效的时间**，`created_at` / `expired_at` 是**系统记录的时间**。
这就是双时间（bitemporal），也是我们 §5.3 里「有效时间与记录时间分开」那条的落地形态。

时间从哪来：`_extract_edge_timestamps`（同文件 `:789` 起）用一次轻量 LLM 调用抽 `valid_at`/`invalid_at`；
另有正则兜底 `temporal_edge_utils.py:33`，匹配 `until|through|expires|ended|ends|ending` 这类词。

检索侧：`search_config.py` 里三路可选 `cosine_similarity` / `breadth_first_search` / `rnk`，
重排默认 **RRF**（`EdgeReranker.rrf` `:82`、`NodeReranker.rrf` `:90`）——与我们 `store.ts` 的多路 RRF 同构。

### 我们的现状（已核实，与旧交接文档不一致）

`mem_facts` 的时间列只有 `recorded_at_ms`（`src/memory/schema.ts:60`），**没有 valid_at/invalid_at**。

此处更正一条旧结论：`HANDOFF-20261102-memory-wave-abc.md` 写「`retired_at_ms` 有列、检索会过滤，
但没有任何代码会把它置位」——**现在不成立**。`src/memory/fold.ts:92` 有写入：
`UPDATE mem_facts SET retired_at_ms = ? WHERE fact_id = ? AND ...`，配套 `lifecycle.ts` 的
`decayedImportance` / `shouldRetire` 与 `retireFacts`。

所以差异更精确了：我们已有**退役**（`retired_at_ms`，可逆，一刀切），缺的是**有效时间**（valid/invalid）——
退役回答「这条还该不该被检索」，Graphiti 的失效回答「这条在什么时候是真的」。前者是运营动作，后者是语义。

### 能拿什么

给 `mem_facts`（以及将来的 `mem_links` 时间化）加 `valid_at_ms` / `invalid_at_ms` 两列，
巩固时对同 `(subject, predicate)` 的新旧事实：旧事实 `invalid_at_ms = 新事实.valid_at_ms`，不删正文、不动 FTS。
这正好是 roadmap P2「同实体只保留最新值为当前态」的实现路径，且与现有 `retired_at_ms` 互不冲突
（一个管语义有效期，一个管检索可见性）。

**别照搬的部分**：Graphiti 用 LLM 逐边抽时间戳。我们 1,098,122 条边，这个成本是线性爆炸；
我们的 `occurred_at_ms` 在 turn 上已经有了，从 turn 继承比重新抽便宜得多。

## 三、HippoRAG：PPR，而不是加权求和

### 做对了什么

`run_ppr`（`src/hipporag/HippoRAG.py:2177-2220`）：

```
pagerank_scores = self.graph.personalized_pagerank(
    vertices=..., damping=damping,        # 默认 0.5
    directed=False,                       # 无向投影
    weights='weight',
    reset=reset_prob,                     # 种子分布
    implementation='prpack',
)
doc_scores = pagerank_scores[passage 节点]
```

种子怎么来（`HippoRAG.py:2080-2115`）：`node_weights = phrase_weights + passage_weights`——
phrase 侧是「事实分数按出现次数取平均」，passage 侧是「DPR 归一化分数 × 权重」。
然后 PPR 在这个种子分布上迭代传播，取 passage 节点的稳定分布排序。

三个值得记的实现细节：
- **damping 0.5**，不是教科书的 0.85。低 damping 意味着传送概率高、传播半径短——**它刻意不让相关度跑太远**。
- **无向投影**（`directed=False`）：相关性可以从低度节点回流到高度节点。
- **prpack**：igraph 的幂迭代实现，不是近似。

### 与我们的扩散激活差在哪

我们的扩散（`src/memory/store.ts:69` 的 `SPREAD_RRF_WEIGHT = 0.25`，`:1115` 起的 `spreadHops` 段）
是：种子 → 邻居扩展 → 结果作为**额外一路候选**进入 RRF 融合，权重 0.25。
它是**一次性扩展 + 加权融合**。

HippoRAG 是：种子分布 → 在整图上**迭代求解稳定分布** → 直接用这个分布排序。
传播是多次的、全局的，且传送概率每步都回到种子。

所以 −31.2pp 否掉的是「邻居分数加权求和再进 RRF」这个形态，**不构成对 PPR 形态的证据**。
若 P2 之后还要碰图，正确做法是先在离线探针上试 PPR，而不是复用已否决的加权求和。

### 为什么不能直接复用

- HippoRAG 的图是**实体短语 ↔ passage 的二部图**（OpenIE 三元组建），我们的图是实体共现（153,304 实体 / 1,098,122 边）。
  在二部图上 PPR 有「回流到 passage」的自然结构，在共现图上没有。
- 它依赖 igraph 内存图 + 向量库，与 SQLite 单文件形态冲突。

**可借的只是算法与参数**（无向投影、damping 0.5、reset 来自种子分布），不是代码。

## 四、两条可操作动作

| # | 动作 | 落点 | 判据 |
|---|---|---|---|
| 1 | facts 双时间化：加 `valid_at_ms` / `invalid_at_ms`，巩固时同 (subject,predicate) 旧事实置 `invalid_at_ms = 新.valid_at_ms` | `src/memory/schema.ts:60` 区域、巩固管线 | `knowledge-update` 分型召回回到题内水平（roadmap P2 原判据） |
| 2 | 扩散激活重估：在离线探针里实现 PPR（无向、damping 0.5、seed=fused top-k），与现有加权求和同批题对比 | `.rivet/scratch/` 探针，不改产品代码 | 若 PPR 形态在 250 题上不低于 bm25 基线，则「扩散无效」的结论需要改写 |

第 2 条是把一个**已被否决的机制**重新打开，门槛要说清楚：不是「再试一次」，而是
**旧形态（加权求和）失败 ≠ 新形态（PPR）失败**。证据支持这个区分，因为两者的传播数学不同。

## 五、证据纪律与未验证

- 本篇所有 Graphiti / HippoRAG 的判定均为 **[实测读码]**：直接读 `--depth 1` 克隆后的源码，
  行号对应 2026-11-02 克隆的 HEAD（未固定 commit，**行号会漂，符号名才是锚点**）。
- 未做：没有跑过这两家的任何测试或 benchmark；没有验证 PPR 在我们 1,098,122 边图上的复杂度
  （igraph PPR 的墙钟时间与图规模、damping 的关系未知）。
- 未做：Letta/MemGPT（关系记忆 + 人格分层）与 Generative Agents 仍未对账，`memory-landscape.md`
  的候选清单还剩这两家。
- 外部声称（各家公布的 LongMemEval 分数）**一条都没采信**：口径是 QA accuracy，我们是检索层 recall，
  不可比。此点 `memory-landscape.md:87` 已用我们自己的数据论证过（全给 haystack 0.5640 vs top-8 检索 0.3760）。
