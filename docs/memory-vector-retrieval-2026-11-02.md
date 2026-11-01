# 向量检索路（v2.17，2026-11-02）

承接 `HANDOFF-20261102-PRTS-memory-v3.md` 的「下一步」第 1 项：向量混合检索的工程实现。

---

## 结论

1. **Wave 0 判据「归纳画像 0/3 → 停止，架构假设需重构」建立在错误归因上。** 归纳产物本身是对的：库里那条 Sony 画像、那条 Premiere 画像内容完全正确，足以写出满足 gold rubric 的答案。失效发生在检索层——bm25 在 120 条短画像上分数从 0.0213 平铺到 0.0191（区分度不到 12%），目标画像全部掉出 top-8。
2. **加向量后，同一批数据的 top-8 可答性从 0/3 变为 2/3。**
3. **剩下的 1 例（Q3）向量也救不了，但原因不是检索算法**，见「未解决」第 1 条。

## 证据

### 观测口径

3 道 `single-question-preference` 题（Q1 `8a2466db` 视频剪辑、Q2 `06878be2` 摄影配件、Q3 `75832dbd` AI+医疗影像），
120 条归纳画像（Wave 0 产物，`C:\prts-benchmark\profile-probe.sqlite`）。
每题在 120 条里**恰好只有 1 条**正确画像，其余是同类干扰（Nikon / Canon / 柯达 vs Sony；deep learning NLP vs medical imaging）。

### 目标画像排名（已核实，可复现）

| 题 | 正确画像 | 纯 bm25 | 加向量 |
|---|---|---|---|
| Q1 视频剪辑 | `premiere_pro_color_grading` | 第 16 | 第 4 |
| Q2 摄影配件 | `camera_gear`（Sony A7R IV） | 未命中 | **第 1** |
| Q3 AI+医疗影像 | `deep_learning_medical_imaging_research` | 未命中 | 第 14 |

### 端到端 top-8 可答性（走生产 `MemoryStore.search()`）

| | 纯 bm25 | 加向量 |
|---|---|---|
| 命中 | 0/3 | **2/3** |

对照：Wave 0 旧代码 + 判分器实测 0/3。

Q2 是向量路价值的直接证据：Sony 画像在结果里标记为 `[semantic]`，即 **bm25 完全没召回它，是向量路独家带进来的**。

### 口径声明

- 上面的「可答性」是**人工按 gold rubric 判定**，不是判分器实测（判分器对 rubric 型 gold 有已知失效，§9.4）。这是刻意的：本轮不消耗用户 API key。
- n=3 只能定方向，不能定幅度。**不得**据此推算全量 30 题或 500 题的提升。
- 表中所有数字来自 `.rivet/scratch/probe-vector-vs-bm25.mjs` 与 `probe-vector-e2e.mjs` 的实际输出，非估算。

## 实现

| 文件 | 改动 |
|---|---|
| `src/memory/embedding.ts` | 新增。`Embedder` 接口、`OllamaEmbedder`（本地 bge-m3）、float32 小端编解码、余弦 |
| `src/memory/schema.ts` | 新增 `mem_vectors` 表（`owner_kind` + `owner_id` 主键，换模型就地覆盖） |
| `src/memory/types.ts` | `RecallPath` 加 `'semantic'`；`MemoryQuery` 加 `queryVector` / `semanticTopK` / `semanticMinSim`；`MemoryHit` 加 `recallPaths` |
| `src/memory/store.ts` | `search()` 加向量路；新增 `putVectors` / `embedPending` / `vectorStats` |
| `test/memory/vector-search.test.ts` | 新增 8 个用例 |

### 三个关键取舍

**1. `search()` 保持同步，向量化放在调用方。**
向量化是异步的，`search()` 是同步的。改成 async 会破坏全部现有调用方。把查询向量作为入参传入，一举两得：
现有签名零改动；没有 Ollama 的环境传不进向量，**自动退化为纯 bm25**，而不是抛错或静默返回零向量。

**2. 向量只覆盖 fact / profile，不覆盖 turn。**
turn 是 24.6 万级，全量余弦不划算；且 turn 的瓶颈在粒度不在语义（v2.11：session@3 85.6% vs turn@8 38.8%）。

**3. 向量化文本必须与 FTS 索引同口径**（fact = `subject + predicate + body`）。
否则 bm25 与向量比较的是两段不同文本，融合结果无法归因。本会话三次翻车的共同根因就是这个。

### `recallPaths` 的由来

改这个字段是因为测试暴露了问题：RRF 里一个候选只保留**首次**命中的路径标签。Q2 的 Sony 画像先被 bm25 命中（标签记 `profile`），向量路再命中时只加了分、没留痕——于是「向量到底有没有立功」这个问题在数据上无法回答。
`recallPaths` 记录全部来源，`recallPath` 保留为首次来源以兼容旧调用方。

## 未解决

1. **Q3 那一类，向量也救不了，而且不该指望它。**
   问题原文是 "recent publications or conferences that I might find interesting" —— 不含任何领域词。用户的领域（AI 医疗影像）只存在于画像里。
   任何 query–document 匹配都无解，需要的是**用户身份驱动的主动注入/扩散激活**（原计划 Wave 4）。这是架构缺口，不是检索算法缺口。

2. **生产库仍是空的。**
   `memory-s.sqlite`：246,607 turn、**0 fact**、无 `mem_profiles` 表。没有巩固管线（Wave 2-3），向量路在生产上无货可检。
   依赖链：巩固管线 → 产出画像 → 向量检索才有对象 → 扩散激活才有图可走。

3. **运行时是否接受本地 Ollama 依赖，未定。**
   当前实现是可选 + 降级（没有 Ollama 就走纯 bm25），所以不构成硬依赖。但「有向量的机器」和「没向量的机器」检索行为不同，这是需要显式记录的环境差异，不能当作等价。

4. **扫描上限 50,000 条未压测。**
   超过这个数量需要 ANN 索引（HNSW / IVF），当前是线性全扫。现有数据量远低于上限。

5. **未做全量评测。**
   30 道 preference 题、500 题检索基线、reading 线都未重跑。本轮只做了 3 题的受控对照。

## 复现

```sh
cd /c/prts-system

# 需要本机 Ollama（默认 127.0.0.1:11434）与 bge-m3
ollama serve   # 若未启动；Windows 下路径 %LOCALAPPDATA%\Programs\Ollama\ollama.exe

# 1) bm25 vs 向量的并列排名（零 API 成本）
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-vector-vs-bm25.mjs

# 2) 走生产 search() 的端到端 top-8 可答性
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-vector-e2e.mjs

# 3) 单测（离线，用词袋假 embedder，不依赖 Ollama）
node --disable-warning=ExperimentalWarning --test test/memory/vector-search.test.ts
```

验证记录（2026-11-02 本轮实跑）：

- `npm test` → **260 passed / 0 failed**，exit 0（基线 252 + 新增 8）
- `npx tsc -p .` → exit 0
- `probe-vector-e2e.mjs` → 向量补齐 240 条（120 fact + 120 profile）、0 失败、2,610ms；top-8 可答性 bm25 0/3、加向量 2/3
