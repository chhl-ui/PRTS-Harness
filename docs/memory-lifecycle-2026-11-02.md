# 生命周期 Wave 5（2026-11-02）

承接 `.rivet/plans/仿人脑记忆架构补齐-v3-巩固管线-关联图-扩散激活-归纳画像.md` 的 Wave 5：
「重要性衰减写回、`retired_at_ms` 写入路径」。**零 API 成本**。

---

## 结论

1. 三档遗忘的前两档落地：**降权**（重要性衰减）+ **退役**（`retired_at_ms`），
   都不可见于默认检索，都可逆。第三档「清除正文」已由 `memory.deleted` 覆盖。
2. **衰减没有按计划写回 `mem_facts.importance`**，改成查询期折算 + 只在状态跃迁时落事件。
   理由见下节，这是本轮唯一的设计偏差。
3. 新增 10 个单测（`test/memory/lifecycle.test.ts`），全量 `301 passed / 0 failed`，`tsc` 无错误。
4. **效果未验证**：真机 `mem_facts` 是 0 条（fact 抽取从未接入生产链路），
   所以本轮只证明了「机制正确、可重建、可恢复」，没有证明「退役能提升检索」。

## 三类信息分列

### 已核实（附来源）

- `npm test` → **301 passed / 0 failed**，exit 0（基线 291 + 新增 10）
- `npx tsc -p .` → 无错误
- `grep -rn "retired_at_ms" src/ test/` 此前只有 schema 定义与检索过滤，**零写入路径**；
  本轮的 `fact.retired` / `fact.restored` 是唯一的写入点
- 退役后检索不返回、`rebuildProjections` 后状态一致、链校验通过 —— 分别由
  `lifecycle.test.ts` 的 L3 / L8 / L7 钉住
- 衰减是纯函数：`decayedImportance(0.5, t0, t0+180d) === 0.25`（L1，容差 1e-12）

### 推算 / 待验证假设

- **半衰期 180 天、阈值 0.05、最短保留 90 天**三个参数是设计值，不是实测调优值。
  依据只有两点：默认 importance 0.5 落到 0.05 需要约 598 天（≈1.6 年），
  以及「退役是可逆但不可见的降档，误杀代价高于晚杀」。没有评测集数据支撑这三个数。
- **退役是否会提升任何题型的可答性**：未知。preference 场景的瓶颈在画像不在 fact
  （见 `docs/memory-vector-retrieval-2026-11-02.md`），退役只可能改善噪声占比，
  量级大概率为零。

### 未知（未解决清单）

1. **「用进废退」缺失**：检索命中不会强化记忆，只有时间单向衰减。
   仿人脑的复述强化（rehearsal）需要检索侧回写访问计数，而 `search()` 是只读的，
   当前没有任何调用方会做这件事。这是生命周期闭环的一半，明确未实现。
2. **`retention_class='permanent'` 无人设置**：`assertFact` 支持该参数，但生产路径
   （`consolidate` / `write`）不写 fact，所以真机上全部是默认 `clearable`。
   fact 抽取接入时必须同时定「哪些谓词算身份性事实」，否则永久类形同虚设。
3. **`memory.deleted` 与退役的交互只测了一半**：已删除的条目不进退役候选（SQL 过滤），
   恢复时也拒绝已删除项（fold 里的 `deleted_at_ms IS NULL`），但「先退役再删除、
   再重建」的组合顺序没有专门用例。

---

## 设计偏差：为什么衰减不写回

计划原文是「重要性衰减**写回**」。落码时否决了这个做法，原因是本仓的硬不变量：

> 投影必须是事件序列的纯函数（设计稿 §八 不变量 1/2），`rebuildProjections()` 会
> `DELETE FROM mem_facts` 后按 `seq` 重放全部事件。

写回只有两条路，都不成立：

| 路线 | 后果 |
|---|---|
| 直接 `UPDATE mem_facts.importance` | 重建后丢失，投影与链不一致。守卫测试（重建一致性）会红 |
| 每次衰减追加一条事件 | 每个 fact 每个衰减周期一条：链随时钟线性膨胀，且把「作业跑了几次」这个外部事实烤进唯一的不可逆点 |

因此切分为：

- **降权 = 纯函数**：`importance` 列保持**写入时的强度**，检索时用
  `decayedImportance(importance, recorded_at_ms, now) = importance × 2^(−age/180d)` 折算。
  任何时刻算出的值都只依赖三个输入，重建后自动一致。
- **退役 = 状态跃迁**：落 `fact.retired` 事件，`retired_at_ms` 由 `fold.ts` 置位。
  事件 payload 带 `threshold` / `effective_importance` / `age_days` / `half_life_days`，
  事后能复查「当时凭什么判它该退役」。

排序侧的三处 fact 打分（FTS 路、向量路、LIKE 路）都换成了折算后的强度。
对刚写入的 fact（`age ≈ 0`）折算值等于原值，因此现有基线分数不变——这是刻意的，
避免生命周期悄悄改动检索基线，让后续评测归因失效。

## 参数与语义

| 常量 | 值 | 依据 |
|---|---|---|
| `IMPORTANCE_HALF_LIFE_DAYS` | 180 | 与 `recency()` 的 30 天区分：recency 是话题热度，importance 是事实分量 |
| `RETIRE_IMPORTANCE_FLOOR` | 0.05 | 默认 0.5 落到 0.05 需 ≈598 天 |
| `RETIRE_MIN_AGE_DAYS` | 90 | 与阈值独立：显式传低 importance 的新事实不得被立刻误杀 |

退役的筛选条件（`retireFacts`）：`scope='prts'`、`origin='live'`、
`deleted_at_ms IS NULL`、`retired_at_ms IS NULL`、`retention_class <> 'permanent'`、
`recorded_at_ms <= now - 90d`。满足后再按折算值 `< 0.05` 精判。

- `origin='benchmark'` 不参与：评测数据由评测脚本管理，生产作业改写它会污染对照。
- `permanent` 永不退役：身份性事实淡忘等于人格漂移。
- 幂等：已退役的行不在候选里，重复跑不追加第二条事件。

## 实现

| 文件 | 改动 |
|---|---|
| `src/memory/lifecycle.ts` | 新增。常量 + `decayedImportance()` + `shouldRetire()`，头部写清「为什么不写回」 |
| `src/memory/types.ts` | `MemoryEventKind` 增加 `fact.retired` / `fact.restored` |
| `src/memory/fold.ts` | 两个新事件分支：置位 / 清空 `retired_at_ms`，幂等且不动正文与 FTS 索引 |
| `src/memory/store.ts` | `retireFacts()` / `restoreFacts()` / `lifecycleStats()`；三处 fact 打分改用折算强度 |
| `src/memory/index.ts` | 导出生命周期 API |
| `test/memory/lifecycle.test.ts` | 新增 10 个用例（L1–L10） |

`retireFacts()` 的 `limit`（默认 500）是**扫描**上限，不是退役上限；`candidates`
可能少于 `scanned`。批量退役前先跑 `dryRun: true` 看数——退役虽然可逆，
但改的是默认检索可见性。

## 复现命令

```sh
cd /c/prts-system

node --disable-warning=ExperimentalWarning --test test/memory/lifecycle.test.ts   # 10 passed
npm test                                                                          # 301 passed
npx tsc -p .
```

真机库现状（`C:\prts-benchmark\memory-s.sqlite`）：`mem_facts = 0`、`mem_turns = 246,607`、
`mem_vectors` 267 条全为 profile。fact 为空意味着退役作业在真机上**无对象可动**，
`retireFacts()` 会返回 `scanned: 0`。
