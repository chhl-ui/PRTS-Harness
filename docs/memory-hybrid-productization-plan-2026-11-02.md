# 混合检索产品化方案（2026-11-02 · 探索期结论）

承接 `memory-recall-weighted-gated-2026-11-02.md`：离线已证明「时间词门控 + 加权 1:0.5」把
recall@8 从 31.8% 提到 36.9%（p=0.036）、temporal 保持 64.7%。本篇回答：**要把它接进产品，
真正的前置工序是什么，按什么顺序做。**

结论先说：**这不是「接线」问题，是四道前置工序。** 我原文档里写的三步（扫描覆盖 → queryVector
接线 → 门控权重）漏了最前面两道，漏掉的那两道会让接线当场变成事故。

---

## 一、四条已核验的事实（都不是推断）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **turn 向量无法经产品代码写入**：`putVectors` 的 `ownerKind` 类型限定 `'fact' \| 'profile'` | `src/memory/store.ts:1183` |
| 2 | 同上：`embedPending` 的选行 SQL 只取 fact / profile；schema 注释明写不对 turn 建向量 | `src/memory/store.ts:1230-1248`、`src/memory/schema.ts:163-164` |
| 3 | **语义路每次 search 都重读全表 BLOB 并逐条解码**，无进程内缓存 | `src/memory/store.ts:864-877` |
| 4 | 查询侧 embed 超时在**构造期**固定 30 s，无 per-query 预算 | `src/memory/embedding.ts:49`（`opts.timeoutMs ?? 30_000`） |
| 5 | **语义路回表只处理 fact / profile，turn 向量被静默丢弃** | `src/memory/store.ts:930-960`（只有 `ownerKind === 'fact'` 与 `'profile'` 两个分支，无 turn） |

另外两条核验过的支撑事实：

- 两条生产调用路径**都是 async 上下文**，可在 `search()` 前 await 一次 embed：
  `src/runtime/memory-inject.ts:100`（回调 async，:121 调 search）、`src/runtime/memory-tools.ts:105`（execute async，:114 调 search）。
- **装配层没有任何 embedder 注入缝**：`start.ts:482` 与 `:492-499` 都只传 `{ store }`；
  `MemoryInjectionDeps` / `MemoryToolDeps` 无 embedder 字段。
- **按路加权已有代码先例**：`rank(spreadHits, 'spread', SPREAD_RRF_WEIGHT)`（`store.ts:1153`），
  而 `rank(semanticHits, 'semantic')`（`:965`）没传权重——加权重是低风险改动，不是新机制。

## 二、为什么顺序不能颠倒

**实测补充（本轮 `probe-semantic-hotpath.mjs`）**：在 `memory-s-vec.sqlite`（246,595 条 turn 向量）上直接调产品 `search()` 并传 `queryVector`，三次耗时 **1,590 / 1,589 / 1,567 ms**——第 2、3 次不下降，证明没有任何进程内缓存；按 `SEMANTIC_SCAN_CAP=50_000` 线性外推到 24.6 万条约 **7.8 s**（外推值，非实测）。同次返回的 `semantic` 来源命中为 0，但该查询 bm25 本身也未命中，所以这 0 条不足以单独作为证据——事实 5 是按源码分支判定的，不是按本次结果。

```
                    ┌─ 现状：turn 向量只在探针库副本（memory-s-vec.sqlite）
                    │       产品库写不进去（事实 1、2）
                    ▼
   [无向量] ──► 接查询侧 ──► 每次 search 重读 5 万行 BLOB 解码（事实 3）
                    │          热路径 = 4.8 s 加载 + 0.25 s 计算，不是 0.25 s
                    │
                    └─────► Ollama 不可用/冷启动 ──► 等满 30 s（事实 4）
                                                      = 首字延迟 30 s
```

三件事叠加的效果是：**先接查询侧 → 空结果 + 4.8 s + 可能 30 s 卡顿。** 这不是「效果不好」，
是把每轮对话的首字延迟打穿。所以顺序必须是：**能写 → 有常驻 → 有预算 → 才谈接线与权重。**

## 三、索引形态选型

约束：`search()` 同步返回、24.6 万条 × 1024 维 float32、项目约定「纯 TypeScript + node:sqlite、
无构建步骤」（`AGENTS.md:19`）、`package.json` 里没有任何向量/ANN 依赖。

| 路线 | 内存 | 查询 | 新依赖 | 结论 |
|---|---|---|---|---|
| **常驻 Float32 矩阵 + 线性余弦** | 1.01 GB | 0.25 s/题（**实测**） | 无 | **推荐**：唯一零依赖且延迟已实测的方案 |
| INT8 量化 + 线性余弦 | ~254 MB | 需实测 | 无 | 内存压力大时的降级选项；**精度损失未测**，不作第一步 |
| sqlite-vec 一类 ANN 扩展 | 待测 | 待测 | 原生二进制 | **本机可加载性未取证**：Node 24.19.0 的 `node:sqlite` 是否支持 `loadExtension` 未验证，外网文档被代理 fake-IP 拦截 |
| 分层粗筛（session/实体级先筛） | — | — | 无 | **已否决**：两阶段粗筛实测 any@8 38.8%→34.0%（`store.ts:695-702` 注释），同 session 文本合并 −1 题 |

推荐路线的三条硬理由：延迟已实测（0.25 s/题、加载 4.8 s）、零新依赖（不破坏项目约束）、
实现面最小（只碰 `store.ts` 的语义路，不改数据库）。ANN 留作「超过百万条」时的升级路径，
不是现在的问题。

## 四、四波工序

### Wave 1：让 turn 向量可写入

- `putVectors` 的 `ownerKind` 类型加 `'turn'`（`store.ts:1183`）
- `schema.ts:163-164` 的注释与事实对齐（现在明写「不对 turn 建」）
- `embedPending` 增加 turn 分支：选行 SQL + 文本口径（与 FTS 对齐，否则向量与 bm25 检索的不是同一段文本）
- **语义路补 turn 回表分支**（`store.ts:930-960` 只有 fact / profile 两分支，turn 命中被静默丢弃——症状与「库里没有向量」完全一样，是最隐蔽的一条）
- 调度入口：巩固管线或 CLI 子命令（不放在对话热路径）
- **判据**：`embedPending({ kinds: ['turn'] })` 能写入 N 条，`vectorStats()` 显示 `turn` 计数 > 0；
  单测覆盖「写入后能被 `search()` 检到，且返回项 `recallPaths` 含 `semantic`」——只断言「写入成功」不算，
  要断言「检索得到」
- **成本**：24.6 万条 × 92.8 条/秒 ≈ **44 分钟**（已有实测），向量表约 1.0 GB

### Wave 2：常驻向量快照

- 新增 `SemanticIndex`：懒加载 `owner_kind='turn'` 的向量到 `Float32Array` + `ids` 数组，单例持有；
  `putVectors` 后 `invalidate()`
- `search()` 的语义路改用它；SQL 逐行路径保留为回退（小库或内存受限时）
- **判据**：全量 24.6 万条下单次 `search()` 的语义路耗时 ≈ 0.25 s（现状实测 1,590 ms / 5 万行，外推 ~7.8 s / 24.6 万行）；
  内存增量 ≈ 1.0 GB；加载只在首次 search 发生一次（要有日志证据，不能只看「感觉变快了」）
- **注意**：这条不修，Wave 4 的任何效果验证都会被 4.8 s 的加载噪声污染

### Wave 3：查询侧前置层（安全边界都在这一层）

- 新增 `prepareQueryVector(text, opts): Promise<number[] | undefined>`，两个调用点共用
  （`memory-inject.ts:120`、`memory-tools.ts:114`），**不改 `search()` 签名**
- 内部四件事：短超时（建议 ≤2 s，与 30 s 的后台批处理预算分开）· try/catch · 计数器 · 门控
- **门控放在这一层而不是 `search()` 内部**：`search()` 是同步的，门控放进去省不掉最贵的异步
  embed 往返，只会省 ≤5 万行余弦扫描；而且时间词判断是 NL 启发式，不该沉到存储层
- `MemoryQuery` 增 `semanticWeight`（`rank` 已支持第三参）与 `semanticTimeoutMs`
- **判据**：Ollama 不可用时，检索结果与纯 bm25 **逐条相同**（回归测试断言，不是「看起来差不多」）；
  超时上限 ≤2 s；降级原因进日志/计数器（现在这些路径完全无痕）

### Wave 4：产品侧效果验证

- 口径：注入可答对率，题量 **≥100**（n=20 的 ±1 题不可解读是已经踩过的坑）
- 判分器固定（本地 27B 或 API 二选一，选定后不得换——换过就不能混比）
- 每题独立 dataRoot（同一 dataRoot 下 session 历史会串，历史事故）
- **判据**：可答对率不低于 bm25 基线，且检索层 recall@8 复现 ≥36.9%

## 五、这一轮没解决的事（不假装解决）

1. **冷启动延迟无实测**：Ollama 模型未 load 时首次 embed 的耗时，全仓无记录。给不出可信预算，
   只能等真机测。
2. **sqlite-vec 可加载性未取证**：Node 24 `node:sqlite` 的扩展能力、Windows x64 二进制可用性都没验。
   这也是推荐路线不选 ANN 的原因之一——不是它不好，是它在这里无法证明。
3. **INT8 量化的精度损失未测**：254 MB vs 1.01 GB 的取舍要数据才能定。
4. **生产库的向量库存量未查**：`start.ts:172` 的默认库路径取决于 `dataRoot`，本轮只查了
   benchmark 库（`mem_facts` 0、`mem_profiles` 833、`mem_turns` 246,607）。
   Wave 1 前必须先 `vectorStats()` 预检真实生产库。
5. **`SEMANTIC_SCAN_CAP` 的去留**：Wave 2 之后这个上限对 turn 路失效（走常驻矩阵），
   但 fact/profile 路还用它。要不要拆成两个常量，留给实现时定。

## 六、给下一步的一句话

**先做 Wave 1。** 没有可写入的 turn 向量，后面三波全是在空库上做优化；而 Wave 1 的成本是
44 分钟本地推理加一次类型放宽，零 API 成本、零架构风险。

## 七、证据等级说明

| 标记 | 含义 | 本篇用法 |
|---|---|---|
| 实测 | 本轮或前序会话跑出数字 | 0.25 s/题、4.8 s 加载、92.8 条/秒、@8 36.9% |
| 核验源码 | 我逐行读过 `file:line` | 事实 1–4、装配缝、rank 先例 |
| 未核验 | 子代理报告，未独立确认 | sqlite-vec 可加载性、冷启动量级 |
| 推断 | 无实测支撑 | 门控落点的收益估算、熔断阈值 |
