# 扩散激活接线与测量（Wave 4，2026-11-02）

承接计划的 Wave 4：扩散激活接入检索。**零 API 成本**（纯检索，判分用官方 `has_answer` 标注）。

---

## 结论（先说结果）

**接线完成了，机制正确；但扩散对检索没有正向价值，默认保持关闭。**

| 配置 | any@8 | all@8 | any@32 | MRR | 扩散进结果条数 |
|---|---|---|---|---|---|
| 基线（无扩散） | **32.8%** | 18.4% | **46.4%** | **0.1863** | 0 |
| 扩散同权（weight=1） | 1.6%（**-31.2pp**） | 0.8% | 43.6%（-2.8pp） | 0.0409 | 1952 |
| 扩散折扣（weight=0.25） | 32.8%（±0.0pp） | 18.4% | 46.4% | 0.1863 | **0** |

样本：`longmemeval_s_cleaned` 前 250 道有证据题，同一库同一 `search()`，只切 `spreadHops`。

**两种极端都不成立**：同权时扩散把任何 8 名砸穿（-31.2pp），折扣后又一条都进不来（等效关闭）。中间区间没有扫描——那是调参，不是验证。

## 为什么会这样（分析，非结论）

1. **同权时的失败机制是清楚的**：`any@32` 只掉 2.8pp 而 `any@8` 掉 31.2pp，说明候选没被删除，是被扩散顶出了前排。扩散候选的 score 系数 `(1+0.1×overlap)` 还高于直接命中，于是系统性压过真正匹配的内容。这是「关联证据被当成匹配证据」。
2. **折扣后完全进不来**，说明扩散候选的 RRF 底分本来就低：它按「命中几个邻居实体」排序，而不是按「与查询的相关度」。在 32 个名额里挤不过 bm25 的前若干名。
3. **更深的问题**：共享实体的 turn 未必相关。两个 turn 都提到 `AI`，内容可以毫无关系。共现关系衡量的是「同一段文本里出现过」，不是「回答同一个问题需要」。计划的风险表里写的「扩散放大噪音」，实测成立。

## 已核实

- `npm test` → **277 passed / 0 failed**，exit 0（基线 271 + 新增 6）
- `npx tsc -p .` → 无错误
- 真机库巩固覆盖 246,607 turn，`mentions` 717,211 条（每 turn 平均 2.9 个实体进提及表）
- 上表所有数字来自 `.rivet/scratch/probe-spread-eval.mjs` 实际输出

## 实现（保留，默认关闭）

| 文件 | 改动 |
|---|---|
| `src/memory/schema.ts` | 新增 `mem_mentions`（实体 → turn_id 映射） |
| `src/memory/consolidate.ts` | 巩固时写入 mentions；`consolidationStats` 增加 `mentions` |
| `src/memory/store.ts` | `search()` 加扩散路（种子抽实体 → 1 跳邻居 → mentions → turn） |
| `src/memory/types.ts` | `MemoryQuery` 加 `spreadHops` / `spreadLimit` / `spreadMinWeight` / `spreadSeeds` |
| `test/memory/spread.test.ts` | 新增 6 个用例 |

**默认 `spreadHops: 0`**，即现有基线与这些改动之前一字不变（S1 用例钉住）。

### 补的一个结构洞

原来的图只有「实体 ↔ 实体」，**没有「实体 → 出现位置」**。没有这条边，扩散只能导航到实体名、召回不了任何内容。
FTS 也替代不了：`trigram` 对 `AI` / `TV` 这类 2 字符实体恒为 0，而它们恰恰是出现最多的。
所以加了 `mem_mentions`。键用 `turn_id` 而不是 `rowid`——`rebuildProjections` 会重建 `mem_turns`，rowid 会漂，而 mentions 不参与重放，漂了会永久指向错误的 turn 且无报错。

## 顺带修的一个抽取缺陷（影响远超扩散）

写扩散测试时发现 `The Godox V1` 整条抽不出实体。根因：PROPER 正则把 `The Godox V1` 整体匹配成一个序列，首词 `The` 命中停用词表后**整条被丢弃**——于是所有「The + 专名」开头的句子都丢实体，这是最常见的英文句式。

修法：句首剥掉停用词/祈使动词后继续处理，而不是整条丢。
修完 `The Godox V1 ... Sony A7R IV` 两个都抽到；`A Sony camera` 也不再丢 `Sony`。

**这条修复对 Wave 2 的巩固质量有实际影响**（此前这类句子的实体全部缺失），但因巩固产物已在 `memory-s.sqlite` 上重跑过，修复已生效。

## 建议（下一步）

1. **不要把扩散当成 Wave 6 的加分项**。当前设计（共现实体 → 注入候选）没有证据支持它能提升检索。
2. 如果还要探索这条路，方向应改：**把扩散用作查询扩展或 rerank 特征**，而不是直接往候选池里加 turn。例如把「种子实体的邻居」作为查询重写的一部分，仍由字面/语义匹配决定谁入选。
3. 真正有证据支持的仍是**向量路**（上一轮：top-8 可答性 0/3 → 2/3）与**巩固质量**。

## 未解决

1. 中间权重区间（0.25–1.0）未扫描。判断：那是调参，在「同权有害、0.25 无效」两点之间扫出一个能过零点的配置，不能说明机制成立。
2. 扩散只在 retrieval 线上测过，reading 线（oracle 整段 haystack）未测——但那条线不走检索，扩散对它没有作用点。
3. `spreadSeeds` 默认 5（从 top-5 直接命中抽实体），未做敏感性分析。

## 复现

```sh
cd /c/prts-system

# 单测
node --disable-warning=ExperimentalWarning --test test/memory/spread.test.ts

# 测量（250 题 × 2 配置，约 4.5 分钟）
LIMIT_Q=250 node --max-old-space-size=8192 --disable-warning=ExperimentalWarning .rivet/scratch/probe-spread-eval.mjs
```
