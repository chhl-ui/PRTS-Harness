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
| 主题目录 | **做最小计数视图**（v1 曾列为不做，错）；**表已建，写入路径未实现（2026-11-01 实测）** | 架构需求 L203 明写「元记忆 = 主题目录常驻工作区」，而 V1-15 正是元记忆验收。不做则 V1-15 无验收载体 |
| 情景摘要（大意） | **做最小一层**；**表已建，写入路径未实现（2026-11-01 实测）** | §5.3 L219「保存原话与大意」、L237「删除覆盖检索索引、关联图与派生摘要」，V1-06 原文也有「摘要中也不再出现」。不做则这三句全部不可测 |
| **纠正（`fact.corrected`）** | **应做，未做，也未判为不做** | V1-06 验收原文含「**纠正 3 条**」，宪章 C03「用户可查看、**纠正**、删除或停用记忆」。这是记忆主验收三个动作里的一个——对本格零设计，等于主验收缺 1/3 |
| 关系记忆 | 不做 | 服务 V1-05（情感），不是 V1-06 |
| 技能与经验 | 不做 | 服务 V1-09（进化） |
| 意图库 | 不做 | 服务 V1-14，可独立立项 |
| 关联图 | 不做 | §11 第 9 条明说第一版先做共现；且 V1-06 的删除穿透不依赖它 |

**v1 的错误**：把「主题目录」和「摘要」都划进不做，而 V1-06 的验收原文包含「摘要中也不再出现」、V1-15 的验收对象就是元记忆。等于把两个验收句变成不可测。v2 各补一个最小层——不是完整实现，是**让验收可判定**的最小载体。

**v2.5 更正（2026-11-01 实测）：上段的论证成立，但没落地。** 分清「表建了」与「可测了」——这是两件事，此前混为一谈：

| 格 | 表 | 写入路径 | 可测？ |
|---|---|---|---|
| 主题目录 | `mem_topics` 在 `schema.ts` 有 DDL | **零 `INSERT`**：`grep -rn "mem_topics" src/` 除 `schema.ts` 外只有 `store.ts` 的 `rebuildProjections` DELETE | 否 |
| 情景摘要 | `mem_summaries` 同上 | **零 `INSERT`**；`summary.generated` 只在 `types.ts` 的联合类型里 | 否 |
| 纠正 | 列有（`mem_facts.revision` / `retired_at_ms`） | **零写入点**；`fact.corrected` 只在类型与 `fold.ts` 的一句注释里 | 否 |

`fold.ts` 的实际分支只有四个：`fact.asserted` / `turn.recorded` / `memory.deleted` / `deletion.derivative-done`（其余 `default` 直接抛错）。所以 V1-15 与 V1-06 的摘要句**仍然没有验收载体**，v2 声称修好的问题没有修好，只是从「没设计」变成了「有表没路径」——后者更隐蔽，因为看 DDL 会以为做完了。

**处置未定**（需拍板）：三格各有两个选项——补写入路径（`fact.corrected` 事件 + 摘要生成 + 主题计数更新），或明确降级出第一版并写清 V1-06 / V1-15 的哪一句因此不可测。本轮只做诚实标注，不预设结论。

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
  scope          TEXT NOT NULL DEFAULT 'prts',    -- 作用域；第一版恒为 'prts'（见 §八 第 13 条守卫）
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
  scope          TEXT NOT NULL DEFAULT 'prts',
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
  scope          TEXT NOT NULL DEFAULT 'prts',
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
  scope          TEXT NOT NULL DEFAULT 'prts',
  target_json    TEXT NOT NULL,   -- {kind, id}
  derivatives_json TEXT NOT NULL, -- 待清派生项清单
  state          TEXT NOT NULL,          -- requested | purged-in-tx | external-pending | completed
  completed_scope TEXT,                  -- 'local-only'；有 external-pending 时必填
  completed      INTEGER NOT NULL DEFAULT 0,
  requested_at   INTEGER NOT NULL,
  completed_at   INTEGER
);
```

**为什么 `mem_deletions` 照抄 `audit_deletions`**：仓内已有这条路径（`src/audit/audit.ts` 建表 + `src/audit/fold.ts` 的 `deletion.derivative-done` 分支）。v1 写成 `cascade_json` 数组是自己的退化发明，四席一致指出，改。

**`provenance` 与 `confirmation_basis` 必须有组合约束**（2026-11-01 议事会指出）：两列不是重复，是两条不同关系——前者是**谁说的**，后者是**谁确认的**。但允许任意组合属 fail-open，SQL 层要加 CHECK：

```sql
CHECK (provenance IN ('stated','inferred')),
CHECK (confirmation_basis IN ('owner-stated','model-inferred','verifier')),
CHECK (NOT (provenance = 'stated' AND confirmation_basis = 'model-inferred'))
```

第三条是关键：**不能声称「博士明说」却由模型推断确认**。而 `(inferred, verifier)` 合法且必要——「我推断的，但校验器验过」正是元记忆最该有的一格，合并两列会把它丢掉（§八 第 14 条）。

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
  scope?: string                             // 第一版恒为 'prts'；缺省即 'prts'（见 §八 第 13 条守卫）
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

**v2.7 已换成混合（2026-11-01，实测驱动）**：本节下面的 LIKE 论证仍成立（它是当时唯一全场景可用的方案），但不再是最优解。s_cleaned（246,750 turn）上实测：

| 后端 | any@8 | all@8 | ms/题 |
|---|---|---|---|
| `LIKE` | 19.6% | 13.2% | 3,125 |
| FTS5 `porter unicode61` | 43.0% | 25.5% | 40 |
| FTS5 `trigram` | 45.1% | 27.1% | 96 |

分路依据是 **tokenizer 能力，不是查询语言**：`trigram` 对 >=3 字符有效（英文子串、中文 3 字以上），对中文 2 字（"镜头"）恒为 0；`unicode61` / `porter` 连中文 3 字都是 0，所以不用。中文 2 字由 `LIKE` 承担。

两路分数尺度不可比（bm25 越小越好 vs 命中词数越大越好），用 **RRF（Reciprocal Rank Fusion）排名融合**——这正是本节下文否决「三路分流」时担心的「计分口径不可比」的正面解法，而不是绕开它。每条命中带 `recallPath`（`'like'` / `'fts-trigram'`），口径可分项报。

**索引是投影，不是旁路缓存**：`mem_fts_turns` / `mem_fts_facts` 的 rowid 与投影表对齐，由 `fold.ts` 在同一事务内同步；`rebuildProjections` 先清索引再由事件重建。旧库升级时 `openMemoryDb` 做计数比对并自愈重建——否则 `CREATE VIRTUAL TABLE IF NOT EXISTS` 会建出空表，检索静默退回全表 LIKE（实测 10,960 turn 的旧库打开后 `recallPath` 全是 `'like'`，无任何报错）。

理由（四席指出，成立）：

1. **三路分流会产生三套不可比的计分口径**：FTS5 返回 BM25 分，`LIKE` 无分。同一批问题里一部分走 BM25、一部分走全表扫描，V1-17 的基线数字无法跨查询类型比较，「分数下降则不采用」这条规则失效。
2. **互斥路由有归属空洞**：混合查询（"optics 镜头"）、单字查询、非全词英文（"stat" 实测 unicode61 = 0）在 v1 的路由表里无归属，会静默返回空——而空结果在 `MemoryStore` 接口上与「记忆里真的没有」不可区分，直接污染 V1-15 的 abstention。
3. `LIKE` 在实测里是**唯一全场景可用**的方案（见 §5.3）。

代价必须写清：`LIKE` 无索引，全表扫描。第一版数据量（V1-06 的 10 条 + LongMemEval `_oracle` 的单会话历史）完全可承受；数据量上去后换后端。

**因此 `MemoryStore` 是接口而非具体实现**——后端可替换是设计的一部分，不是将来再说的优化。FTS5 作为可选后端保留，但**启用后基线必须重测、不能与 LIKE 基线混比**。

**排序（v2.3 更正）**：§6.1 的图画的是「相关 × 时近 × 重要性」，而本节此前的公式只有 `score = 时近衰减 × (0.5 + importance)`——**两处不一致，且公式里没有相关性项**。原因是真的：`LIKE` 是布尔匹配，不产生相关度分。

三处统一为：**`LIKE` 路径下相关度退化为「是否命中」，排序只用 `时近衰减 × (0.5 + importance)`**；§6.1 的图相应改为「命中过滤 × 时近 × 重要性」。这是已知退化，不是疏忽——换 FTS 后端后相关度分才存在，届时排序公式要重定、基线要重测。

**v2.4 更正（2026-11-01，实测推翻上一段）**：上一段把「无相关度分」当成可接受的退化，实测证明它不是退化，是失效。探针 `.scratch/probe-pure-recency.mjs` 在 LongMemEval 全库口径下（nq=479，K=8）三档对照：

| 排序规则 | R@8 | MRR |
|---|---|---|
| 纯时近衰减（上一段的规定，无任何相关性项） | **0.6%** | 0.0021 |
| 命中词数 × 时近衰减 × (0.5+importance)（实现现状） | **43.4%** | 0.2698 |

差 72 倍。原因是纯时近衰减把「最近但只命中一个无关实词」的行排在「较旧但命中多个查询词」的证据行之前，等于在命中集合里随机挑最近的——命中过滤本身不携带「命中得多好」的信息，而自然语言问句的命中集合通常有几百到几千行（全库口径平均 4113 行），只靠时间分层选 8 条必然落空。

**因此 v2.4 修订为**：`LIKE` 路径下**相关度 = 命中查询词的个数**（`CASE WHEN body LIKE ? THEN 1 ELSE 0 END` 求和），排序 = `相关度 × 时近衰减 × (0.5 + importance)`；§6.1 的图**保持原样**（「相关 × 时近 × 重要性」本来就是对的，当初错的是本节公式）。这不是引入 BM25 那样的连续打分，只是把「命中几个词」这个布尔计数的和当作离散相关度——`LIKE` 路径能提供的信息到此为止，再多的分需要换后端。

**候选截断必须带 `ORDER BY`（v2.4 新增硬约束）**：`LIMIT` 在 `ORDER BY` 之前生效，`LIMIT n` 而无排序等于「按扫描顺序随便取 n 行」。实测该缺陷让 R@8 从 43.4% 掉到 1.0%（候选 32 行口径）。SQL 层按相关度降序取候选、JS 层按乘积做最终排序，两层各司其职；回归用例 `test/memory/recall.test.ts` 钉住「命中词数高的行必须进候选且排前」。

**与架构需求 §5.3 五因子的对照（v2.5 补记，2026-11-01）**：§5.3 原文要求「综合时近性、重要性、与当前线索的相关度、与当前任务的相关度、关联扩散，计算一个排序」。逐项对账：

| §5.3 因子 | 本文第一版 | 说明 |
|---|---|---|
| 时近性 | 有 | `recency()`，半衰期 30 天 |
| 重要性 | 有 | `mem_facts.importance`（turn 无此列，退化为常数） |
| 与当前线索的相关度 | 有，**但是代理** | 用「命中查询词的个数」充当——`LIKE` 路径能提供的离散信息到此为止。**它是代理不是等价物**：命中 3 个虚词的片段会排在命中 1 个实词的片段前面，这是已知偏差 |
| **与当前任务的相关度** | **不做，本次补登记** | `MemoryQuery` 无任务上下文入参（只有 `text/limit/nowMs/includeOrigin/scope`）。此前既不在做也不在不做清单里，是沉默缺席。后果：检索不知道当前在做什么任务，只能按文本相似度排 |
| 关联扩散 | 不做 | §十 已登记（无关联图），有退化条款 |

沉默缺席比明说不做更危险：明说不做有退化条款可查，沉默缺席会让人以为做了。

**待验（v2.5 登记）：宪章 §五-3「旧记忆不得覆盖当前证据」没有对应规则。** 该原则的前半句有承载（`provenance` / `confirmation_basis` 的 CHECK 约束让「推断冒充明说」被库拒绝），后半句没有——检索**如何优先新值**未规定。上面的排序里 `recency` 只是乘法因子，当旧条目命中词更多时它会压过新条目。实测征兆：LongMemEval 的 `knowledge-update` 题型（78/500 题，专测「信息更新过」）在 24 题分层样本上得 **0.25**，失败样本正是「答成旧值」（问 5K 跑步个人最好成绩，gold 25:50，答 26:30 = 旧值）。这条不是靠调权重能确定的，需要先定义「更新」的判定依据（同 subject+predicate 的新事实？`valid_from_ms` 更晚？），再决定检索要不要对「已被取代」的条目降权。

**LIKE 必须转义通配符**：查询含 `%` 或 `_` 时语义会被改写（一条含 `%` 的提问会命中全表）。实现固定用 `LIKE '%' || ? || '%' ESCAPE '\'`，入参侧对 `\`、`%`、`_` 三个字符转义。**M8/M9 当前测不到这一点，要补一条含 `%` 的查询用例。**

权重是**可配置常数，初始不预设为「正确」**（§11 第 10 条：待基准与真实使用数据标定）。

**检索接口必须能返回 turn 级定位与 `recallPath`**——前者是 §4.3 的硬要求，后者是 V1-15 能判定的前提。

### 6.6 删除

V1-06 要求「删除 3 条，经核实全部生效，索引与摘要中也不再出现」。

`DESIGN.md` §9 对该流程有明确规定，其中一条**直接否定了本文 v2 早先的做法**：

> 「不能用单个 `deleted=true` 代表所有副本已删除。」

所以删除不是「置一个时间戳」，而是一条带状态与核验范围的流程。§9 给出六态：`REQUESTED` → `NEW_USE_BLOCKED` → `LOCAL_PURGING` → `LOCAL_PURGED` → `EXTERNAL_PENDING` → `COMPLETED_WITHIN_DECLARED_SCOPE`。

**前提更正（2026-11-01 议事会复评）**：v2.2 此前写「第一版无外部副本」，**这是错的**。实测 `src\cli\chat.ts:394` 为 `model: 'deepseek-chat'`，运行时经 `@deepseek-ai/dsh-llm` + `dsh-llm-deepseek-api-key` 调 DeepSeek API——**每次对话的 live 记忆正文都已经出境**。模型 API 就是外部副本，审计上不能假装它不存在。

能裁掉 `EXTERNAL_PENDING` 的合法前提**不是「无副本」，而是「删除流程对 live 数据的清除范围声明为 local-only」**。这条要升为不变量（§八 第 12 条），不能只留在表格的一行理由里。

**六态在 D 方案下的落地**：D 是单库单事务，`LOCAL_PURGING` 与 `LOCAL_PURGED` 之间**没有可观测的中间状态**——这正是 D 相对 D' 的真实收益（原子性），v2.2 没收这笔账。所以六态裁成**三态承载 + 三态日志语义**：

| `DESIGN.md` §9 六态 | 第一版承载 | 动作 |
|---|---|---|
| `REQUESTED` | `state='requested'` | 追加 `memory.deleted` 事件，写 `mem_deletions` |
| `NEW_USE_BLOCKED` | 与 `REQUESTED` 同一事务 | 撤销版本 +1；检索与导入立即排除该目标 |
| `LOCAL_PURGING` | 同一事务内，**不可观测** | 清 `mem_bodies.body`；级联摘要与主题目录 |
| `LOCAL_PURGED` | `state='purged-in-tx'` | 追加 `deletion.derivative-done` |
| `EXTERNAL_PENDING` | `state='external-pending'` | **保留**。live 正文经模型 API 出境，外部删不掉——如实记入回执 |
| `COMPLETED_WITHIN_DECLARED_SCOPE` | `state='completed'` | `completed=1`；**`completed_scope` 写 `local-only`** |

**为什么不能只用二值 `completed`**：v2.2 的 `mem_deletions` 只有 `completed INTEGER`，中间态没有承载列，崩溃后判定不出停在 `LOCAL_PURGING` 还是 `LOCAL_PURGED`。补 `state TEXT`。

**`completed` 由谁置**：照 `src\audit\audit.ts` 的 `afterWrite` 形态——derivatives 全部 done 且 `!completed` 时**自动收敛**，不是手工置位。§9 要求「失败可幂等接续」，手工置位做不到。

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
- **v2.2 漏了两条真正改变风险等级的开关**（2026-11-01 议事会指出，已核）：
  - **WAL**：仓内三处 `PRAGMA journal_mode = WAL`（`src\core\init.ts:13`、`src\ledger\ledger.ts:168`、`src\audit\audit.ts:168`）。正文置 NULL 后，旧页镜像还留在 `<db>-wal` 里直到 checkpoint 截断。**而 §9.1 的 M2b/M14 看的都是主库，测不到 WAL**——要补一条「删除后 checkpoint，再检查 WAL 文件」的用例。
  - **`secure_delete`**：全仓 `grep secure_delete` 零命中。打开它（`PRAGMA secure_delete = ON`）会让 DELETE 后的页被零填充，零成本的低档缓解。**第一版应打开，并写进 §八 不变量。**
  - **`auto_vacuum`**：同样零命中。它与 `secure_delete` 是两件事——前者回收空间、后者擦除内容。**第一版只需 `secure_delete`；`auto_vacuum` 要重建库才能改，不做。**
- 加上这两条后，D 的残留面从「主库自由页 + WAL」缩到「主库 + 已 checkpoint 的 WAL」。**「10 条规模用 D 足够」这句话此时才有依据**——v2.2 只写「自由页需 VACUUM」时，它其实是句没有支撑的话。
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
12. **live 数据的删除范围必须声明为 `local-only`**：模型 API 是外部副本（`src\cli\chat.ts:394`），`EXTERNAL_PENDING` 不可省略，`completed_scope` 必须写明。
13. **`scope` 守卫**：实现时加测试扫描 `SELECT DISTINCT scope`，断言全库恒为 1 个值（`'prts'`）。断言失败即说明多 scope 已入表——**那时 T04/T05 必须同时补上**。「第一版无越权面」靠这条测试守住，不靠文档里的前提。
14. **`provenance` 与 `confirmation_basis` 的组合必须在 CHECK 白名单内**：`(inferred, verifier)` 合法，`(stated, model-inferred)` 非法。**两列不合并**——合并会丢掉「推断但经校验器确认」这一格，而它正是元记忆最需要的。

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

**落盘状态核对（v2.5，2026-11-01 实测）**：上表 18 条里 6 条没有落地，分两类——「功能不存在」不能靠写测试补，必须先补实现：

| # | 状态 | 依据 |
|---|---|---|
| M3 纠正 1 条 | **功能不存在** | `fact.corrected` 无实现；`retired_at_ms` 无写入点 |
| M11 `readOnly` | **功能不存在** | `MemoryStore.open()` 只有单参，无 `readOnly` 选项；对比 `Ledger`/`AuditLog` 都有 |
| M16 摘要层级联删除 | **功能不存在** | `mem_summaries` 零 `INSERT`，无摘要可删 |
| M15 增量投影 vs rebuild | 功能有、测试未写 | `rebuildProjections` 已实现且 M13 覆盖删除态，但没做逐字段对比 |
| M8 中文 2 字「镜头」 | 功能应有、测试未写 | §6.5 用整节论证选 `LIKE`，而中文检索无一条测试 |
| M9 英文 optics / 前缀 stat / 混合 | 功能应有、测试未写 | 同上；这三条是「统一走 LIKE」决定的**唯一直接证据** |

M8/M9 的缺失比 M15 更值得优先补：它们验证的是一个选型的正确性，而选型文档（§6.5）已经写成了定论。用设计稿自己的话——「不做则这三句全部不可测」。另外 §6.5 已注明 LIKE 转义「M8/M9 当前测不到」，实际整个 M8/M9 都不存在。

### 9.2 反证（瑶光式）

| 反证 | 做法 | 必红依据 |
|---|---|---|
| R1 | 删掉检索的 `deleted_at_ms IS NULL` 过滤，重跑 M2 | M2 必红 |
| R2 | 把 `provenance` 从检索输出去掉，重跑 M4 | M4 必红 |
| R3 | 删除时只清投影不清 `mem_bodies`，重跑 M2b | M2b 必红（**v1 缺这条，M2 抓不到「检索路径恰好没走那条分支」的情况**） |
| R4 | `rebuildProjections` 里跳过 `memory.deleted` 分支，重跑 M13 | M13 必红 |
| R5 | 让 `origin` 默认包含 benchmark，重跑 M4b | M4b 必红 |

### 9.3 基准基线（V1-17）

**判分口径（v2.5 补记，2026-11-01）**：`Accuracy` 的分母**只含有效判定**——判分器没按 `yes` / `no` 格式回答时返回 `invalid`，不计入分母，并单独报出条数。

这条与宪章 §六「不得事后改变分母以获得通过」表面冲突，依据必须写清以免后人误改：

- `invalid` 不是「困难样本」，是**判分器没产出判定**。把它计成 0 分等于把「判分器不听话」记成「模型答错」，两层噪声混成一个数字，之后再也分不开。
- 校准前的实现正是这么做的（`append(1 if label else 0)`），而 `parse_verdict` 的 docstring 从一开始就写着「None=invalid（不进分母）」——这是实现违反自己的契约，不是口径调整。
- 合规判据是**分母变化必须可观测**：输出同时给 `n=<valid> valid` 与 `<invalid> invalid`，invalid 率作为独立指标盯住。只报 Accuracy 而不报 invalid 数，才构成违宪章。
- 实测：2026-11-01 的 24 题分层样本重判后为 `n=24 valid, 0 invalid`，准确率 0.2083 未变——本次修正没有改变任何结论。

**基线的两条线必须分开报（v2.6 更正，2026-11-01）**

此前本文只报一个数字 0.3760，并把「检索层 R@8 43.4%」当作检索能力。**这是设置错配**：`longmemeval_oracle.json` 的官方定义是「history 里**只含证据会话**」（README 原文 "Only the evidence sessions are included in the history"），它是 **reading 测试集**，不是 retrieval 测试集。在它上面做 top-8 检索，等于先被官方筛一遍、自己再筛一遍——数字既不是检索能力，也不是阅读能力。

| 数据集 | 每题 turn（中位） | 总 turn | 用途 |
|---|---|---|---|
| `longmemeval_oracle.json` | **24** | 10,960 | 测 reading（证据已筛好） |
| `longmemeval_s_cleaned.json` | **491** | **246,750** | 测 retrieval + reading |

两档已核实为官方 HuggingFace `xiaowu0162/longmemeval-cleaned` 的当前版本：oracle **15,388,478 字节**（与本地一致），s_cleaned **277,383,467 字节**（已下载）。`longmemeval_m_cleaned.json` 2,737,100,077 字节未拉。

### 线一：reading（oracle，整段 haystack 全给 reader）

| 项 | 值 |
|---|---|
| 准确率 | **0.5640** |
| judged_by | `deepseek-reasoner`（被测 `deepseek-chat`） |
| 样本 | n=500 valid / 0 invalid |
| 输入形态 | 整题 haystack 全放 prompt（截断上限 80 turn，实际 0 题触发），每条前缀会话时间 + 给出 `question_date` |

| 题型 | 准确率 | n |
|---|---|---|
| single-session-assistant | **1.0000** | 56 |
| single-session-user | 0.8714 | 70 |
| knowledge-update | 0.6923 | 78 |
| temporal-reasoning | 0.4586 | 133 |
| multi-session | 0.3534 | 133 |
| single-session-preference | 0.1000 | 30 |

对照同一份数据上「top-8 检索」的 0.3760：**全给比检索高 18.8pp**。分型差异最大的是 temporal-reasoning（0.1880 → 0.4586）与 single-session-user（0.6286 → 0.8714）。**single-session-assistant 满分 1.0000** 说明「单证据 + 短会话」这条链路已经完全通。

**single-session-preference 全给反而更差（0.1333 → 0.1000）**，且在 s_cleaned 上检索 any@K 恒为 0——这类题的 gold 是「用户偏好描述」，问题却是「你能推荐些资源吗」，字面上不可能重叠。它需要的是**把偏好抽取成 `mem_facts` 再检索事实**，不是改进 turn 检索。

### 线二：retrieval（s_cleaned，每题 491 turn / 48 sessions）

**v2.6 首次实测（纯 `LIKE`，换后端之前）**

| 题型 | n | any@8 | all@8 | any@32 | all@32 | MRR |
|---|---|---|---|---|---|---|
| knowledge-update | 72 | 48.6% | 25.0% | 61.1% | 36.1% | 0.3021 |
| single-session-assistant | 56 | 48.2% | 48.2% | 71.4% | 71.4% | 0.3083 |
| single-session-user | 64 | 23.4% | 23.4% | 40.6% | 39.1% | 0.1356 |
| multi-session | 125 | 8.0% | **0.0%** | 14.4% | 4.0% | 0.0281 |
| temporal-reasoning | 132 | 5.3% | 2.3% | 18.9% | 5.3% | 0.0237 |
| single-session-preference | 30 | **0.0%** | 0.0% | **0.0%** | 0.0% | 0.0000 |
| **加权** | 479 | **19.6%** | **13.2%** | ≈32% | ≈21% | — |

**v2.7 换成混合检索后（FTS5 trigram + LIKE 兜底 + RRF 融合）**

**注意：`b8e5a9c` 的提交信息写了「19.6%→45.1%」，那是纯 FTS 探针的数字，不是实现的。
真实实现是 36.9%——差异来自最终排序里乘了 `recency × importance`，稀释了 bm25 的名次。
以本表为准。**

| 题型 | n | any@8 | all@8 | any@32 | all@32 | MRR | ms/题 |
|---|---|---|---|---|---|---|---|
| knowledge-update | 72 | 61.1% | 37.5% | 68.1% | 51.4% | 0.4311 | 491 |
| single-session-assistant | 56 | 58.9% | 58.9% | 60.7% | 60.7% | 0.3310 | 875 |
| single-session-user | 64 | 45.3% | 45.3% | 59.4% | 59.4% | 0.2031 | 259 |
| temporal-reasoning | 132 | 29.5% | 10.6% | 47.7% | 19.7% | 0.1100 | 424 |
| multi-session | 125 | 24.8% | 6.4% | 45.6% | 14.4% | 0.1223 | 397 |
| single-session-preference | 30 | 3.3% | 3.3% | 3.3% | 3.3% | 0.0083 | 836 |
| **加权** | 479 | **36.9%** | **23.4%** | 47.7% | 29.7% | — | **484** |

**增量（LIKE → 混合）**：any@8 19.6% → 36.9%（**+17.3pp / 1.88 倍**），all@8 13.2% → 23.4%，
耗时 3,125 ms → **484 ms/题**（快 6.5 倍，进入 V1-16 的 1 秒预算内，但余量只剩一半）。
分型最大受益者是 temporal（5.3% → 29.5%，+24.2pp）与 multi-session（8.0% → 24.8%，+16.8pp）。

**v2.8：recency 改成轻加成后的实测**

`score = recency × ...` 改成 `1 + 0.1 × recency`（`RECENCY_WEIGHT`）。同一 s_cleaned 基准：

| 指标 | v2.7（乘性 recency） | v2.8（轻加成） |
|---|---|---|
| any@8 加权 | 36.9% | **38.8%** |
| all@8 加权 | 23.4% | 23.4% |
| temporal any@8 | 29.5% | **35.6%** |
| temporal MRR | 0.1100 | **0.1900** |
| knowledge-update MRR | 0.4311 | 0.4687 |
| single-session-assistant MRR | 0.3310 | 0.3775 |
| 耗时/题 | 484ms | 543ms |

**MRR 全面提升而 any@8 只涨 1.9pp**：排序质量（证据排到更前）明显改善，但
「证据能不能进 top-8」主要由候选层决定，调排序动不了它。对端到端 QA 的
影响尚未验证。

**仍未解释的 6.3pp 差距**：纯 FTS 探针 any@8 = 45.1%，实现在此改动后 38.8%。
探针与实现在 token 过滤、MATCH 串、候选宽度（32）上逐项核对一致，且 benchmark
库里 `mem_facts` 为空、recency 对 2023 年数据的扰动已降到 ±0.3%，理论上 top-8
应当同序。**差异原因待查，不猜**。怀疑点：RRF 的 Map 累积顺序、fact 查询侧的
空结果处理、`includeOrigin` 过滤的差别。

**新破线**：`single-session-assistant` 达 **1015ms/题**，越过 V1-16 的
「P95 ≤ 1 秒」。之前是 875ms，余量本来就薄，负载一波动就破线。

三处仍待优化，都已有数据支撑：

1. **纯 FTS 探针能到 45.1%，实现只有 36.9%**。差在最终排序 —— `rrf × recency × importance`
   里 recency 是乘性因子，会把 bm25 名次靠前但时间久远的证据压下去。下一步应把 recency
   改成轻加成（如 `1 + 0.1 × recency`）而不是乘性权重，然后用同一基准量化。
2. **耗时 484ms 里 `single-session-assistant` 要 875ms**，查询词多的题会接近 1 秒线。
   RRF 只取 `limit*4` 候选，可考虑降到 `limit*2` 观察效果是否稳定。
3. **`single-session-preference` 仍只有 3.3%**，any@K 不随 K 增长 —— 印证它必须靠
   fact 抽取（把偏好落成 `mem_facts`），不是检索问题。

**事实抽取的上界实验（2026-11-01，v2.9）**

议事会要求的「最便宜 kill-switch」：既然 preference 题在原文检索上恒为 3.3%，那**把
gold 答案直接以 fact 形式放进库里**，能检索到吗？纯检索层实验，不调模型、秒级。

| 方案 | any@8 | any@32 |
|---|---|---|
| 当前 turn 检索 | 3.3% | 3.3% |
| **fact-oracle**（30 条 gold answer 直接 `assertFact` 入库） | **86.7%** | **100%** |

**差 26 倍，结论决定性**：瓶颈不在检索层，在**抽取层**。只要偏好以事实形式存在，检索
几乎总能找到——30 题里 26 题进 top-8、30 题全部进 top-32。

一个反直觉的细节：30 题里「问题与 gold answer 零词重叠」的只有 2 题，且这 2 题都被召回
了——靠的是 trigram 子串匹配（`recommend` 是 `recommendations` 的子串）。所以此前
「字面上不可能重叠」的推断也不完全对：长句措辞会自然共享词根，真正缺的是「答案根本没
被抽成事实」这一步。

**这个数字的边界必须说清**：fact-oracle 用的是 **gold answer 全文**作 object，真实抽取
只能从对话原文里抽，抽不出这种规范表述。**86.7% 是上界，不是预期值**；实际能拿到多少
取决于抽取质量，那是下一个问题。把上界当预期会把整个方向建立在沙上。

**旧记录（保留作对照，勿再引用为基线）**

| 题型 | n | any@8 | all@8 | any@32 | all@32 | MRR |
|---|---|---|---|---|---|---|
| knowledge-update | 72 | 48.6% | 25.0% | 61.1% | 36.1% | 0.3021 |
| single-session-assistant | 56 | 48.2% | 48.2% | 71.4% | 71.4% | 0.3083 |
| single-session-user | 64 | 23.4% | 23.4% | 40.6% | 39.1% | 0.1356 |
| multi-session | 125 | 8.0% | **0.0%** | 14.4% | 4.0% | 0.0281 |
| temporal-reasoning | 132 | 5.3% | 2.3% | 18.9% | 5.3% | 0.0237 |
| single-session-preference | 30 | **0.0%** | 0.0% | **0.0%** | 0.0% | 0.0000 |
| **加权** | 479 | **≈19.6%** | **≈13.2%** | ≈32% | ≈21% | — |

**这是第一个真正的检索基线**。此前所有「R@8 43.4%」的讨论都高估了 2.2 倍——那个数字是在已筛过的 24 turn 上测的。

三条结论直接改变优先级：

1. **占用 266 题（53%）的 temporal / multi-session 检索几乎全失**（any@8 5.3% / 8.0%，multi-session 的 all@8 是 **0.0%**）。这两类不是「排序差一点」，是根本捞不出来。
2. **扩 K 的收益有上限但不小**：any@8→any@32 提升 2–3 倍，仍只有 14–19%。所以扩 K 值得做，但它不是解法。
3. **single-session-preference 在任何 K 下都是 0.0%**——检索对它无效，只能靠 fact 抽取。

### LIKE 全表扫描的规模上限（填 §十一 #5 的空白）

246,750 turn 的库上，`MemoryStore.search()` 平均 **3,125 ms/题**（分型 2,085–5,400 ms）。V1-16 要求「工作区装配（含检索）P95 不超过 1 秒」——**当前实现超预算 3 倍以上**。导入 246,750 turn 耗时 553 秒。

这不是「数据量上去后」的将来问题，是现在就已经发生的。换检索后端从「优化」变成「V1-16 的硬前置」。

**旧记录（保留作对照，勿再引用为基线）**

**首次全量基线（2026-11-01，V1-17 达成）**

| 项 | 值 |
|---|---|
| 准确率 | **0.3760** |
| judged_by | `deepseek-reasoner`（被测 `deepseek-chat`） |
| 样本 | 全量 500 题，`n=500 valid` / **0 invalid** |
| 基准文件 | `C:\prts-benchmark\longmemeval\longmemeval_oracle.json`，**15,388,478 字节** |
| 代码版本 | commit `79f7374`（`src/` 部分来自其父 `e6b8acc`；本提交补上评测脚本，二者合计才是跑出该数字的完整代码状态） |
| 检索形态 | LIKE + 分词 + 停用词；SQL 按 `hit_count DESC` 取候选（`LIMIT limit*4`，**带 ORDER BY**）；JS 层按 `相关度 × 时近 × 重要性` 取 top-8；prompt 带 `question_date` 与每条 excerpt 的原始时间串 |
| 口径 | **全库池**——500 题的 haystack 全部导入一个库（10960 turn）后全局检索，**不是**每题隔离 |

分型：

| 题型 | 准确率 | n |
|---|---|---|
| single-session-assistant | 0.8393 | 56 |
| single-session-user | 0.6286 | 70 |
| knowledge-update | 0.6026 | 78 |
| temporal-reasoning | 0.1880 | 133 |
| multi-session | 0.1579 | 133 |
| single-session-preference | 0.1333 | 30 |

**引用的完整形态**：「V1-17 基线 **0.3760**（judged_by=deepseek-reasoner，全库池口径，n=500，ref 15,388,478 字节）」。缺任一项都不是完整陈述。

**与 24 题分层样本的 0.2083 / 0.2500 不可并列比较。** 分层抽样每型只取 4 题，恰好把两个表现最好的题型（single-session、knowledge-update）压到 4 题，同时把两个最弱的题型各放 4 题全错——24 题报的是「最弱题型的准确率」，不是总体。这也正面验证了议事会的警告：**分型 4 题量级只能用于定位失败模式，不能报数字**。

**两个最弱题型合计 266 题（53%）决定总体**：temporal-reasoning 0.1880、multi-session 0.1579。前者缺完整时间推理（excerpt 只带会话级时间，题目要跨事件算天数差），后者受 top-8 容量限制——跨会话计数题需要更多证据条。这两项是下一轮的定向目标，不是调 prompt 能解决的。

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
| 正确答案 | yes | YES |
| 故意答「I do not know」 | no | no |
| abstention 题正确识别为不可答 | yes | YES |
| 另一道正确答案 | yes | YES |

Accuracy 0.75（4 题 3 对），与构造时的预期一致。

**但这组对照的区分力是零**（2026-11-01 议事会指出，核实成立）：一个**恒答 YES 的退化判分器**在这个测试上同样得 0.75。它证明的只是「判分器能对明显正确的答案说 yes、对明显错误的答案说 no」，**不证明判分器与人工判断一致**。

模型评测领域的标准做法是三步（MT-Bench / Chatbot-Arena 一脉、JudgeBench 这类元评测）：先测与人工标注的**一致率**，再分别度量 position / verbosity / self-enhancement 三类**偏差**，最后对 judge 本身跑**变异反证**。PRTS 现在只做了第一步的最弱形式。

**顺序也要改**：v2.2 把「人工抽样复核」放在基线之后，等于先测量后校准——届时唯一结果是基线必须重测。**校准必须前置于基线。**

脚本已加 `--always-yes` 对照：对同一批题同时输出判分器分数与恒 YES 基线，**两者差值才是判分器的区分度**。基线数字必须与这个差值一起报。

**再补一条更根本的局限（本轮实测发现）**：脚本打印的 `Accuracy` 实为 **YES 率**，不是准确率——公式是 `判 yes 的条数 / 总条数`，原脚本也如此。在真实模型输出上两者近似（答案对错未知，yes 率就是估计）；**但在人工构造的校准集上，YES 率 ≠ 准确率**。

实测证据：4 题测试集（3 个正确答案 + 1 个故意错误）+ `--always-yes` → 报 **1.0000**，而它的真实准确率应为 **0.75**。所以「恒 YES 基线 1.0 vs 判分器 0.75」这个差值**不是区分度**，是同一个指标在两批 hyp 上的值。

要做真正的区分度度量，必须**手工计算准确率**（与人工标注的真值对比），或改用「判分器判定 vs 人工标注」的一致率。**这条在基线阶段必须补，否则 V1-17 的数字报出去就是错的。**

**这是判分器管道验证，不是基线成绩。**

### 9.4 判分器校准（2026-11-01，首轮）

用 `calib-pos.jsonl`（标准答案，应判 yes）/ `calib-neg.jsonl`（跨题型错配答案，应判 no）各 24 题跑判分器。

| | 判 yes | 判 no | invalid |
|---|---|---|---|
| POS（应 yes，24） | 20 | 4 | 0 |
| NEG（应 no，24） | 0 | 24 | 0 |

混淆矩阵 **TP=20 / FN=4 / FP=0 / TN=24**：真准确率 0.9167、精确率 1.0000、召回率 0.8333、特异度 1.0000。

**4 个 FN 全是 `single-session-preference` 题**（`8a2466db` / `06878be2` / `75832dbd` / `0edc2aef`）。judge 原话是干净的 `No` / `no`，`finish_reason=stop`——**不是判分器故障**。

原因：preference 题的 `answer` 字段本身就是**评分 rubric**（"The user would prefer responses that suggest…"）。把它原样当 model response 提交，judge 判定「这是复述要求，不是真实回答」，判 no 合理。**这类题的校准不能用「答案逐字复制」构造。**

**排除 preference 后的 5 个题型（20 正 + 20 负）= 40/40 全对。**

**这个数字能说明什么、不能说明什么**：

- 能说明：判分器能把「正确」与「完全离题」分开，三态判定与管道按预期工作。
- **不能说明**：它能不能分辨「近似错误」——数值差一位、同题的另一选项、部分正确。本轮的负样本与题干零 token 共享（24 条里只有 6 个不同字符串、每个复用 4 次），任务实际退化成「离题检测」。

**子代理对抗审查发现、已修的脚本缺陷**：

| 缺陷 | 修法 |
|---|---|
| `'yes' in text.lower()` 子串匹配双向误判 | 改 `re.match(r'^\W*(yes\|no)\b')` + 三态；匹配不到记 `invalid` 不进分母 |
| `max_tokens=1024` 被 reasoning 吃光 → 空 content 静默判 no | 提到 8192；读 `finish_reason`，`length` 或空 content 记 invalid 并重试一次 |
| 循环结束才一次性落盘，中途崩溃全丢 | 改逐题 write + flush |
| `'_abs' in qid` | 改 `endswith('_abs')` |
| 未知 `question_type` 抛 `NotImplementedError` 中断整批 | 回退通用模板 + stderr 告警 |

**验证**：`parse_verdict` 七个用例全过，含旧版两个误判模式（`"The response is correct."` 与空 content）现在返回 `None`。

**仍未解决**：`calib` 集 24 题含 **0 道 abstention**（该分支零覆盖）；负样本缺乏「近似错误」；每型仅 4 题，Wilson 95% CI 约 [0.51, 1.00]，统计功效不足以分辨题型间差异。

### 9.5 第二轮校准（2026-11-01，重造校准集）

首轮的问题被两个子代理指出后重造：负样本不再是「离题」，而是**同题干扰项**与**数值近似**；正样本不再是**标准答案逐字复制**，而是**同义改写**。

`scripts\calibrate-judge.py`：生成用 `deepseek-chat`，判分用 `deepseek-reasoner`。

| 变体 | 怎么造 | 应判 | n | 判对 |
|---|---|---|---|---|
| `paraphrase` | 同义改写，同一事实不同措辞 | yes | 20 | 20 |
| `nearmiss` | 数值差一位 / 实体换成同题干扰项 | no | 20 | 20 |
| `partial` | 提到主题但省略关键事实 | no | 20 | 19（1 条标签错） |
| `offtopic` | 流畅但完全离题 | no | 20 | 20 |
| `abs-refuse` | abstention 题如实说不知道 | yes | 4 | 4 |
| `abs-fabricate` | abstention 题硬编 | no | 4 | 0（4 条标签错） |

**初判有 5 个 FP，逐条核实后全部是标注错误，不是判分器误判**：

| 案例 | 我的标签 | 实际情况 |
|---|---|---|
| `gpt4_2312f94c [partial]` | no | hypothesis 是「You got the Samsung Galaxy S22.」，gold 就是 `Samsung Galaxy S22`——**partial 被生成成与标准答案等价**，应判 yes |
| 4 条 `abs-fabricate` | no | 构造代码 `f"It was {a[:60]}"` 假设 abstention 的 `answer` 是「应该给的答案」，实际它是**为什么无法回答的解释**——造出来的是正确拒答，应判 yes |

修正标签后：**TP=29 / FN=0 / FP=0 / TN=59，真准确率 1.0000，n=88**。

**这个 1.0 能说明什么、不能说明什么**：

- 能说明：判分器在「同义改写」「同题近似错误」「部分正确」「完全离题」「正确拒答」「错误硬编」六种形态上都没有误判。**这是首轮那个「只能分开离题」的版本给不出的结论。**
- **不能说明**：
  1. **校准集是 DeepSeek 生成的**。生成器（`deepseek-chat`）与判分器（`deepseek-reasoner`）同供应商，可能系统性地造出「同族模型都容易判对」的样本。
  2. 生成样本的分布 ≠ 真实模型输出的分布。PRTS 自己的错误形态还没被观察过。
  3. 88 条仍是小样本。

**过程教训（已记在脚本头注释里）**：`nearmiss` 生成器有可能把正确答案也包进去——抽查发现一条 `"…before the 'Data Analysis with Python' webinar"` 直接包含了 gold。**生成后必须人工扫一遍，不能直接信任生成器给的标签。**

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
- **不做「与当前任务的相关度」**（v2.5 补登记）。§5.3 五因子之一，`MemoryQuery` 没有任务上下文入参。此前属于**沉默缺席**（既不在做也不在此清单），现在明说：第一版检索不知道当前任务，只按文本线索排。代价——同一句话在不同任务下检索结果完全相同，无法偏向当前目标。解冻条件：上下文装配器落地并能把当前目标传进 `MemoryQuery`。
- **不做纠正（`fact.corrected`）—— 这条不是决定，是未做**（v2.5 标注）。V1-06 验收原文含「纠正 3 条」，宪章 C03 写明用户可纠正记忆，见 §二。列在此处只为让人一眼看到它**不在**第一版实现里，**不得**被读成「已判为不做」。
- **不做规则抽取（2026-11-01 实测排除）**。曾经打算用正则抽 `I prefer X` / `my X is Y` 这类句式作模型抽取的下界对照，实测否决：30 题 `single-session-preference` 共 44 条证据 turn，规则只命中 **7 条（15.9%）**，覆盖 **7/30 题（23.3%）**。漏掉的是关键部分——gold 要「Sony-compatible accessories」的那题，证据是 “compatible with my Sony A7R IV”，没有偏好动词但信息完整；另有 `I also like`、`I'd love` 这类变体不在规则集内。**偏好不是以「我偏好 X」的句式表达的**，它散落在提问、需求描述与设备型号里。补规则能把命中率抬到某一档，但天花板明显低于模型抽取，且把成本从「调用费」换成「维护费」。**结论：抽取必须用模型，规则层跳过。**

## 十一、遗留与待决

| # | 项 | 性质 |
|---|---|---|
| 1 | ~~`DESIGN.md` 缺席~~ **已解决（2026-11-01）** | 文件在 `C:\Users\Administrator\Desktop\error\PRTS-弃案文档-2026-10-31\DESIGN.md`（33,743 字节，16 章）。`§5`/`§9`/`§10` 与架构需求 L26/L235/L267 引用逐一吻合。状态是「归档但有效」。**已移回 `设计和计划\`（2026-11-01），逐条处置见同目录 `PRTS-DESIGN-03-CONTRACTS-2026-11-01.md`** |
| 2 | ~~删除路线选 D 还是 D'~~ **已定（2026-11-01）：走 D** | `mem_bodies` 表外置正文，删除置 NULL。理由：V1-06 的 10 条规模用 D 足够；D' 会把事务边界从单库扩到「库 + 文件系统」，代价超过收益。**D 的边界已写在 §7.2**：自由页残留需 VACUUM，不等于物理不可恢复。要真正不可恢复时升级 D' |
| 3 | ~~判分用 OpenAI 还是 DeepSeek 改写~~ **已定（2026-11-01）：DeepSeek** | 脚本 `scripts\eval-longmemeval.py` 已落盘并实测（4 题对照全判对）。判分用 `deepseek-reasoner` 与被测 `deepseek-chat` 区分；`judged_by` 写进每条记录。已知偏差见 §9.3 |
| 4 | ~~基准版本锁定与数据入库位置~~ **已定（2026-11-01）** | 数据落 `C:\prts-benchmark\<dataset>\`（独立根，不入 protectedRoots / workspaceRoots）。`longmemeval_oracle.json` 已下载并锁定 **15,388,478 字节 / 500 题**；基线数字必须与字节数一起记录 |
| 5 | `LIKE` 全表扫描的规模上限 | **已实测（2026-11-01）**：246,750 turn 上平均 **3,125 ms/题**（2,085–5,400），超 V1-16「装配含检索 P95 ≤ 1s」3 倍以上；导入 246,750 turn 耗时 553s。结论：**不是将来问题，是当前就超预算**，换后端是 V1-16 的硬前置。基线见 §9.3 线二 |
| 6 | `retired` / `deleted` 的保留期与清理策略 | 未定；参考 spill 的单会话上界思路 |
| 7 | 关系记忆 / 技能经验 / 意图库 / 关联图 | 各自立项 |
| 8 | Letta / Generative Agents / Graphiti 三个补拉 | `memory-landscape.md` §五 已排，本文不阻塞 |
| 9 | `DESIGN.md` §5 的 4 列未落表 | **解法已定（2026-11-01），落码时补**：`revision`（与 K1 同构，每次事实变更递增）、`确认依据`（`owner-stated` / `model-inferred` / `verifier`）、`适用条件`（可空文本，事实成立的前提）、`保留类别`（`permanent` / `retirable` / `clearable`，对应 §9 三档） |
| 10 | **T04/T05 重新判定**（2026-11-01 议事会复评推翻 v2.2 结论） | v2.2 说「第一版不适用」**不成立**：§6.2 的四张投影表**都没有 `scope` 列**（实测 grep 计数全为 0），`MemoryQuery` 也没有——scope 从投影层就丢了，这是**未实现**不是不适用。已补：投影表与 `MemoryQuery` 加 `scope`，§八 第 13 条加守卫测试。**T04**（跨项目对象 ID 读取）确实无对象，等引入多 scope 时启用；**T05 的「大小写别名碰撞」与 scope 无关，必须补测**，且 `fact_id` 的构造规则本文未定义——这是缺口 |

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

**一处仍未解决的取舍**：§9 说「删除标记仅含执行防重灌所需的最小标识和版本，不保存已删正文」，但**未规定正文外置到 SQLite 表还是文件系统**。这条已在 2026-11-01 定为 D（SQLite 表），见 §十一 第 2 项。

### 12.2 第二轮复评（2026-11-01，v2.2 → v2.3）

四席复评 v2.2，六条待审项全部有回应。**其中两条推翻了我上一轮下的判断。**

| 意见 | 来源 | 核实 | 处置 |
|---|---|---|---|
| 「第一版无外部副本」前提错误：模型 API 就是外部副本 | 天权 / 天府 / 瑶光 / 天璇（四席一致） | 成立：`src\cli\chat.ts:394` = `model: 'deepseek-chat'`，运行时经 `dsh-llm` + `dsh-llm-deepseek-api-key` 调 DeepSeek | **已改**：§6.6 前提更正，`EXTERNAL_PENDING` 保留，`completed_scope` 写 `local-only`；§八 第 12 条 |
| 四张投影表全无 `scope` 列，T04/T05 不是「不适用」而是「未实现」 | 天府 | 成立：四表 grep `scope` 计数全为 0；`MemoryQuery` 也无 | **已改**：四表 + `MemoryQuery` 补 `scope`；§八 第 13 条守卫；§十一 #10 推翻重写 |
| 排序公式无相关度项，与 §6.1 的图矛盾 | 天权 | 成立：§6.1 写「相关×时近×重要性」，§6.5 只有 `时近 × (0.5+importance)` | **已改**：三处统一为「命中过滤 × 时近 × 重要性」 |
| v2.3 的「命中过滤 × 时近 × 重要性」排序规则 | 天枢（v2.4 实测） | 成立但方向错：纯时近衰减排序 R@8=0.6%，等于随机；命中过滤不含「命中得多好」 | **已改 v2.4**：相关度 = 命中词数，§6.1 的图恢复「相关×时近×重要性」；并新增「候选截断必须带 ORDER BY」硬约束 |
| LIKE 未转义 `%` / `_` | 天府 / 天璇 | 成立：文档无转义规定 | **已改**：§6.5 加 `ESCAPE` 规定，§九补用例 |
| D 的残留面漏了 WAL 与 `secure_delete` | 天璇 | 成立：三处 `journal_mode = WAL` 实测；`secure_delete`/`auto_vacuum` 全仓零命中 | **已改**：§7.2 补两条，§八 第 15 条要求 `secure_delete = ON` |
| `mem_deletions` 只有 `completed` 二值，中间态无承载 | 天权 | 成立 | **已改**：加 `state` 列，六态裁为三态承载；`completed` 由 `derivative-done` 自动收敛 |
| `provenance` 与 `confirmation_basis` 无 CHECK 属 fail-open | 天府 / 天璇 | 成立 | **已改**：§6.2 加三条 CHECK；**不合并**（合并会丢 `(inferred, verifier)` 一格） |
| 4 题对照零区分力，恒 YES 同样得 0.75 | 天璇 | 成立，**且比它说的更糟**：脚本的 `Accuracy` 是 YES 率不是准确率，`--always-yes` 实测报 1.0 | **已改**：§9.3 三段补充；脚本加 `--always-yes` 与带 tag 的输出名 |
| 判分脚本输出名不含 sample/ref，`--sample 5` 会覆盖全量基线 | 天璇 | 成立 | **已改**：文件名改为 `<hyp>.eval-results-<model>-<sample>-<ref>` |
| T05 的「大小写别名碰撞」与 scope 无关，`fact_id` 构造规则未定义 | 瑶光 | 成立 | **已改**：§十一 #10 单独点名 T05 必须补测 |

**两处推翻**：C2（无外部副本）与 C4（T04/T05 不适用）——这两条都是我在 v2.2 里下的判断，本轮被证伪。

**一处比议事会说得更严重**：判分器的 `Accuracy` 是 YES 率而非准确率，`--always-yes` 实测报 1.0 就是证据。

**仍未做**：`--always-yes` 与真实判分的差值当前无意义（同一指标、两批 hyp），真正的区分度要人工标注真值后手工计算。
