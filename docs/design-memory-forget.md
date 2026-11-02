# P0-2a：记忆的所有者删除与纠正（设计）

## 背景事实（已核实）

- `src/memory/fold.ts` 的 `memory.deleted` 支持 target fact/turn（清 body、删 FTS 行、置 `deleted_at_ms`），但**没有任何调用入口**删 turn；`deleteFact` 无 CLI/chat 入口；`fact.corrected` 未实现。
- 删除不清链外派生项：`mem_vectors`（无删除语句）、`mem_sessions.body` 与 `mem_fts_sessions`（删 turn 后不重算）、`mem_mentions`/`mem_entities`/`mem_links`/`mem_topics`（巩固产物，`consolidate.ts:155-180`）、`mem_profiles.evidence_fact_ids`、`mem_summaries.source_turn_ids`、`mem_facts.source_turn_ids`。`rebuildProjections` 不碰链外项（`store.ts:1576` 注释）。
- K4 删除 API 已有：`deletion.requested {deletionId, target:{kind,id}, derivatives:[{kind,ref}]}` → 逐个 `deletion.derivative-done {deletionId, index}` → 最后一个完成时库内自动追加 `deletion.completed`（`src/audit/audit.ts:134-146,238-257`，`src/audit/types.ts:25-27`）。
- DSH 会话日志 `<dataRoot>/dsh-home/sessions/**/session*.jsonl` 含对话原文与持久化的注入；**会话日志删除见文末「P0-2b 已完成」**——由 `/forget-session` 命令经 DSH 写锁协议判定空闲后整目录删除，并补记 K4 `session-log` derivative。

## 1. 存储层 `MemoryStore`

- `MemoryQuery` 加 `includeRetired?: boolean`（默认 false；仅所有者视图用）。
- `planForget(ids: string[]): ForgetPlan` —— 只读。ids 可为 turn_id / fact_id / `profile-<id>` / `summary-<id>`（与 search 返回的 id 同形）。级联规则：
  - turn → `source_turn_ids` 含它的 facts、`source_turn_ids` 含它的 summaries、它的 `mem_mentions` 行、删除后 mention 数为 0 的实体（连同其 `mem_links` 两端边与 `mem_topics` 行）、它所在 session 的 `mem_sessions` 需重算。
  - fact（含级联得到的）→ `evidence_fact_ids` 含它的 profiles。
  - 所有被删 owner（turn/fact/profile）的 `mem_vectors` 行。
  - 不存在/已删除的 id → plan 里列为 `notFound`，不报错；plan 为空则 forget 拒绝执行。
  - plan 返回：`{ turns, facts, profiles, summaries, vectors: number, mentions: number, orphanEntities: number, sessionsToRebuild: string[], notFound }`（ids 与计数；**不含正文**）。
- `forget(ids: string[], actor: 'owner'): ForgetResult` —— 在 `BEGIN IMMEDIATE` 事务**内部**重新计算 plan（复用 planForget 的内部函数），按该 plan 执行，`ForgetResult` 带回实际 plan。理由：先 plan 后 forget 间若有写入（巩固/新 turn），旧 plan 会漏删新派生项。单个事务内：对每个 turn/fact 追加 `memory.deleted`（+ 同事务 `deletion.derivative-done`，沿用现有两事件形态；payload 加 `cascade_of?: <触发它的顶层 id>` 与 `derived_purged: {profiles:[ids], summaries:[ids], vectors:n, mentions:n, orphan_entities:n}` 计数——**实体名不上链**）；同事务直接删链外项（profiles/summaries 含其 FTS 行与 summary 的 mem_bodies 正文、vectors、mentions、孤儿 entities/links/topics）；对 `sessionsToRebuild` 重算 `mem_sessions.body` 与 `mem_fts_sessions`（无剩余 turn 则删该 session 行）。存活实体的 `mention_count`/边权不回调（统计量非内容）。
  - 事务提交后：对 `mem_fts_turns/facts/sessions/profiles/summaries` 各执行一次 `INSERT INTO t(t) VALUES('optimize')`，再 `PRAGMA wal_checkpoint(TRUNCATE)`。理由：FTS5 段合并前旧 token 仍在段里；WAL 里有旧页。`secure_delete` 已开（`schema.ts:246`）。
- `correctFact({ factId, object, actor: 'owner' }): string`（返回新 fact_id）：
  - 新事件 `fact.corrected`，payload：`{ fact_id: 旧id, new_fact_id, subject, predicate (取自旧行), identity_key, body_ref, body_sha256, provenance:'stated', confirmation_basis:'owner-stated', origin: 旧行 origin, retention_class: 旧行, importance: max(旧, 0.8), source_turn_ids: [] }`。
  - fold：插入新 fact 行（同 `fact.asserted` 的插入与 FTS 同步，抽成共用函数）；旧行 `retired_at_ms = recorded_at_ms` 且 `superseded_by = new_fact_id`。
  - 新列 `superseded_by TEXT`：照 `ensureFactAccessColumns` 自愈迁移加（`schema.ts`），不进 SCHEMA 索引。
  - 拒绝：旧行不存在/已删除 → throw；已有 superseded_by → throw（信息含新 id）。
  - `restoreFacts` 排除 `superseded_by IS NOT NULL` 的行。
  - 对话原文（turn）不支持纠正——只能删除；`correctFact` 传 turn id → throw「对话原文只能删除」。

## 2. 所有者流程 `src/memory/forget-flow.ts`（新）

- `findForOwner(store, query)`：`search({ text, limit: 20, includeOrigin:['live'], includeRetired:true, profileQuota:5, summaryQuota:5 })`，返回带 id/kind/时间/前 80 字的列表。
- `forgetFlow({ store, audit, sessionsRoot, ids, confirm })`：
  1. `plan = store.planForget(ids)`；空 → `{ ok:false, reason }`。
  2. 扫描会话日志：对每个被删 turn/fact/summary/profile 的正文（plan 前读出，仅内存），在 `sessionsRoot` 下所有 `session*.jsonl` 中查找 `JSON.stringify(body).slice(1,-1)` 子串（JSON 转义形态），收集命中的 sessionId（目录名可解析即可，不行就用相对路径）。
  3. `confirm=false`：返回 plan + 会话命中，不写任何东西。
  4. `confirm=true`：对每个**顶层**目标追加 K4 `deletion.requested`：target `{kind:'memory-'+kind, id}`，derivatives 依次 `{kind:'memory-store', ref:'memory.sqlite'}`、`{kind:'memory-compact', ref:'memory.sqlite'}`，以及每个命中会话 `{kind:'session-log', ref:sessionId}`（全局命中集对每个顶层目标都列——保守）。然后 `store.forget(plan)`；成功后每个 deletion 追加 index 0 的 derivative-done；optimize+checkpoint 成功后追加 index 1。session-log 项**保持未完成**。
  5. 返回结果明确：已清除什么、哪些会话日志仍含原文（deletion 未完成）、以及「当前对话上下文里已出现的内容不会因此消失」。
  - 顺序理由：先在 K4 记 requested，再动记忆库；中途崩溃则 K4 留未完成删除，可见可重跑；反过来会出现「已删但无记录」。
- `correctFlow({ store, factId, object })`：调 `correctFact`。纠正可逆（旧值留链），不走 K4、不要求确认。

## 3. 入口（只属所有者）

- CLI：`prts memory find --query <text>`；`prts memory forget --id <id,...> [--yes]`（无 --yes 打印计划退出码 2；--yes 执行；需 `PRTS_DATA_ROOT`）；`prts memory correct --fact <id> --object <text>`。
- chat：`/memory <query>`、`/forget <id,...>`（计划）、`/forget <id,...> --yes`（执行）、`/correct <factId> <新内容>`。chat 用运行时同一个 MemoryStore 与 authority 的 dbPath（startRuntime 透出）；斜杠命令行不发模型、不落记忆。
- 不注册任何模型工具。

## P0-2b 已完成（2026-11-02，`src/memory/session-purge.ts`）

会话日志删除已实现，解除此前「在用判定无公开接口」的阻塞：

- **在用判定**：按上游 `SessionWriteLease` 同一协议，在 Windows 上尝试获取命名内核信号量 `Local\dsh-session-lock-<sha256(小写 resolve(<dir>/session.lock))>`（计数 1、零超时 wait）。拿到 = 空闲且持有期间新写者被 `SessionAlreadyOwnedError` 挡住——拿锁-删除-放锁无竞态；拿不到 = 在用（当前 chat 会话天然被自持锁拒删，不需特判）。锁是内核对象不是 `session.lock` 文件内容，进程死亡自动释放，无过期抢占语义。上游未导出该类，PRTS 用 koffi 按公开协议重实现，一致性靠契约测试钉住：真实运行时的活动会话必须探测为 busy（SP5）。
- **删除粒度**：整个会话目录（`session.v4.jsonl` + 附属文件）。逐行改写 JSONL 会破坏 append-only 事件图（seq / sourceEventSeqs），续会话读到损坏历史——所以走独立命令与显式确认，不并入 `/forget` 的自动级联。
- **入口**：`prts memory forget-session --id <sessionId,...> [--yes]`；chat `/forget-session <id,...> [--yes]`。无 --yes 打印探测（free/busy/missing/字节数）退出码 2。
- **K4 闭环**：purge 成功后为所有挂着的 `session-log` derivative（按 ref=sessionId 匹配）补 `deletion.derivative-done`；全部完成时 `AuditLog` 自动补 `deletion.completed`。忙/失败的会话保持未完成、可重试。
- **保守细节**：持锁期间先 `rename` 到 `*.purged-<ts>` 再 `rm`（rm 半途失败原路径也不再有可读日志）；sessionId 白名单校验拒绝路径穿越；单个会话的锁/删失败隔离到该会话不中止整批；探测拿锁异常按 busy 报，绝不假报 free。
- **真机验收**（`.scratch/v106/run-2026-11-02T1456/`）：3 个会话目录删除、39 条 derivative-done 补记、13 条 deletion 全部 completed、会话日志 token 扫描为空。
