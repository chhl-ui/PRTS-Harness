# 巩固管线 Wave 2（规则部分，2026-11-02）

承接 `.rivet/plans/仿人脑记忆架构补齐-v3-巩固管线-关联图-扩散激活-归纳画像.md` 的 Wave 2。
**零 API 成本**——本层是纯规则抽取，不调用任何模型。

---

## 结论

1. 巩固管线规则部分已实现并在真实库上跑通：**246,607 turn 100% 覆盖，53.6 秒，产出 152,336 实体 / 1,083,035 条共现边 / 144,154 个主题**，平均稠密度 14.2 边/实体。
2. 三条硬不变量（幂等、水位线不越界、取消不写半成品）由 11 个单测逐条钉住，全部通过。
3. 抽取质量经过一次真机驱动的返工，见「踩到的坑」——**第一版抽出来的全是动词**。

## 三类信息分列

### 已核实（附来源）

- `npm test` → **271 passed / 0 failed**，exit 0（基线 260 + 新增 11）
- `npx tsc -p .` → 无错误
- 真机全库巩固：`C:\prts-benchmark\memory-s.sqlite`，246,607 turn，
  墙钟 53,614ms（237ms / 千 turn），`cursor` 到 246,607，`区间不重叠` 与 `游标<=maxRowid` 判据均通过
- 上述数字来自 `.rivet/scratch/probe-consolidate-real.mjs` 的实际输出，非估算

### 推算 / 待验证假设

- **「关联图能提升多跳题」仍是假设**。本层只证明了图建得出来、规模够用，没有验证它对检索有没有帮助。
  那需要 Wave 4（扩散激活接入检索）跑评测集，本轮未做。
- **规则抽取的召回率未测**。没有人工标注的实体金标准，所以「漏了多少」是未知数。
  能说的只有：抽出来的头部实体看起来是对的（`AI` / `Instagram` / `Facebook` / `YouTube`）。
- 稠密度 14.2 边/实体是「每实体平均度数」，不是图论意义上的密度。数值够高说明图不是散的，但不代表边质量高。

### 未知（未解决清单）

1. **`Additional Tips` 这类小标题被当成实体**（提及 1,463 次，排第 8）。它是句中反复出现的大写短语，
   规则层无法与专名区分。淘汰它需要词表或模型，Wave 3 之后再定。
2. **`am — pm` 这类时间标记进了图**（权重 384）。同上。
3. **12 条 turn 未处理**：`budgetSpent` 累计 246,595，游标 246,607，差 12。
   差额来自被删除或正文为空的 turn（`selectUnconsolidated` 主动跳过），不是失败。
   若要精确对上，需要把「跳过」也计入 budget——当前设计没这么做。
4. **`mem_summaries` 未处理**。它仍在 `rebuildProjections` 的清理列表里，而它同样是链外派生项。
   Wave 3 实现摘要时必须一并决定它的归属，否则会重演本轮修掉的「重建即丢失」缺陷。

## 实现

| 文件 | 改动 |
|---|---|
| `src/memory/extract.ts` | 新增。实体抽取（专名 / 双引号短语 / 数量+单位 / 缩写），含句首与祈使动词过滤 |
| `src/memory/consolidate.ts` | 新增。实体 upsert、共现边、主题计数、水位线；分批事务、可取消 |
| `src/memory/schema.ts` | 新增 `mem_consolidation` / `mem_entities` / `mem_links` |
| `src/memory/store.ts` | 挂 `consolidateRules()` / `consolidationStats()` / `consolidationCursor()`；修正 `rebuildProjections` |
| `test/memory/consolidate.test.ts` | 新增 11 个用例 |

### 关键设计决策

**1. 巩固产物是链外派生项，不走事件链。**

巩固依赖 turn 正文，而正文外置在 `mem_bodies`（设计稿 §6.2 路线 D）。把正文烤进事件会破坏
「链上只留 body_ref + sha256」这个唯一不可逆的形状（§八 不变量 9）。因此这些表与 `mem_profiles`
同类：**不参与 `rebuildProjections`，重建后保留**。

**顺带修掉一个会被这次改动引爆的旧缺陷**：`rebuildProjections` 原本会 `DELETE FROM mem_topics`，
但游标不在重放范围内。一旦主题开始写入，重建就会让主题永久消失且无任何报错——游标不重置，
巩固不会重算已跳过的 turn。已从清理列表移除并注明理由。

**2. 一批 = 一个事务，取消只在批边界检查。**

这是「不写半成品」的实现方式：实体、边、主题与游标推进同生共死。批内中断会留下
「数据写了但游标没推进」的中间态，重跑就会重复计数。

**3. 无向边只存一份**（规范化 `from_key < to_key`）。

存双向会让「A–B 共现 3 次」在两行上各记 3 次，之后扩散激活按 `weight` 取邻居时
绝对值翻倍，任何阈值都要跟着猜。

**4. 时间只用 `occurred_at_ms`，解析失败兜底 0。**

`mem_turns` 没有 `recorded_at_ms` 列（那是 `memory_events` 的字段）。用 `Date.now()`
兜底会让同一批 turn 两次巩固得到不同的 `first_seen_ms`，「重复跑结果一致」直接破。

## 踩到的坑（第一版全错，真机数据打回来的）

第一版跑 20,000 turn 后，提及最多的实体是：

```
Use / Choose / Create / Look / Make / Consider     ← 全是祈使句句首动词
`s great that you`                                  ← it's 的单引号被当成引号短语
```

权重最高的边是 `choose — use`(57)、`choose — select`(52)、`add — use`(41)——**图里没有实体，只有语法**。

两个根因：

1. **句首判定只认 `.` `!` `?`**。markdown 列表项（`- Use a tripod`、`1. Choose ...`）的行首
   不在边界集合里，于是祈使动词被当成专名。修法：换行、冒号、分号、行首列表标记全部算边界；
   句首若仍是「祈使动词 + 专名」序列，剥掉首词保留专名。
2. **单引号短语规则在英文里不可用**。`it's` / `don't` 的撇号会被配对成短语。
   修法：直接去掉单引号规则，只收双引号与中文引号。

修完后同一批 turn 的头部实体变成 `AI` / `TV` / `Instagram` / `US` / `Facebook` / `YouTube`，
最高权重边变成 `facebook — instagram`、`facebook — twitter`、`kyoto — osaka`。

**教训**：只看「实体数 > 0」就收货，会把一张全是动词的图交出去。必须抽头部样本人工看一眼。

## 复现

```sh
cd /c/prts-system

# 单测（离线，无模型依赖）
node --disable-warning=ExperimentalWarning --test test/memory/consolidate.test.ts

# 真机小批量（默认 20000 turn）
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-consolidate-real.mjs

# 全库（当前库已跑到 100%，重跑会返回 turns=0）
MAX_TURNS=300000 BATCH=2000 node --disable-warning=ExperimentalWarning .rivet/scratch/probe-consolidate-real.mjs
```

**库状态**：`C:\prts-benchmark\memory-s.sqlite` 的巩固产物已跑到全库覆盖。
清空重跑：`DELETE FROM mem_links; DELETE FROM mem_entities; DELETE FROM mem_topics; DELETE FROM mem_consolidation;`
