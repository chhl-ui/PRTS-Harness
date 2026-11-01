# PRTS 记忆第一版设计决定

状态：v2.2，经议事会四席评审后修订，2026-11-01 二次收束并定下四条待决（删除路线 D、DeepSeek 判分、基准落位、T04/T05 不适用）。对应架构需求 §5.2 / §5.3，验收 V1-06 / V1-15 / V1-17。

**这是设计决定，不是实现计划。**

v1 有两处硬伤，四席一致指出，已改：①删除路线漏了最贴本项目形态的「正文外置」（§七）；②检索分流表与自己的实测数据自相矛盾（§6.5）。逐条处置见 §十二。

## 一、为什么现在写这份文档

架构需求 §10 的依赖顺序：内核与插件机制审查与决定 → **记忆/人格/情感/上下文审查与决定** → 其余模块 → 第一版实现。

第一步已完成（§4.4 四项决定 → K1—K6 + U3 + P2 落码，2022 测试通过）。第二步的输入已备齐：`docs/memory-landscape.md` 做完了三个参考实现 × 十三项的对账。缺的正是这一步的产物——**选择**。

### 1.1 `DESIGN.md` 已找到：归档在 error 目录，但判弃依据恰恰是「保留」

架构需求四处引用 `DESIGN.md`：

| 行 | 引用内容 |
|---|---|
| L26 | 「`DESIGN.md` 中的契约（目标/计划分版、记忆生命周期、删除与撤销、评估隔离）作为参考设计保留」 |
| L67 | §3 独立判据第 3 条「沿用 `DESIGN.md` T32 的思路」 |
| L235 | §5.3「清除（删除正文与派生副本，**按 `DESIGN.md` §9 的流程执行**）」 |
| L267 | §5.4「参照 `DESIGN.md` §10」 |

**实测定位（2026-11-01）**：

```
C:\Users\Administrator\Desktop\error\PRTS-弃案文档-2026-10-31\DESIGN.md
33,743 字节，版本 0.1 / 2026-10-19，16 章
```

章节逐一对照，与架构需求引用的三处吻合：`§5 分层记忆与索引化经验`、`§9 主动遗忘、撤销与备份契约`、`§10 自进化与评估契约`。**这就是被引用的那一份。**

**它的状态是「归档但有效」，不是「作废」**：

- 该目录 `README.md` 写：「这些不是『执行失败轮』，而是**已被取代的文档**或**根本不属于设计文档的材料**」。而 `DESIGN.md` 一行的判弃依据原文是——「架构需求 0.5『与旧文件的关系』：**作为参考设计保留，按本文的模块划分重新取用**」。
- 也就是说：它被移出主线视野的原因是**它属于 C 候选路线**（博士 10-29 改选方案 A）；判弃依据引用的那句话本身是「保留」。两件事不是一回事。
- `设计和计划\README.md` 的「在办主线」7 份文档里没有它；「已归档」一节确认 7 份已于 2026-10-31 移出。**没有指定任何继任文档。**
- 恢复方法（该目录 README 原文）：「把文件移回 `C:\Users\Administrator\Desktop\设计和计划\` 即可，文件名未改。」

**结论**：`DESIGN.md` 是**有效性未被撤销、但已不在主线视野**的参考设计。§七 据此改写——不再自造路线，按 `§9` 落地。

## 二、范围

§5.3 定义八格存储。第一版只做 V1-06 / V1-15 / V1-17 需要的最小集。

| 格 | 第一版 | 依据 |
|---|---|---|
| 事件日志 | **做** | 所有派生记忆的可追溯源 |
| 情景记忆（turn 级原文） | **做** | 与事件日志同构；基准输入就是这个形状 |
| 语义事实（双时间 + provenance） | **做** | V1-15 前提；provenance 是零覆盖格 |
| 检索 | **做** | V1-06 的「记得」靠它 |
| 删除 | **做**（物理彻底性待拍板，见 §七） | V1-06 硬验收 |
| 主题目录 | **做最小计数视图**（v1 曾列为不做，错） | 架构需求 L203 明写「元记忆 = 主题目录常驻工作区」，而 V1-15 正是元记忆验收。不做则 V1-15 无验收载体 |
| 情景摘要（大意） | **做最小一层** | §5.3 L219「保存原话与大意」、L237「删除覆盖检索索引、关联图与派生摘要」，V1-06 原文也有「摘要中也不再出现」。不做则这三句全部不可测 |
| 关系记忆 | 不做 | 服务 V1-05（情感），不是 V1-06 |
| 技能与经验 | 不做 | 服务 V1-09（进化） |
| 意图库 | 不做 | 服务 V1-14，可独立立项 |
| 关联图 | 不做 | §11 第 9 条明说第一版先做共现；且 V1-06 的删除穿透不依赖它 |

**v1 的错误**：把「主题目录」和「摘要」都划进不做，而 V1-06 的验收原文包含「摘要中也不再出现」、V1-15 的验收对象就是元记忆。等于把两个验收句变成不可测。v2 各补一个最小层——不是完整实现，是**让验收可判定**的最小载体。

## 三、输入一：外部对账的结论

取 `docs/memory-landscape.md` 的结论，不复述证据：

- **零覆盖四格**：关系记忆、技能与经验、意图库、provenance。前两格可补拉 Letta / Generative Agents，后两格只能自建。
- **可借四条（hindsight）**：写时结构化的两段式；observation 的 `proof_count`/`source_memory_ids` 溯源；图作为行上的边；检索四路融合。
- **可借三条（mempalace）**：分层作用域；协议层强制「回答前先查」；删除连带清派生索引。
- **不可复用的硬理由**：hindsight 强绑 PostgreSQL+pgvector，mempalace 强绑 chromadb。PRTS 是 TypeScript + `node:sqlite`（§4.4 第 4 条）。

## 四、输入二：基准的形状约束（实测）

### 4.1 LongMemEval（ICLR 2025，500 题）

来源：`github.com/xiaowu0162/LongMemEval` README（curl 直读，2026-11-01）。

五个维度：Information Extraction / Multi-Session Reasoning / Knowledge Updates / Temporal Reasoning / **Abstention**。

| 字段 | 内容 |
|---|---|
| `question_id` / `question` / `answer` / `question_date` | 问题与标准答案 |
| `haystack_session_ids` / `haystack_dates` | 会话 id 与其时间戳（`_s`/`_m` 排序，`_oracle` 不排序） |
| `haystack_sessions` | 每会话是 turn 列表，turn = `{role, content}`；**证据 turn 带 `has_answer: true`** |
| `answer_session_ids` | 证据会话 id 列表 |

三档：`_oracle`（只含证据会话）/ `_s`（约 40 会话、115k token）/ `_m`（约 500 会话）。
输出：`jsonl`，每行 `{question_id, hypothesis}`。判分脚本需 **`OPENAI_API_KEY`**（gpt-4o 做 LLM 判分）。
指标三档：QA 准确率、turn-level recall（`has_answer`）、session-level recall（`answer_session_ids`）。

### 4.2 LoCoMo（ACL 2024，10 个对话）

来源：`data/locomo10.json`，**下载后实测**（2,805,274 字节），不是只读 README。

```
顶层 array len=10
样本键: qa, conversation, event_summary, observation, session_summary, sample_id
conversation 键数 56 = speaker_a/b + session_1..session_19 + 19 个 *_date_time
session_1 = array[18]，turn 键 = speaker, dia_id, text
首 turn: {"speaker":"Caroline","dia_id":"D1:1","text":"Hey Mel! ..."}
session_1_date_time = "1:56 pm on 8 May, 2023"      ← 自由文本，不是 ISO
qa = array[199]，键 = question, answer, evidence, category
category 分布: {1:32, 2:37, 3:13, 4:70, 5:47}
qa[0]: {"question":"When did Caroline go to the LGBTQ support group?",
        "answer":"7 May 2023","evidence":["D1:3"],"category":2}
```

`evidence` 是 `dia_id` 列表——**turn 级定位**。

### 4.3 共同形状 → 五条硬要求

| 共同点 | 对存储的硬要求 |
|---|---|
| 「带时间戳的会话历史 + 一个问题」 | 能批量导入外部会话，session 与 turn 两级都保留 |
| 会话级时间戳格式自由（`"1:56 pm on 8 May, 2023"`） | 时间**原始串与解析值双存**，解析失败不丢数据 |
| turn 级证据定位（`has_answer` / `dia_id`） | 检索能返回到 turn 级，保留原始 id |
| 靠证据召回率评分 | 检索接口要输出「命中了哪些 turn/session」，不能只返回拼好的文本 |
| **基准数据与真实对话混在同库** | **必须能区分来源**（v1 漏了这条）。否则 V1-15 的「记忆里没有 X」会被 haystack 里的内容污染，abstention 指标虚高 |

## 五、技术前提（实测 2026-11-01）

### 5.1 现有架构约束

| 约束 | 来源 |
|---|---|
| 纯 TypeScript，`node:sqlite` 持久化 | `AGENTS.md:19` |
| 只追加哈希链事件 + 可重建投影 | `AGENTS.md` 工作方式节 |
| **唯一的投影更新函数**：增量路径与 `rebuildProjections` 调同一个函数，投影是事件序列的纯函数 | `src/ledger/fold.ts:50-53` 头注释 |
| **rebuild 等价测试已有先例** | `test/ledger/integrity.test.ts:33`「rebuildProjections：与增量投影逐字段相同」 |
| **不可变链上的变更有现成表达**：`revision` 列 + `STALE_REVISION` | `src/ledger/ledger.ts:318` |
| **正文外置已有先例**：`{locator, bytes, retrievalHint}`，正文落盘、引用进链 | `src/spill/store.ts:71`、`src/spill/types.ts` |
| **删除带派生项逐项完成**：`audit_deletions(deletion_id, target_json, derivatives_json, completed, requested_at, completed_at)` + `deletion.derivative-done` 事件 | `src/audit/audit.ts` 建表与 `src/audit/fold.ts` 的 `deletion.derivative-done` 分支 |
| 每个变更在一个事务内「追加事件 + 应用投影」 | `AGENTS.md` 工作方式节 |
| `readOnly: true` 下所有写方法抛 `READ_ONLY` | 同上 |

### 5.2 记忆库的落盘位置与授权面（v1 漏了）

仓库已有明确的三类根模型（`docs/design-tool-output-spill.md` §五）：`protectedRoots` > `spillRoots` > `workspaceRoots`，对模型 shell 的读/写/删分别判定。记忆库必须落到同一套模型里，否则会出现新的旁路。

建议：`<dataRoot>/memory.sqlite`，落在 `protectedRoots` 内——

| 能力 | 在 protectedRoots 内 |
|---|---|
| `fs.read`（模型工具） | **deny**（否则模型能直接读走全部记忆原文） |
| `fs.write` / `fs.delete` | **deny** |
| 宿主写入 | 不受 `tools.guard` 管辖（与 spill 同构：宿主写，非工具写） |

**但记忆需要一个只读出口**（V1-06 要求博士能「查看、纠正、删除」—— 查看走宿主命令，不是模型工具）。这条边界要在实现时写清，不能留给推断。

### 5.3 SQLite 全文检索能力（实测）

探针：`node -e` 打开 `:memory:` 库逐项试建。`sqlite_version()` = **3.53.3**。

| 方案 | 建表 | 中文 2 字"镜头" | 中文 3 字"光学镜" | 英文全词"optics" | 英文前缀"stat" |
|---|---|---|---|---|---|
| FTS5 默认 `unicode61` | 可用 | **0** | **0**（"光学"也 0） | 1 | **0** |
| FTS5 `tokenize='trigram'` | 可用 | **0** | 1 | 1 | — |
| `LIKE '%q%'` | 可用 | 1 | 1 | 1 | 1 |
| FTS5 `tokenize='icu'` | **不可用** | — | — | — | — |

**v1 的自相矛盾**：v1 的 §5.2 表格如实记了「英文前缀 stat → 0」，但 §6.5 的分流表只承认「英文全词命中」，等于把已实测的零召回丢掉了。四席一致指出，v2 改（见 §6.5）。

## 六、设计

### 6.1 数据流

```mermaid
flowchart TB
  subgraph 输入
    A[对话回合<br/>role/content/time/origin=live]
    B[外部会话导入<br/>origin=benchmark]
    C[博士明说的事实<br/>provenance=stated]
    D[模型推断的事实<br/>provenance=inferred]
  end

  A --> EL[(memory_events<br/>只追加哈希链<br/>payload 只存 ref+digest)]
  B --> EL
  C --> EL
  D --> EL

  EL -->|fold 投影| T[(mem_turns<br/>turn 级原文) ]
  EL -->|fold 投影| F[(mem_facts<br/>双时间+provenance+origin)]
  EL -->|fold 投影| S[(mem_summaries<br/>最小摘要层)]
  EL -->|fold 投影| X[(mem_deletions<br/>derivatives + completed)]

  BODY[(mem_bodies<br/>链外正文<br/>可物理删除)] -.ref.-> EL
  T -.ref.-> BODY
  S -.ref.-> BODY

  Q[查询线索] --> R{检索}
  T --> R
  F --> R
  S --> R
  R --> RK[排序<br/>相关×时近×重要性]
  RK --> OUT[带 provenance / origin / turn 定位的结果]

  X -.删除标记.-> T
  X -.删除标记.-> F
  X -.删除标记.-> S
  X -.物理删除.-> BODY
```

### 6.2 表结构（草案）

三条设计约束：与 `ledger_events`/`audit_events` 同构；复用 `src/chain/`；投影只由 fold 更新。

```sql
-- 事实来源：只追加。payload 只存引用与摘要，不存正文（见 §七 路线 D）
CREATE TABLE memory_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,   -- 'turn.recorded'|'fact.asserted'|'fact.corrected'
                                  -- |'summary.generated'|'memory.deleted'|'deletion.derivative-done'
  occurred_at_ms INTEGER,         -- 有效时间（可空：解析失败）
  occurred_raw   TEXT,            -- 原始时间串，解析失败时唯一可用的证据
  recorded_at_ms INTEGER NOT NULL,-- 记录时间
  actor_kind     TEXT NOT NULL,   -- 'owner'|'model'|'system'
  scope          TEXT NOT NULL,   -- 第一版固定 'prts'
  payload_json   TEXT NOT NULL,   -- 只含 body_ref + body_sha256 + 元数据
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);

-- 链外正文：可物理删除
CREATE TABLE mem_bodies (
  body_ref       TEXT PRIMARY KEY,
  sha256         TEXT NOT NULL,   -- 与事件 payload 里的 digest 对照，防篡改
  body           TEXT,            -- 删除后置 NULL
  byte_length    INTEGER NOT NULL,
  written_at_ms  INTEGER NOT NULL
);

-- 投影：turn 级原文（基准的输入形状）
CREATE TABLE mem_turns (
  turn_id        TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  turn_index     INTEGER NOT NULL,
  external_id    TEXT,            -- LoCoMo 的 dia_id
  speaker        TEXT NOT NULL,
  body_ref       TEXT,            -- 指向 mem_bodies；删除后为 NULL
  occurred_at_ms INTEGER,
  occurred_raw   TEXT,
  origin         TEXT NOT NULL,   -- 'live' | 'benchmark'   ← 见 §4.3 第 5 条
  is_evidence    INTEGER DEFAULT 0,
  deleted_at_ms  INTEGER
);
CREATE INDEX idx_turns_session ON mem_turns(session_id, turn_index);
CREATE INDEX idx_turns_origin  ON mem_turns(origin, deleted_at_ms);

-- 投影：语义事实
CREATE TABLE mem_facts (
  fact_id        TEXT PRIMARY KEY,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  body_ref       TEXT,            -- object 也外置
  valid_from_ms  INTEGER,
  valid_to_ms    INTEGER,
  recorded_at_ms INTEGER NOT NULL,
  provenance     TEXT NOT NULL,   -- 'stated' | 'inferred'
  origin         TEXT NOT NULL,   -- 'live' | 'benchmark'
  confidence     REAL,
  revision       INTEGER NOT NULL DEFAULT 1,        -- 每次事实变更递增（DESIGN.md §5）
  confirmation_basis TEXT NOT NULL,                 -- owner-stated | model-inferred | verifier
  applicable_when TEXT,                             -- 适用条件，可空
  retention_class TEXT NOT NULL DEFAULT 'clearable',-- permanent | retirable | clearable（对应 §9 三档）
  source_turn_ids TEXT,           -- JSON 数组
  importance     REAL DEFAULT 0.5,
  retired_at_ms  INTEGER,
  deleted_at_ms  INTEGER
);

-- 投影：最小摘要层（V1-06「摘要中也不再出现」的验收载体）
CREATE TABLE mem_summaries (
  summary_id     TEXT PRIMARY KEY,
  subject_kind   TEXT NOT NULL,   -- 'session' | 'topic'
  subject_id     TEXT NOT NULL,
  body_ref       TEXT,            -- 大意也外置
  source_turn_ids TEXT,
  generated_at_ms INTEGER NOT NULL,
  deleted_at_ms  INTEGER
);

-- 投影：主题目录（V1-15 的最小载体，不是完整实现）
CREATE TABLE mem_topics (
  topic          TEXT PRIMARY KEY,
  entry_count    INTEGER NOT NULL,
  last_seen_ms   INTEGER,
  source_kind    TEXT NOT NULL    -- 'turn'|'fact'|'summary'
);

-- 投影：删除记录（照抄 audit_deletions 的形态，不用 v1 的 cascade_json 数组）
CREATE TABLE mem_deletions (
  deletion_id    TEXT PRIMARY KEY,
  target_json    TEXT NOT NULL,   -- {kind, id}
  derivatives_json TEXT NOT NULL, -- 待清派生项清单
  completed      INTEGER NOT NULL DEFAULT 0,
  requested_at   INTEGER NOT NULL,
  completed_at   INTEGER
);
```

**为什么 `mem_deletions` 照抄 `audit_deletions`**：仓内已有这条路径（`src/audit/audit.ts` 建表 + `src/audit/fold.ts` 的 `deletion.derivative-done` 分支）。v1 写成 `cascade_json` 数组是自己的退化发明，四席一致指出，改。

### 6.3 时间：双时间 + 自由文本

规则：

1. **两列都存**：`occurred_raw` 原样，`occurred_at_ms` 解析结果。解析失败时后者 NULL，**前者仍在**。
2. **`recorded_at_ms` 独立**：系统知道这件事的时间，与事件发生时间无关。
3. **解析器是最小集**：只处理基准实际出现的形态（`<M> <D>, <YYYY>`、`<h>:<mm> <am|pm> on <D> <Mon>, <YYYY>`、ISO 8601）。**不做自然语言时间解析**。
4. **解析失败留痕**：导入时统计失败率并打印，不静默。

### 6.4 provenance 与 origin：两个不同的列，缺一不可

| 列 | 取值 | 回答什么 |
|---|---|---|
| `provenance` | `stated` / `inferred` | 这条是博士明说的，还是模型推断的 |
| `origin` | `live` / `benchmark` | 这条来自真实对话，还是基准导入 |

**v1 只有 provenance、没有 origin，是错的**：基准 haystack 里的内容会被当成「真实记忆」，V1-15 的「记忆里没有 X」立刻被污染——本该答「没有记录」的题，因为 haystack 里有近似的句子而答「有」，abstention 指标虚高。

**硬规则**：
- `provenance = 'inferred'` 的事实不得以「博士说过」呈现。
- `origin = 'benchmark'` 的条目在 V1-15/V1-06 的验收路径上**默认不可见**（用显式参数才纳入）。基准跑分用独立路径。

### 6.5 检索

```ts
export interface MemoryQuery {
  text: string
  limit?: number
  nowMs?: number
  includeOrigin?: ('live' | 'benchmark')[]   // 默认 ['live']
}
export interface MemoryHit {
  kind: 'turn' | 'fact' | 'summary'
  id: string
  score: number
  provenance?: 'stated' | 'inferred'
  origin: 'live' | 'benchmark'
  sessionId?: string
  turnIndex?: number
  externalId?: string      // dia_id
  text: string
  /** 走了哪条召回路径、是否降级——V1-15 的 abstention 判定要用 */
  recallPath: 'like' | 'fts-trigram' | 'fts-unicode61'
}
```

**第一版召回：统一走 `LIKE`。** 这是 v2 对 v1 的主要修正。

理由（四席指出，成立）：

1. **三路分流会产生三套不可比的计分口径**：FTS5 返回 BM25 分，`LIKE` 无分。同一批问题里一部分走 BM25、一部分走全表扫描，V1-17 的基线数字无法跨查询类型比较，「分数下降则不采用」这条规则失效。
2. **互斥路由有归属空洞**：混合查询（"optics 镜头"）、单字查询、非全词英文（"stat" 实测 unicode61 = 0）在 v1 的路由表里无归属，会静默返回空——而空结果在 `MemoryStore` 接口上与「记忆里真的没有」不可区分，直接污染 V1-15 的 abstention。
3. `LIKE` 在实测里是**唯一全场景可用**的方案（见 §5.3）。

代价必须写清：`LIKE` 无索引，全表扫描。第一版数据量（V1-06 的 10 条 + LongMemEval `_oracle` 的单会话历史）完全可承受；数据量上去后换后端。

**因此 `MemoryStore` 是接口而非具体实现**——后端可替换是设计的一部分，不是将来再说的优化。FTS5 作为可选后端保留，但**启用后基线必须重测、不能与 LIKE 基线混比**。

排序：`score = 时近衰减 × (0.5 + importance)`。权重是**可配置常数，初始不预设为"正确"**（§11 第 10 条：权重待基准与真实使用数据标定）。

**检索接口必须能返回 turn 级定位与 `recallPath`**——前者是 §4.3 的硬要求，后者是 V1-15 能判定的前提。

### 6.6 删除

V1-06 要求「删除 3 条，经核实全部生效，索引与摘要中也不再出现」。

`DESIGN.md` §9 对该流程有明确规定，其中一条**直接否定了本文 v2 早先的做法**：

> 「不能用单个 `deleted=true` 代表所有副本已删除。」

所以删除不是「置一个时间戳」，而是一条带状态与核验范围的流程。§9 给出六态：`REQUESTED` → `NEW_USE_BLOCKED` → `LOCAL_PURGING` → `LOCAL_PURGED` → `EXTERNAL_PENDING` → `COMPLETED_WITHIN_DECLARED_SCOPE`。

第一版按范围裁剪（无外部副本，故 `EXTERNAL_PENDING` 不进入第一版）：

| 态 | 第一版的动作 |
|---|---|
| `REQUESTED` | 追加 `memory.deleted` 事件，写 `mem_deletions`（`completed=0`） |
| `NEW_USE_BLOCKED` | 撤销版本 +1；检索与导入立即排除该目标 |
| `LOCAL_PURGING` | 清 `mem_bodies.body`；级联摘要与主题目录 |
| `LOCAL_PURGED` | 追加 `deletion.derivative-done`（照 `src/audit/fold.ts` 的 `derivative-done` 分支形态） |
| `COMPLETED_WITHIN_DECLARED_SCOPE` | `completed=1`、`completed_at` 落时间；**清除范围写进回执** |
| `EXTERNAL_PENDING` | 第一版无外部副本，**不实现**，文档标注该态未覆盖 |

三条直接抄 §9 的硬规定：

1. **「删除标记仅含执行防重灌所需的最小标识和版本，不保存已删正文」**——这是 `mem_bodies` 外置的规范依据。
2. **「清除范围按来源 ID、对象版本与派生关系核对，不以关键词搜不到证明语义已清除」**——所以只测「检索不到」不够（见 §九 R3）。
3. **「不能同时承诺任意历史逐字恢复与实际清除」**——这条必须写进博士可见的说明。

**纠正**与删除不同：追加 `fact.corrected`，旧事实 `valid_to_ms` 置为新事实起点、`retired_at_ms` 置时间（默认不检索、可逆），新事实另起一行。**冲突保留，不静默覆盖**（§5.3 原文）。

### 6.7 基准适配

| 件 | 职责 |
|---|---|
| `importLongMemEval(file)` | `haystack_sessions` → `mem_turns`（`has_answer` → `is_evidence`），`haystack_dates` → `occurred_raw`，`origin='benchmark'` |
| `importLoCoMo(file)` | `conversation.session_N` → `mem_turns`（`dia_id` → `external_id`），`session_N_date_time` → `occurred_raw`，`origin='benchmark'` |
| `exportHypotheses(qa)` | 产出 `{question_id, hypothesis}` jsonl |

**判分不属于 PRTS**：LongMemEval 的 `evaluate_qa.py` 要 `OPENAI_API_KEY` 用 gpt-4o 判分。**这条要在 V1-17 启动前定**：申请 OpenAI key，还是用 DeepSeek 改写判分脚本——后者引入「自己判自己」偏差，必须显式记录。

## 七、删除与「事件不可变」的张力

§5.2：「原始事件不可变，巩固只生成带来源的派生条目。」
§5.3 L235：「清除（删除正文与派生副本，**按 `DESIGN.md` §9 的流程执行**）。」

前提先说清：**规范已经找到**（§1.1）。`DESIGN.md` §9「主动遗忘、撤销与备份契约」就是架构需求 L235 指定的那份流程。所以这不是「两句冲突」，也不需要自造路线——**按 §9 执行**。

下面这张表保留下来只作复盘：记录「在没找到规范时，四条候选路线各自代价如何」，以及为什么 §9 的选择与其中的 D 同构。**它不是选型依据。**

| 路线 | 做法 | 链完整 | 正文可物理清除 | 代价 |
|---|---|---|---|---|
| A. 事件正文也清 | 删除时把 `payload_json` 里的原文置 NULL | **破坏**（`hash` 覆盖 payload，K4 完整性检查报断链） | 是 | 用 K4 的完整性保证换一句设计描述——错误的交换 |
| B. 加密 + 销毁密钥 | 正文加密存储，删除即销毁该条密钥 | 完整（密文不变） | 是 | 引入密钥管理；单文件部署下密钥放哪是新问题 |
| C. 保留正文，检索层不返回 | 只追加删除事件，投影清除 | 完整 | **否**（磁盘上原文仍在，VACUUM 也清不掉） | 未达 §5.3 字面要求 |
| **D. 正文外置，链内只存 ref + digest** | `memory_events.payload_json` 只存 `body_ref` 与 `body_sha256`；正文进 `mem_bodies`；删除时清 `mem_bodies.body` | **完整** | **是** | 两条写入路径必须在同一事务；`mem_bodies` 仍是 SQLite 表，自由页问题在表内仍存在（见下方边界） |

### 7.1 §9 与候选 D 同构，理由

1. **仓内已有同构先例**：`src/spill/store.ts:71` 返回 `{locator, bytes, retrievalHint}`，正文落盘、引用进链。这不是新发明。
2. **链完整 + 删除彻底**同时成立，不需要加密。
3. **不可逆点被推迟**：链上只存 ref 与 digest，将来若要换成文件外置（真正的文件系统删除）或加密，链本身不用重建。**链上 payload 的形状是本次决定里唯一不可逆的一处**——v1 让 payload 装正文，等于把这条退路焊死。
4. 与 `revision` + `STALE_REVISION`（`src/ledger/ledger.ts:318`）同属「不可变链上的变更用新事件表达」这一族。

### 7.2 诚实边界

- **`mem_bodies` 是 SQLite 表，不是文件系统**。置 NULL 后正文落在自由页，`VACUUM` 才回收，且 SSD 上有 wear leveling。**这比 C 好，但不等于「不可恢复」**。
- 若要真正不可恢复，需要把正文外置成独立文件（像 spill 那样落 `<dataRoot>` 之外），删除即删文件。**这是 D 的文件系统变体 D'，建议作为第二版**，因为第一版的数据量还没到需要它的程度。
- **这条边界必须写给博士看**，不能写成「已实现物理删除」。

## 八、不变量

1. **投影只能由 fold 更新**。`mem_turns`/`mem_facts`/`mem_summaries`/`mem_topics`/`mem_deletions` 不接受直接 INSERT/UPDATE。
2. **增量投影与 rebuild 重放必须逐字段相同**。照 `test/ledger/integrity.test.ts:33` 的先例补测试。
3. **每个变更在一个事务内「追加事件 + 应用投影 + 写/清 body」**。三者不能分事务。
4. **`mem_bodies.sha256` 必须与事件 payload 里的 `body_sha256` 一致**；不一致即拒绝读取并报错。
5. **`provenance='inferred'` 的事实不得以「博士说过」呈现**。
6. **`origin='benchmark'` 的条目默认不进 V1-06/V1-15 的验收路径**。
7. **删除永不波及未要求删除的条目**。
8. **检索永不返回 `deleted_at_ms IS NOT NULL` 的行**；`retired_at_ms IS NOT NULL` 默认不返回，显式参数可读回。
9. **正文不得经任何绕过 `mem_bodies` 的路径返回**（事件导出、调试接口、日志）。
10. **时间解析失败不得导致导入失败**。
11. **readOnly 模式下所有写方法抛 `READ_ONLY`**。

## 九、验证

### 9.1 单元测试（RED → GREEN，镜像 `test/ledger/` 结构）

| # | 用例 | 期望 |
|---|---|---|
| M1 | 记 10 条事实，重开库后检索 | 10 条全在，`provenance` 与写入时一致 |
| M2 | 删除 3 条后检索 | 3 条不出现；其余 7 条不受影响 |
| M2b | 删除后 `mem_bodies.body` | 被删条目的 body 为 NULL（**不走检索路径，直接查表**） |
| M3 | 纠正 1 条 | 新事实生效；旧事实 `retired_at_ms` 非空且默认不检索；显式参数可读回旧值 |
| M4 | `inferred` 事实检索 | 返回带 `provenance:'inferred'` |
| M4b | `origin='benchmark'` 条目 | 默认查询不返回；`includeOrigin:['benchmark']` 才返回 |
| M5 | 导入 `locomo10.json` | turn 数、`dia_id`、`session_N_date_time` 原样；可定位回 `session_N`+`turnIndex` |
| M6 | `"1:56 pm on 8 May, 2023"` | `occurred_raw` 原样；`occurred_at_ms` 解析正确 |
| M7 | 无法解析的时间串 | `occurred_raw` 保留，`occurred_at_ms` NULL，导入不失败 |
| M8 | 中文 2 字"镜头" | 命中（LIKE 路径），`recallPath='like'` |
| M9 | 英文"optics" / 前缀"stat" / 混合"optics 镜头" | **全部命中**（统一 LIKE 的直接收益） |
| M10 | 链完整性 | 追加 N 条后 `verifyChainRows` 通过；篡改一条 payload 后失败 |
| M11 | `readOnly: true` | 所有写方法抛 `READ_ONLY` |
| M12 | 删除后链仍完整 | 追加删除事件后 `verifyChainRows` 通过 |
| **M13** | **删除后 `rebuildProjections`** | **重建后仍是「已删」状态，正文不被事件复活**（照 `test/ledger/integrity.test.ts:33` 的形态） |
| **M14** | **从事件导出接口取被删正文** | **返回 0 字节或明确拒绝**（不走检索路径的反证） |
| **M15** | **增量投影 vs rebuild 逐字段对比** | 完全一致（含删除状态） |
| **M16** | **摘要层级联删除** | 删除某 turn 后，其所属摘要 `deleted_at_ms` 非空；主题计数减少 |

### 9.2 反证（瑶光式）

| 反证 | 做法 | 必红依据 |
|---|---|---|
| R1 | 删掉检索的 `deleted_at_ms IS NULL` 过滤，重跑 M2 | M2 必红 |
| R2 | 把 `provenance` 从检索输出去掉，重跑 M4 | M4 必红 |
| R3 | 删除时只清投影不清 `mem_bodies`，重跑 M2b | M2b 必红（**v1 缺这条，M2 抓不到「检索路径恰好没走那条分支」的情况**） |
| R4 | `rebuildProjections` 里跳过 `memory.deleted` 分支，重跑 M13 | M13 必红 |
| R5 | 让 `origin` 默认包含 benchmark，重跑 M4b | M4b 必红 |

### 9.3 基准基线（V1-17）

先跑 **LongMemEval `_oracle`**——只含证据会话，规模最小（500 题、单会话历史），是最便宜的首次基线。

**判分：已改为 DeepSeek（博士 2026-11-01 决定）。**

判分脚本 `scripts\eval-longmemeval.py`，零第三方依赖（标准库直调 OpenAI 兼容端点；本机没装 `openai`/`backoff`，也不打算装）。与原脚本的差异只有三处：

| 项 | 原实现 | PRTS |
|---|---|---|
| 端点 | OpenAI / 本地 vLLM | `https://api.deepseek.com/v1` |
| 判分模型 | gpt-4o | **`deepseek-reasoner`**（默认） |
| prompt 模板 | — | **逐字未改**（改了就不是同一个基准） |

**「自己判自己」的偏差怎么处理**：被测模型是 `deepseek-chat`，判分用 `deepseek-reasoner`——同供应商、不同模型。偏差比同模型小，但不为零。三条措施：

1. 每条记录写 `judged_by`，基线数字必须带着它一起引用：「V1-17 基线 0.72（judged_by=deepseek-reasoner）」才是完整陈述。
2. `--sample` 控制题数，`--dry-run` 不花钱。
3. 人工抽样复核留待基线出来后再做——**本脚本不能消除偏差，只能让它可追溯。**

**实测（2026-11-01）：4 题对照，全部判对。**

| 用例 | 预期 | 实际 |
|---|---|---|
| 正确答案 | yes | YES ✓ |
| 故意答「I do not know」 | no | no ✓ |
| abstention 题正确识别为不可答 | yes | YES ✓ |
| 另一道正确答案 | yes | YES ✓ |

Accuracy 0.75（4 题 3 对），与构造时的预期一致。**这是判分器行为验证，不是基线成绩。**

**数据落位（已定）**：`C:\prts-benchmark\<dataset>\`——**独立的根，不在 `protectedRoots` 也不在 `workspaceRoots` 内**，理由与 spill 根相同：基准数据含标准答案，模型 shell 不能读到。

**版本锁定**：`longmemeval_oracle.json` 实测 **15,388,478 字节**，500 题，6 种 `question_type`（temporal-reasoning 133 / multi-session 133 / knowledge-update 78 / single-session-user 70 / single-session-assistant 56 / single-session-preference 30），abstention 30 题。**基线数字必须与这个字节数一起记录**——架构需求 §11 第 13 条自陈基准属「未经审读的资料级引用」，不锁版本就不可复现。

**仍未解决**：`locomo10.json` 未落位（本文的数据是 curl 到临时目录后实测的，2,805,274 字节）。

基线数字出来之前，不宣称任何召回质量。

## 十、不做的

- **不做向量检索**。第一版文本召回足够跑 V1-17；引入 embedding 要先证明改善分数。
- **不做后台巩固**。§5.3 的巩固是独立预算、可取消的后台作业，与第一版范围正交。
- **不做主动回忆**。服务 V1-07，另一条线。
- **不做多作用域隔离**。`scope` 列留好（第一版固定 `'prts'`），两人格分区属 §5.1。
- **不做时间自然语言解析**。
- **不做关联图**。§11 第 9 条明说第一版先做共现。代价：V1-06 的「关联图中也不再出现」这句在第一版不可测，**列为退化条款**。

## 十一、遗留与待决

| # | 项 | 性质 |
|---|---|---|
| 1 | ~~`DESIGN.md` 缺席~~ **已解决（2026-11-01）** | 文件在 `C:\Users\Administrator\Desktop\error\PRTS-弃案文档-2026-10-31\DESIGN.md`（33,743 字节，16 章）。`§5`/`§9`/`§10` 与架构需求 L26/L235/L267 引用逐一吻合。状态是「归档但有效」。**已移回 `设计和计划\`（2026-11-01），逐条处置见同目录 `PRTS-DESIGN-03-CONTRACTS-2026-11-01.md`** |
| 2 | ~~删除路线选 D 还是 D'~~ **已定（2026-11-01）：走 D** | `mem_bodies` 表外置正文，删除置 NULL。理由：V1-06 的 10 条规模用 D 足够；D' 会把事务边界从单库扩到「库 + 文件系统」，代价超过收益。**D 的边界已写在 §7.2**：自由页残留需 VACUUM，不等于物理不可恢复。要真正不可恢复时升级 D' |
| 3 | ~~判分用 OpenAI 还是 DeepSeek 改写~~ **已定（2026-11-01）：DeepSeek** | 脚本 `scripts\eval-longmemeval.py` 已落盘并实测（4 题对照全判对）。判分用 `deepseek-reasoner` 与被测 `deepseek-chat` 区分；`judged_by` 写进每条记录。已知偏差见 §9.3 |
| 4 | ~~基准版本锁定与数据入库位置~~ **已定（2026-11-01）** | 数据落 `C:\prts-benchmark\<dataset>\`（独立根，不入 protectedRoots / workspaceRoots）。`longmemeval_oracle.json` 已下载并锁定 **15,388,478 字节 / 500 题**；基线数字必须与字节数一起记录 |
| 5 | `LIKE` 全表扫描的规模上限 | 未定；数据量上去后需换后端并重测基线 |
| 6 | `retired` / `deleted` 的保留期与清理策略 | 未定；参考 spill 的单会话上界思路 |
| 7 | 关系记忆 / 技能经验 / 意图库 / 关联图 | 各自立项 |
| 8 | Letta / Generative Agents / Graphiti 三个补拉 | `memory-landscape.md` §五 已排，本文不阻塞 |
| 9 | `DESIGN.md` §5 的 4 列未落表 | **解法已定（2026-11-01），落码时补**：`revision`（与 K1 同构，每次事实变更递增）、`确认依据`（`owner-stated` / `model-inferred` / `verifier`）、`适用条件`（可空文本，事实成立的前提）、`保留类别`（`permanent` / `retirable` / `clearable`，对应 §9 三档） |
| 10 | ~~`DESIGN.md` T04/T05 在 V1 表里无对应~~ **已定为「第一版不适用」** | 理由不是跳过安全：**第一版 `scope` 固定 `'prts'` 单值，不存在跨项目对象**，T04/T05 没有测试对象。到两人格隔离（§5.1）引入多 scope 时启用。**在那之前，「第一版无越权面」这句话必须与「scope 单值」这个前提一起说，不能单独说** |

## 十二、议事会意见与处置

四席（天权 / 天府 / 天璇 / 瑶光）评审 v1，一致指出两处硬伤。逐条核实后处置如下——**不是照单全收，每条都回到代码核对过**。

| 意见 | 来源 | 核实 | 处置 |
|---|---|---|---|
| 缺路线 D：正文外置、链内只存 ref | 天璇 | 成立：`src/spill/store.ts:71` 返回 `{locator, bytes}`，正文落盘 | **已改**：§七 加 D 并推荐 |
| §5.3 L235 把清除委托给 `DESIGN.md` §9，而该文件不在仓内 | 天璇 / 天府 | 成立：`find -iname "DESIGN*.md"` 零命中；架构需求 L26/L67/L235/L267 四处引用 | **已改**：新增 §1.1，§七 改立论 |
| 检索分流表与自己实测的「英文前缀 stat → 0」矛盾 | 天权 / 瑶光 | 成立：v1 §5.2 记了 0，§6.5 只承认全词 | **已改**：§6.5 统一 LIKE |
| 三路分流产生三套不可比计分口径，基线失效 | 天府 | 成立 | **已改**：同上 |
| 互斥路由对混合查询/单字无归属，静默返回空污染 abstention | 瑶光 | 成立 | **已改**：同上 |
| M2 断言「摘要中不出现」但无 summary 表，不可能红 | 天璇 / 瑶光 / 天府 | 成立：v1 §6.2 无摘要表 | **已改**：§二 加最小摘要层，§6.2 加 `mem_summaries`，§9.1 加 M16 |
| 缺 rebuild 等价测试 | 瑶光 / 天璇 | 成立：`test/ledger/integrity.test.ts:33` 已有先例 | **已改**：§9.1 加 M13/M15，§八 不变量 2 |
| 反证只覆盖检索层，无法区分「删干净」与「路径没走到」 | 天府 | 成立 | **已改**：§9.1 加 M2b/M14，§9.2 加 R3/R4 |
| provenance 只覆盖 fact 行；基准数据与真实对话同库会污染 V1-15 | 天府 / 天权 | 成立 | **已改**：加 `origin` 列 + §6.4 双列 + M4b/R5 |
| 主题目录列为不做，与 L203「元记忆=主题目录」冲突 | 天璇 | 成立：L203 原文已核 | **已改**：§二 改「最小计数视图」 |
| 删除表用 `cascade_json` 是退化，仓内有 `audit_deletions` 先例 | 天府 | 成立：`src/audit/audit.ts` 建表 + `fold.ts` 的 `derivative-done` 分支 | **已改**：§6.2 照抄该形态 |
| §5.1 漏了落盘位置与授权面 | 天权 | 成立 | **已改**：§5.2 新增 |
| V1-17 基线仓内不可执行（数据不在仓、需 key、未锁版本） | 瑶光 | 成立 | **已改**：§9.3 三条前置未决 |
| `payload_json` 装正文是不可逆点 | 天璇 | 成立 | **已改**：路线 D 把它推到 body_ref |
| 路线 C 的正文在 SQLite 自由页，VACUUM 也清不掉 | 天权 | 成立 | **已改**：§7.2 显式写成 D 的边界，并给 D' |
| 少数派：范围应再砍一半 | 天机（v1 评审时的意见，本轮未复会） | 部分成立 | 已把六格压到最小载体，未再砍——再砍会让 V1-06/V1-15 的验收句变成不可测 |

**未采纳的一条**：有席位建议第一版直接上文件外置（D'）。本文把它列为第二版，理由是 `mem_bodies` 表在 V1-06 的 10 条规模下足够，且引入文件系统外置会把事务边界从单库扩到「库 + 文件系统」，代价超过收益。**但这属于可推翻的取舍，博士若要求物理不可恢复，应直接上 D'。**

**证据冲突记录**：三个席位报告提到「必需知识包」里的 `src/context/project-memory-loader.ts`、`src/tools/recall.ts`、`.rivet/knowledge/manifest.md` 在本仓不存在（`src/` 下无 `context`/`tools` 目录）。本文不基于这些文件作任何断言。

### 12.1 补记（2026-11-01）：`DESIGN.md` 找回后的处置

v2 提交后，博士要求「找回 DESIGN.md」。过程与结果：

| 步骤 | 事实 |
|---|---|
| 全盘搜 `DESIGN*.md` | 命中 20 个，目标是 `C:\Users\Administrator\Desktop\error\PRTS-弃案文档-2026-10-31\DESIGN.md` |
| 章节核对 | `§5 分层记忆与索引化经验`、`§9 主动遗忘、撤销与备份契约`、`§10 自进化与评估契约`——与架构需求 L26/L235/L267 三处引用逐一吻合 |
| 归档依据核对 | 弃案目录 `README.md` 里 `DESIGN.md` 一行的判弃依据原文是「作为参考设计保留，按本文的模块划分重新取用」——**引用的是「保留」** |
| 现行清单核对 | `设计和计划\README.md` 的「在办主线」不含它；「已归档」确认 7 份于 2026-10-31 移出；**未指定继任文档** |

**三条实质修正**：

1. **§1.1 立论翻转**：从「文件缺席、需重新立法」改为「文件已找到、归档但有效」。
2. **§6.6 删除流程重写**：v2 早先的 `deleted_at_ms` 单一标记被 §9 直接否定（「不能用单个 `deleted=true` 代表所有副本已删除」），改为 §9 的六态流程，第一版裁掉 `EXTERNAL_PENDING`。
3. **§七 定位改变**：A/B/C/D 四条候选降级为复盘材料；选型依据是 §9，而 §9 与其中 D 同构。

**一处仍未解决的取舍**：§9 说「删除标记仅含执行防重灌所需的最小标识和版本，不保存已删正文」，但**未规定正文外置到 SQLite 表还是文件系统**。这正是 §十一 第 2 项（D vs D'）仍未定的原因。
