# PRTS 记忆主线交接（2026-11-02）

写给一个完全没有上下文的新会话。所有事实都在下面，不需要读之前的对话。

**工作仓**：`C:\prts-system`（TypeScript，直接跑 .ts，无构建步骤）。`git HEAD` = `3616634`，
工作树干净。**测试 252/252，typecheck exit 0**。**当前档位**：全自动权限。

**注意工作目录**：本次会话的工作目录是 `C:\tianshu`（天枢运行时），项目在 `C:\prts-system`。
计划文件在**会话目录** `C:\tianshu\.rivet\plans\`，探针脚本在**项目目录** `C:\prts-system\.rivet\scratch\`。

---

## 任务目标

推进 PRTS 记忆方向的**仿人脑架构补齐**（架构需求 §5.2/§5.3）。

**非目标**：工作区装配/上下文压缩（另一条线）、意图库（V1-14）、关系记忆（V1-05）。

---

## 已批准计划与执行进度

计划：`C:\tianshu\.rivet\plans\仿人脑记忆架构补齐-v3-巩固管线-关联图-扩散激活-归纳画像.md`
（slug `仿人脑记忆架构补齐-v3-…`；TUI 下 `/plan-approve|reject <slug>`）

**Wave 0（前置验证）已完成，判定「未通过判据」**，Wave 1-6 未完成。

| Wave | 内容 | 状态 |
|---|---|---|
| 0 | 前置验证：归纳画像能否救 preference 题 | ✅ 跑完，**0/3**（判据 ≤3/10 应停） |
| 1 | 数据基础（4 张新表） | ⚠️ 部分完成（画像表已建，其余未建） |
| 2 | 巩固管线（规则部分） | ❌ |
| 3 | 巩固管线（模型部分） | ❌ |
| 4 | 检索接入（扩散激活、profile 路） | ⚠️ profile 路已做，扩散未做 |
| 5 | 生命周期（重要性衰减、退役） | ❌ |
| 6 | 整体验证 | ❌ |

---

## 本次会话做了什么（16 个提交，从旧到新）

| 提交 | 内容 |
|---|---|
| `d7e4f89` | recency 从乘性权重改轻加成，检索 any@8 36.9%→38.8%、MRR 全面提升 |
| `38aecb7` | 归档 MRAgent（ICML 2026）与 AMB 评测框架；补记 hindsight 真实成绩 |
| `b03880e` | `mem_facts` 加 identity_key（**含两处错误，见下条**） |
| `9189697` | 修正：身份键改为**去重**语义（不判更新）、且**不得含正文明文** |
| `05b79a0` | **记忆模块接进运行时**——用户消息落成 turn（此前是死代码） |
| `5628c25` | 助手回复也落盘——记忆从单向变双向 |
| `6d64d6b` | fact/turn 分组名额 + 修旧库迁移 bug + 修测试并发污染 |
| `fb77c15` | fact-oracle 上界实验（后来被证明是假上界） |
| `e1bb97c` | v2.10 更正：假上界 |
| `c582f96` | v2.11 粒度实验：session@3 85.6% vs turn@8 38.8% |
| `64b0f20` | session 级索引 + 两阶段检索（**实测变差，默认关闭**） |
| `d0981f7` | v2.13 更正：「抽取 0/10」是判分错误，正确判据下 **4/10** |
| `ce9e9f6` | v2.14 Wave 0 未通过：画像泛滥 |
| `1e6691e` | 画像闸门（`mem_profiles` 独立表 + `profileQuota`），修两个真实 bug |
| `3616634` | v2.16 语义检索验证：向量 top-1 命中 bm25 排不上的 case |

---

## 关键数字（每个都能指到真实验证记录）

### 两套基线（口径不同，不可混比）

| 线 | 数字 | 口径 |
|---|---|---|
| reading（oracle 整段 haystack 全给） | **0.5640** | n=500 valid / 0 invalid |
| retrieval（s_cleaned top-8） | **any@8 38.8% / all@8 23.4%** | 479 题，246,750 turn |

**数据文件**：`C:\prts-benchmark\longmemeval\` 下 `longmemeval_oracle.json`（15,388,478 字节）
与 `longmemeval_s_cleaned.json`（277,383,467 字节），已核实与官方 HF `longmemeval-cleaned` 一致。

### preference 类（30 题，本会话重点）

| 方案 | 得分 | 判据 |
|---|---|---|
| turn 检索 any@8 | 3.3% | 检索层召回 |
| **模型抽取 fact + 检索** | **4/10（40%）** | rubric 判据 |
| fact-oracle（gold 当输入） | 86.7% | **假上界，勿引用** |
| 模型归纳画像 + 检索（Wave 0） | **0/3** | rubric 判据 |

### 语义检索（Ollama + bge-m3，本地零凭证成本）

120 条画像向量化，3 道题检索：

- 摄影配件题（gold 要 Sony）：bm25 排不上 → **向量 top-1（0.620）**，内容完全正确
- video editing 题：bm25 排不上 → 含 Adobe 的画像第 **4/120**
- AI in healthcare 题：仍不相关

**1/3 完全命中、1/3 大幅改善、1/3 不理想。方向由铁证坐实。**

---

## 已确认的事实（不要重新怀疑）

1. **记忆模块已接进运行时**：`src/runtime/start.ts` 挂 `agent/inbox/claimed` 落 user turn、
   `agent/assistant-stream` + `agent/turn-stopping` 落 assistant turn。有 MW1/MW2/MW3 真机测试。
2. **DeepSeek 没有 embedding 端点**（`/v1/embeddings` 返回 404，模型只有 `deepseek-flash`/
   `deepseek-v4-pro`）。向量只能用本地——本机 Ollama 已装 `bge-m3`（1.2GB）。
3. **`mem_facts` 在真机仍为空**——没有巩固管线，运行时只落 turn。
4. **`mem_topics` / `mem_summaries` 零 INSERT**（`grep -c` = 0）。
5. **偏好题 gold 是评分 rubric**，不是答案文本。用「期望答案」口径判分会产生假阴性。

---

## 五个真实 bug（都已修，但要知道它们长什么样）

1. **SQL 候选截断无 ORDER BY**（`4a8aebc`）：`LIMIT limit*4` 无排序 = 随机取行。修后 R@8 2.1%→43.4%。
2. **旧库迁移炸在建索引**：索引写在 SCHEMA 里，而 SCHEMA 先于 ALTER 执行 → 旧库 `no such column`。
   修法：索引只由迁移函数创建。**全套单测没抓到，因为都用新库。**
3. **测试并发污染**：直接改 `process.env` 在 `node --test` 同进程并行下污染其他用例，
   表现为**一次不可重现的失败**。改用参数注入（`StartOptions.memoryDbPath`）。
4. **id 空间冲突**：`fused` 按 id 合并，profile 与 fact 同 id 时 kind 被吞。症状「12 条命中、0 条输出」。
5. **分组配额被全局重排抵消**：`[...profiles, ...facts].sort().slice(limit)` 把配额语义抹掉。

---

## 本会话反复犯的错（最重要的一节）

**同一个模式犯了三次**：用 A 方法验证、用 B 方法实现，再假设两者等价。

| 次数 | 表现 | 纠正 |
|---|---|---|
| 1 | 探针用纯 FTS 得 45.1%，实现是混合 + recency 得 38.8% | `fa8a600` 更正 |
| 2 | fact-oracle 把 gold answer 当输入，得 86.7% 假上界 | `e1bb97c` 更正 |
| 3 | 离线用 token 重叠得 85.6%，实现用 bm25 得 14.7% | `64b0f20` 默认关闭 |

**硬规定**：任何验证脚本必须 `import { MemoryStore }` 调真实 `search()`，不得另写检索逻辑。

另外**判分链对 rubric 型 gold 不适用**（本仓 §9.4 早有记录），v2.11 用它判出 0/10 是错的，
正确判据下 4/10。**用判分器前先查它的已知失效题型。**

---

## 计划与实际的偏离（已记录）

1. **Wave 0 从「人工写画像」改成「模型归纳」**：议事会指出人工画像作者必然看过 gold，
   是上界中的上界，且不代表自动巩固能力。
2. **Wave 1 部分提前做了**：画像是 Wave 0 闸门的直接依赖，先建了表。
3. **引入向量验证**：用户批准用 API 生成向量，但 DeepSeek 无此端点，改走本地 Ollama。

---

## 下一步（按优先级，均未做）

1. **向量混合检索的工程实现**：SQLite 存向量（BLOB/Float32），画像与事实全量余弦（百千级可行），
   turn 继续用 FTS（24 万级）。这是唯一已被证据支持的方向。
2. **巩固管线的数量与质量闸门（Wave 2-3）**：把画像从「每题 40 条的泛滥」变成「少数高价值」。
   **这是 Wave 0 失败的直接原因。**
3. **`fact.corrected`（纠正）**：V1-06 主验收缺的那一个动作，零设计。
4. **`single-session-assistant` 破线**：实测 1043ms/题，V1-16 要求 P95 ≤ 1s。
5. **V1-17 门禁**：基线已有，门禁未建（等用户拍板口径）。

---

## 复现命令

```sh
cd /c/prts-system
npm test                                    # 252 tests
npx tsc -p .

# 检索基线（不需要 API，复用已有库）
node --max-old-space-size=8192 .scratch/probe-s-retrieval.mjs --no-import

# 语义检索探针（需本机 Ollama + bge-m3）
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-embedding.mjs

# 画像闸门测试
node --disable-warning=ExperimentalWarning --test test/memory/profile-gate.test.ts
```

**数据位置**：`C:\prts-benchmark\`（独立根，不入 protectedRoots/workspaceRoots）。
`memory-s.sqlite` 是 246,750 turn 的 s_cleaned 库；`profile-probe.sqlite` 是 120 条画像的探针库。

**API key**：`C:\prts-data\secrets\deepseek.key`（35 字节）。
**用户明确要求：非必要不要调用 PRTS 的 key。** DeepSeek 也不支持 embedding。
