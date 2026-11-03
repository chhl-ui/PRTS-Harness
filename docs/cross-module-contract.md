# 跨模块契约最小集

状态：v2（经议事会一轮审查修订）。2026-10-31。适用于 K1 账本、K4 审计、K2a 授权，以及将来的记忆 / 上下文 / 进化层。

只定**写进数据结构就难改**的条目。检索权重、装配策略等参数留到有实测数据时再定。

**规范依据在仓内**：文中 §5.3 / §5.4 / §10 / §11、V1-16 / V1-17 / V1-18 均出自 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md`（版本 0.7，0.5 定稿于 2026-10-30、0.7 修订于 2026-11-03，sha256 记在该文件头部）。仓外正本是 `C:\Users\Administrator\Desktop\设计和计划\PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md`——那边编辑，仓内副本逐字同步，同步后更新副本头部的 sha256，不就地编辑。

---

## 1. 标识体系

| ID | 归属 | 格式与约束 |
|---|---|---|
| `taskId` | K1 | 品牌类型 `string & {__brand:'TaskId'}`（`types.ts:3`） |
| `sessionId` | **prts 调用方生成，DSH 只透传** | 必须随机源（randomUUID / ULID）；**禁止时间戳** |
| `callId` | DSH 工具调用 | **全局唯一**（见下） |
| `memoryId` | 记忆层（未实现） | 品牌类型，命名空间独立 |

**sessionId 有三个来源，现状不一致**：

1. `src/cli/chat.ts:128` — `prts-chat-${Date.now()}`
2. `test/support/drive.ts:18` — `randomUUID()`
3. `src/runtime/start.ts:108` — `exec.agent?.session?.id ?? ''`（从 DSH 取，取不到给空串）

第 1 种的两种失败模式：同毫秒启动两个进程会碰撞；NTP 回拨会让新会话复用历史 sessionId。第 3 种更麻烦——空串传到 `authority.ts:170-173` 会 `raise('INVALID_INPUT')`，经 `start.ts` 的 catch 变成一句拒绝理由，表现为「DSH 没给 session.id 时所有 fs 调用都被静默拒绝」。**实现 K1 入口时一并修**：生成改用随机源；空 sessionId 显式失败（错误码含 `SESSION_ID_MISSING`），不走通用非空校验。

**callId 唯一性是硬要求**：`audit_once.call_id` 是 PRIMARY KEY（`audit.ts:42`），跨 session 复用会污染一次性批准（`approval.decided` 对已存在 callId 抛 `INVALID_TRANSITION`）。若上游保证不了全局唯一，须把主键改为 `(session_id, call_id)` 复合键，并同步改 `guard` 的 `getOnce` / `consumeOnce`。

「一个 session 最多绑一个 active 任务」目前**没有强制点**（`src/` 内无实现），状态是「待实现」，不是现状。

## 2. 时间语义

- `ts` / `recorded_at`：**INTEGER 毫秒**，事件落链时间，写入不可改（`ledger.ts` 的 `appendEvent` 用 `this.now()`）
- 有效时间：`valid_from` / `valid_to`，**同为 INTEGER 毫秒、同一纪元**
- 区间语义：**半开 `[valid_from, valid_to)`**；`valid_to = null` 表示至今
- `ts` **永不**作为有效时间使用。任何「事实从何时起成立」的信息放 payload 或独立列
- 记忆层的语义事实必须双时间并存（§5.3）；冲突时保留双方，不静默覆盖

单位与区间现在写死，是因为一旦记忆层用 ISO 字符串或闭区间，跨层比较必然错，而链改不了。

## 3. 删除语义

两套语义严格分开：

| 域 | 可删性 |
|---|---|
| K1 账本事件、K4 审计事件 | **不可删**（哈希链，删任一条断链） |
| 投影表（`tasks` / `task_steps` / `evidence` / `audit_deletions`） | 可重建，但不是「可随意删」——见 §5 |
| 记忆正文 / 派生 / 索引 | **必须可删且级联**（§5.3） |

**删除是 write-ahead 三事件协议**，不是「删完再记一条」：

```
① deletion.requested  { deletionId, target:{kind,id}, derivatives:[{kind,ref}...] }
② deletion.derivative-done { deletionId, index }        × N（每个派生项一条）
③ deletion.completed  { deletionId }   ← 最后一项完成时由 afterWrite 同事务自动追加
```

已核实（`audit.ts`）：`:134-140` 校验 requested 的清单非空；`:238` 按 deletionId 判重；`:141-144` 校验 derivative-done 的 index 合法、未重复、整单未完成；`:251-259` 的 `afterWrite` 在最后一项 done 后自动追加 completed；**调用方自行写 `deletion.completed` 会被 `raise('INVALID_INPUT', 'deletion.completed is appended internally, not by callers')`**（`:145-146`）。

因果方向是「**审计先于删除**」：先落账单，再逐项删并标记，最后自动闭合。反过来（先删后记）在中断时会留下「内容已删、审计无记录」的窗口，既不可恢复也无法证明删除发生过。

**崩溃恢复**：重启时对 `completed = false` 的 deletion 必须**续跑**，不得重开。

**target 与 derivatives 只允许标识，禁止正文片段。** 否则「彻底删除」与「链不可篡改」互斥，护栏上无解。

**现有三处缺口（记忆层落地前须补）**：

1. **无 target 幂等键**：`deletion_id` 是 PK 而 `(target.kind, target.id)` 无唯一约束，同一 memoryId 可被并发请求两次删除。约定 deletionId 由 target 内容派生
2. **无部分失败态**：`derivatives` 只有 `done` 布尔，无法区分「未尝试」与「尝试失败」；某项永远删不掉时整单永久停在 `completed = 0`，与「进行中」不可区分
3. **投影层无发起者/理由**：只在 `audit_events` 的 actor 里，查询删除状态时看不到是谁提的

## 4. 引用方向

原 v1 写的是「禁止账本引用任何可删对象」，**与现状冲突**：`task_steps.output_ref`（`ledger.ts:57`）与 `evidence.artifact_path`（`ledger.ts:64`）本来就指向可被清理的文件。改为按强度分级：

| 类型 | 举例 | 允许入账本？ |
|---|---|---|
| **可解析实体 ID** | `memoryId` | **禁止**。删后无法解析，读取端悬空 |
| **内容寻址** | `sha256` | 允许。内容删了，哈希仍能证明当时依据的版本 |
| **路径字符串** | `output_ref` / `artifact_path` | 允许（现状即如此）。读取端须把缺失解释为「已不可得」 |

**理由修正**：v1 说「`rebuildProjections` 重放时会拿到不存在的目标」——**错了**。两个 `rebuildProjections`（`ledger.ts:750`、`audit.ts:350`）只把事件重放到投影表，不解析 payload 里的外部引用。悬空是**读取层**问题，不是重放失败。

这个理由必须改对，否则会诱导实现者在重建流程里加「目标存在性校验」——那恰好把投影从「事件的纯函数」变成依赖可删外部状态的函数，反向破坏 §5。

推论：任务与记忆的关联只能由记忆侧建立（`derived_from = taskId`）。

## 5. 投影是事件的纯函数，只有一个写入口

`AGENTS.md` 已规定：`tasks` / `task_steps` / `evidence` 只能由 `ledger/fold.ts` 的 `applyEvent` 更新，`audit_deletions` 只能由 `audit/fold.ts` 的 `applyAuditEvent` 更新。

**硬约束**：

- 任何路径都不得直写投影表。一旦破例，`rebuildProjections` 不再是真相的等价恢复，不可删事件链的意义随之崩塌
- **重建流程禁止读取任何外部实体存储**（记忆库、文件系统）。投影只能由事件序列推出
- 记忆层引入索引表、关联图边表时，必须明确标注：哪些表是正文（可删）、哪些是可重建投影（只经 fold 写）
- `startupCheck` 只校验 ledger/audit 两条事件链，**不校验投影是否被篡改**。投影的可信性来自「可重建」，不是来自校验

## 6. 事件 payload 的演进

`LedgerEventRow.payload` 是 `unknown`，单条事件没有 `schemaVersion`，只有导出文档级有 `format: 'prts-ledger/1'`。

**约定**：

- `kind` 用 `<域>.<动作>` 命名空间（`task.created`、`deletion.requested`），跨模块不复用同一 kind
- payload **只增字段**，不改既有字段语义，不删字段
- 语义变更必须新增 kind，不复用旧 kind

否则记忆层往 payload 写结构化字段后，`rebuildProjections` 重放老链只能靠猜形状。

---

## 留白表（拆两栏）

**能力（现在就要定，因为 §3 依赖它）**：记忆后端必须支持

- 按 target 标识删除
- 枚举某条记忆的全部派生副本（索引、图边）
- 单事务内级联删除；删除后崩溃可恢复 / 可重试
- 报告「实际删掉了什么」

以接口形式先定（`deleteByTarget` / `enumerateDerivatives` / `applyDeletion`），后端选型退化为实现选择。

**产品（待实测）**：检索排序权重（§11 第 10 项）、宿主装配 vs 模型自管（V1-18）、巩固触发与预算（V1-16）、进化评估门槛（§5.4）、具体后端。

这些是**刻意未定**，不是遗漏。
