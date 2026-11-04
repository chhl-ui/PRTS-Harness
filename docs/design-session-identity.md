# 会话身份（Session Identity）设计

2026-11-04。**状态：设计稿（议事会评审后修订），不含实现。**

## 一、为什么需要这份设计

Wave 2 的「子会话授权收窄」连续 30+ 次被议事会否决，每次否决指向同一件事：
**会话身份没有被当作一等概念**。缺任何一件，下一次评审就会在下一个缝上否决。

四件必须同时成立的事：

1. **持久化**：会话身份与 roots 是授权事实，必须与 grants/once 同构——进审计链、有投影、可重建。
2. **生命周期**：注册、释放、重启、崩溃四个时刻都要有定义，否则投影只增不减。
3. **空会话语义**：`start.ts:402/446` 的 `?? ''` 在缺失时会把「不知道是谁」变成「最有权限的那个」。Wave 0 已把空会话对 grant 判为 fail-closed（`authority.ts:146`），新收窄必须与之一致。
4. **覆盖矩阵**：所有创建会话的调用点都必须注册，否则「未注册」会成为一个静默的旁路。

## 二、事实基线（本轮已核实）

| 事实 | 位置 |
|---|---|
| Authority 每次直查 SQLite、无进程内缓存 | `src/authority/authority.ts:22-25` |
| `audit_grants` 有 `subject`（`'model'`）但无会话列；`audit_once` 有 `session_id` | `src/audit/audit.ts:32-47` |
| 空会话已对 grant fail-closed | `src/authority/authority.ts:142-147` |
| 运行时两条订阅都用 `exec.agent?.session?.id ?? ''` | `src/runtime/start.ts:402`、`:446` |
| 全仓 `agents.create` 仅一处生产调用 | `src/cli/chat.ts:499` |
| 七条注入链是运行时级 handler | `src/runtime/intent-trigger.ts:163`、`task-reminder.ts:204` |
| **只读打开不执行 SCHEMA**：`AuditLog.open({readOnly:true})` 只设 busy_timeout 就返回 | `src/audit/audit.ts:184-188` |
| 空 sessionId 的现有用例全部期望 deny（无「期望 allow」的反对用例） | `test/authority/session-scope.test.ts:66/129/140` |
| 直接构造 `new Authority(` 18 处 / 7 个文件；`startRuntime(` 42 处 / 28 个文件（本次只读扫描） | `src/` + `test/` 全文扫描 |

## 三、设计

### 3.1 事件与投影（持久化）

新增两个审计事件，**必须先落类型联合与校验分支**（`validateEvent` 是逐 kind 的 switch，default 直接 raise，漏接则写入即拒）：

- `AuditEvent` 联合加 `session.registered` / `session.released`（`src/audit/types.ts:31-33`）。
- **事件字段名是 `sessionKind`，不是 `kind`**：外层 `kind` 已被事件判别占用，`session.registered` 只能写 `{ sessionId, sessionKind, roots, parentSession? }`（`types.ts:32`）。类型是 `SessionKind = 'primary' | 'subagent'`。
- **但注册 API 的入参仍是 `kind`**：`RegisterSessionInput` 是 `{ sessionId, kind, roots, parentSession? }`（`types.ts:48-52`），由 `registerSession` 在写事件时映射为 `sessionKind`（`audit.ts:331`）。两者不可混写——事件字段是判别冲突后的形状，入参字段是公开 API 的形状。
- `validateEvent` 分支：`sessionId` 非空；`sessionKind ∈ {primary, subagent}`；`roots` 为 `string[]`（可为空数组）；`parentSession` 若给则非空串；`session.released` 只校验 `sessionId`（`audit.ts:182-188`）。

投影表（只能由 `applyAuditEvent` 在同事务更新）：

```sql
CREATE TABLE IF NOT EXISTS audit_sessions (
  session_id       TEXT PRIMARY KEY,
  -- 投影列名保持 kind（表内无判别冲突），对应事件字段 sessionKind
  kind             TEXT NOT NULL CHECK (kind IN ('primary','subagent')),
  roots_json       TEXT NOT NULL,
  parent_session   TEXT,
  registered_at_ms INTEGER NOT NULL,
  released_at_ms   INTEGER
);
```

- **`rebuildProjections` 必须新增 `DELETE FROM audit_sessions`**（`audit.ts:378-386` 逐表 DELETE 后重放；applyAuditEvent 对投影一律裸 INSERT，漏 DELETE 会在重放第一条 `session.registered` 时撞主键并让整个事务 ROLLBACK）。
- 补一条「增量 == 重建」等价测试：写入 N 条会话事件 + 一次释放，rebuild 后行集与增量一致；`importDoc` 从空库重放同样覆盖。
- 投影表由 SCHEMA + 幂等迁移创建；**不进 `startupCheck`**（它只判两条事件链；四个既有投影表都不在检查范围，加入新表会让老库升级即永久只读）。
- **只读打开缺表容错**：`AuditLog.open({readOnly:true})` 不执行 SCHEMA，老库上 `audit_sessions` 不存在。判定前用 `SELECT name FROM sqlite_master WHERE type='table' AND name='audit_sessions'` 探测（或 try/catch 精确匹配 no-such-table）；**缺表 → 按未注册处理（defer）**，不得抛错（否则 guard 的 catch 会把该库上一切写操作转成拒绝，比「永久只读」更硬）。配一条「仅有旧 schema 的库上 fs.write 仍走原逻辑」的测试。
- 读写直查投影，不做进程内缓存（与 `authority.ts:22-25` 同一不变量）。

### 3.2 生命周期

| 时刻 | 动作 | 失败方向 |
|---|---|---|
| 主会话创建 | `chat.ts:499` 的 `agents.create` 成功后立即 `registerPrimarySession(sessionId)`（roots = workspaceRoots） | 注册失败 → dispose agent、拒绝会话（fail-closed） |
| 子会话创建 | `spawnSubtask(taskId)`：**先** `registerSessionRoots(sessionId, [派生目录])`，**再** `agents.create`；create 失败 → `release` 回滚 | 注册失败 → 不创建 agent（fail-closed） |
| 正常结束 | `dispose` 的 `finally` 里 `releaseSession(sessionId)` | 失败只记日志；`agent/disposed` 事件兜底（该事件是否存在**待验证**） |
| 进程崩溃 | 启动时把 `registered_at_ms` 早于本次启动、且 `released_at_ms` 为空的行视为 **stale**（审计不改写）；判定按 **deny**（见 3.3） | 孤儿行不会被删除（链只追加） |

**注册与 create 的顺序定死为「先注册后创建」**：反过来，create 成功而注册失败的窗口里，子会话会以「未注册」获得主会话权限——这是本设计要消除的失效方向。

**roots 规范化**：注册时对每个 root 做 `realpathBestEffort` 再写入 `roots_json`；判定时对 `p.arg` 同样 realpath 后 `isWithin` 比较——与 `authority.ts:44-49` 对 workspaceRoots/protectedRoots/spillRoots 的构造口径一致。否则 symlink / 8.3 短名 / 大小写差异会让 roots 内 allow 漏判或越界。

### 3.3 判定（单一函数，一处口径）

`Authority.decideSessionScoped(sessionId, op, path): 'allow' | 'deny' | 'defer'`

| 会话状态 | 裁决 |
|---|---|
| 空 sessionId | **deny**（与 Wave 0 的 grant 判定一致；现有用例 `session-scope.test.ts:66/129/140` 已按 deny 断言） |
| 未注册 | **defer**（= 主会话，走原逻辑；见 3.5 的收紧路径） |
| 已注册 primary | defer（走原逻辑） |
| **已注册 subagent 且 `released_at_ms` 非空** | **deny** |
| **已注册 subagent 且 stale（崩溃孤儿）** | **deny** |
| 已注册 subagent（活跃） | roots 内 allow / 全局 workspace 内且 roots 外 deny / 其余 defer |

**全局 grant 与子会话**：grant 的 `session_id = null` 表示所有者显式全局授予。**子会话遇到全局 grant → deny**（不继承父会话的任何授予，与 `src/authority/types.ts:41-46` 的契约一致）；主会话与未注册会话遇到全局 grant → 原逻辑 allow。

**优先级表（fs.write，逐条不可交换）**：

1. protectedRoots deny
2. spillRoots deny
3. readOnlySubpaths deny
4. `decideSessionScoped`（子会话 deny 高于 grant；全局 grant 对子会话 deny）
5. workspaceRoots allow
6. grant
7. ask

fs.delete 保持恒 ask，只在 ask 前加「子会话活跃 + roots 外 → deny」。fs.read 不受影响；exec 不在本设计范围（与 K2b 同批）。

### 3.4 覆盖矩阵

- `src/` 内 `agents.create` 恰好两处：`chat.ts:499`（主会话）与 `subtask.ts`（子会话）。
- **覆盖测试写成行为级，不是文本 grep**：列出 `start.ts` 的 `RuntimeOptions` 消费面（所有 tools 装配入口），断言每个入口的 sessionId 来源要么已注册、要么明确走 defer；新增调用点即红。
- 测试文件：`test/acceptance/session-coverage.test.ts`（新增）。

### 3.5 未注册 = 主会话：显式取舍与收紧路径

**本波不施加「未注册 deny」**。理由：`startRuntime` 全仓 42 处调用（28 个文件，见 §二），unknown deny 会让全部 wiring 用例同时变红。

但议事会指出这个爆炸半径**可能被高估**：空会话 deny 已在 Wave 0 落地且无反对用例（见 §二），说明这 42 处大多传了非空 sessionId。

**收紧路径的真实前置不是改默认值。** `allowUnregisteredSessions` 这个开关在 `src/` 内零命中（grep 无任何符号定义或引用），`decideSessionScoped`（§3.3）也尚未实现——§3.3 是待落地设计，不是已存在的代码。所以「把默认值翻为 false」既没有对象可翻，也没有判定可翻。收紧必须按实现顺序推进：

1. 先落 `registerPrimarySession` 在 `chat.ts:499` 的挂点 + 覆盖测试；
2. 实现 `decideSessionScoped` 并接进 `evalCap`（`src/authority/`），此时「未注册」分支的返回值本身即收紧开关——defer 是现状口径，deny 是收紧口径；
3. 跑一次全量，若把「未注册」分支从 defer 改为 deny 只打穿少数用例，本波就改该分支返回值（无需引入新配置项）；
4. 若打穿面过大，保持 defer 并押后到 Wave 3。

残余风险（若退回 defer）：不经注册的 `agents.create` 会以主会话权限运行；缓解是 3.4 的覆盖测试 + 注册失败即拒绝。

## 四、与现有不变量的关系

| 不变量 | 本设计如何遵守 |
|---|---|
| 投影只能由 fold 更新 | `audit_sessions` 只由 `applyAuditEvent` 写；fold 的 default 分支必须显式新增这两个 kind（否则「写成功但没生效」，同类事故见 `src/skills/fold.ts` 头注释） |
| 事件链只追加 | 释放写 `session.released`，不改历史行 |
| 授权判定每次直查 SQLite | 无进程内缓存 |
| 守卫是唯一强制点 | 判定在 `evalCap` / `decide`，不经 pre-execute |
| 注册 API 不进模型工具面 | actor 固定 system；静态断言 `grep -rn "prts_session" src/` 零命中 |
| fail-closed | 空会话 deny；released/stale 子会话 deny；全局 grant 对子会话 deny；注册失败即拒绝创建 |

## 五、验收清单（设计层面）

- [ ] 事件类型 + `validateEvent` 分支 + fold 分支三处齐全（漏一处即「写成功但不生效」）
- [ ] `rebuildProjections` 含 `DELETE FROM audit_sessions`，且有「增量 == 重建」等价测试
- [ ] 只读老库缺表 → defer，且有「旧 schema 库上 fs.write 仍走原逻辑」的测试
- [ ] 判定表覆盖六种状态（空/未注册/primary/active-subagent/released-subagent/stale-subagent）
- [ ] roots 注册与判定同一 realpath 口径
- [ ] 覆盖测试为行为级，新增 `agents.create` 调用点即红
- [ ] 全局 grant 对子会话 deny，有对应用例
- [ ] 「未注册 deny」在本波做一次全量实测，按结果翻牌或退回 defer

## 六、反证与待验证

1. **「`agents.create` 只有两处」**——依据是本轮 `grep -rn "agents.create" src/` 只命中 `chat.ts:499`；新增 `subtask.ts` 后为两处。插件是否有独立创建通道**待验证**。
2. **「`agent/disposed` 事件可用」**——DSH 的 agents 服务是否暴露该事件、payload 是否带 sessionId，**未核实**；若无，释放只能靠 dispose 的 finally。
3. **「stale 判据」**——比较 `registered_at_ms` 与进程启动时刻；多进程共享同一 DB 时不成立（本设计的单进程假设）。
4. **「未注册 deny 的爆炸半径」**——议事会判断可能被高估，依据是空会话 deny 已落地无反对用例；**待全量实测**。
5. **「注册表不进 startupCheck」**——依据是既有四个投影表都不在检查范围；若未来统一扩检查，需重新评估老库只读风险。
