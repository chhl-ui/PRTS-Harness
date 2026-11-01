# turn 级向量 rerank 实验（2026-11-02）

承接「两阶段检索走不通」之后的方向：召回集合已经够（any@32 = 60.4%），问题在排序（any@8 = 32.8%），所以只重排不动召回。

**零 API 成本**：本地 bge-m3 推理，250 题共 25,000 次。

---

## 结论

1. **纯向量重排总体 +4.8pp**（32.8% → 37.6%），但**分型差异达 32pp**：multi-session **+16.0pp**，temporal-reasoning **-16.1pp**。
2. **不能全局启用**。直接上线会用 temporal 的 16pp 换 multi-session 的 16pp，总体赚 4.8pp，但代价是一整类题型崩掉。
3. **两套「只对 multi-session 启用」的判据都失败**：候选覆盖的 distinct session 数完全不可分（四类题型中位数 63–72），加权 RRF 在数学上也只能在 32.8%–37.6% 之间插值。
4. 因此**未实现到生产代码**，只留实验记录。

## 已核实（附来源）

### 250 题总体

| 配置 | any@8 | any@32 | Δany@8 |
|---|---|---|---|
| 基线 bm25 | 32.8% | 60.4% | — |
| R1 纯向量重排 | **37.6%** | 60.4% | **+4.8pp** |
| R2 等权 RRF | 35.6% | 60.4% | +2.8pp |

候选池 = `search()` 的 top-100（生产路径），any@32 三行相同是因为候选池没变——只改排序。

### 分题型

| 题型 | n | 基线 | R1 | Δ |
|---|---|---|---|---|
| multi-session | 125 | 26.4% | **42.4%** | **+16.0pp** |
| single-session-preference | 30 | 3.3% | 6.7% | +3.4pp |
| single-session-user | 64 | 45.3% | 39.1% | -6.2pp |
| temporal-reasoning | 31 | 61.3% | 45.2% | -16.1pp |

加和校验：`125/250×16.0 − 64/250×6.2 + 30/250×3.4 − 31/250×16.1 ≈ +4.8`，与总体一致。

数据来自 `.rivet/scratch/probe-rerank.mjs` 实际输出，250 题耗时 407 秒。

### 判据验证失败

`spread` = 每题 top-100 覆盖的不同 session 数：

| 题型 | n | p10 | 中位 | p90 |
|---|---|---|---|---|
| single-session-user | 64 | 43 | 63 | 84 |
| multi-session | 125 | 42 | 71 | 85 |
| single-session-preference | 30 | 22 | 72 | 90 |
| temporal-reasoning | 31 | 52 | 69 | 86 |

四类几乎重合。阈值扫描：任何阈值都触发 200+ 题，其中一半是非 multi，误伤率 50%。

## 机制解释（分析，非结论）

- **multi-session** 要「跨会话找齐同类信息」，字面往往不重叠 → 向量赢 16pp
- **temporal-reasoning** 要「谁先谁后、多少天」→ 向量把数字和时间戳抹平 → 输 16pp
- **single-session-user** 答案就在字面相近的片段里 → bm25 本来就准，重排引入噪声

**这与画像场景形成对照**：120 条归纳画像上，Sony 那条 bm25 完全召不到、向量 top-1。差别在于文本形态——画像是短归纳句，turn 是长对话原文，bge-m3 对后者语义稀释。

## 加权 RRF 为什么不是退路

```
score = w_bm25/(60+rank_bm25) + w_vec/(60+rank_vec)
```

三个已知点：`w_vec=0` → 32.8%，`w_vec=1` → 35.6%，`w_vec→∞` → 37.6%。**单调插值，任何权重都落在 32.8%–37.6% 区间内**，不可能同时保住 temporal 又拿满 multi-session。

## 踩到的坑：50 题的误判

先用 50 题试跑，得到「R1 -8.0pp、两种重排都变差」的结论。改成 250 题后反转成 +4.8pp。

根因：数据文件的前 50 条**全部是 `single-session-user`**，而该类正是 R1 掉得最多的（-6.2pp）。两次结果其实一致，我把单一题型读成了整体趋势。

**教训**：小样本试跑前先看它的题型分布，否则试跑会给出方向相反的信号。

## 未解决

1. 「只对 multi-session 启用」的判据未找到。已排除：distinct session 数、加权 RRF。未试：bm25 top-1 分数当置信度（需再一轮 8 分钟实验，连续两次判据失败后判断性价比不高）。
2. 未做重排池深度敏感性分析（POOL 固定 100）。
3. 只测了 bge-m3，未对比其他 embedding 模型。

## 与其他方向的关系

turn 级检索的三个改进方向已全部试完：

| 方向 | 结果 |
|---|---|
| 两阶段 session 级粗筛 | 负（全库 any@10 34.8% < turn 级 any@8 32.8%） |
| 扩散激活 | 负（同权 -31.2pp，折扣后 0 候选） |
| 向量 rerank | 分层（总体 +4.8pp，但单类 -16pp） |

结论指向：**turn 级检索已接近上限，继续动算法是边际调参**。要再上台阶需要改变**检索对象**——把 turn 变成归纳出的 fact/profile，那正是向量擅长的短文本形态。

## 复现

```sh
cd /c/prts-system

# 需要本机 Ollama + bge-m3
LIMIT_Q=250 node --max-old-space-size=8192 --disable-warning=ExperimentalWarning .rivet/scratch/probe-rerank.mjs

# 判据验证（不需要向量，约 2 分钟）
LIMIT_Q=250 node --max-old-space-size=8192 --disable-warning=ExperimentalWarning .rivet/scratch/probe-session-spread.mjs
```
