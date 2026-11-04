# 会话切换（`/switch`）设计

2026-11-04。**状态：设计稿，待实现。** 对应 Wave 3 第二步。

## 一、为什么不能「只换个 agent 变量」

`runChat` 里以 `sessionId` 为键的状态不止一处。只改 `agent` 会让「对话进了新会话、审批/记忆/任务还挂在旧会话」——这类错位不会报错，只会静默写错账。

## 二、状态清单（切换时必须逐个处理）

| # | 状态 | 位置 | 切换时 | 理由 |
|---|---|---|---|---|
| 1 | `agent`（followup 目标） | `chat.ts` 的 `const { agent }` | **替换**为 `agents.get(id)` | 切换的定义就是换目标 |
| 2 | `sessionId` | `chat.ts:498` 的 `const sessionId` | **替换**，后续日志/审批/记忆/任务全部随之 | 它是所有绑定的键 |
| 3 | `replies`（回合计数） | `runChat` 内 | **保留**（跨会话累计）或重置——二选一写死 | 影响 `onTurnEnd.turn` 语义；本设计选**保留**（会话切换不改本进程的对话轮数） |
| 4 | `streamed` / `attemptText` / `attemptId` | 流式输出 | **重置** | 属于上一条回复的中间态，跨会话复用会把旧文本算进新回合 |
| 5 | `seenSeq` | 日志兜底 | **重置为 0** | 新会话的 `session.v4.jsonl` 是另一份文件，旧 seq 无意义 |
| 6 | 审批 `pendingApprovals` | `start.ts` 的 `Map<callId, …>` | **保留**（按 callId 索引，与 sessionId 无关），但切换后旧会话的 pending 审批**不应再被本输入流应答** | 本设计选：切换时清空本进程发起的 pending（调用 `approvalBridge` 的丢弃钩子或直接不再应答——见 §3） |
| 7 | 记忆注入的分桶状态 | `memory-inject.ts` 的 `injectedSteps` / `injectedHitIds` | **不重置** | 它们本来就按 `sessionId` 分桶；切换后键不同，天然隔离 |
| 8 | 主动回忆的分桶状态 | `proactive-recall.ts` 的 `decidedTurns` / `injected` | **不重置** | 同上 |
| 9 | 任务绑定 | `ledger.taskForSession(sessionId)` | **不迁移** | 任务绑定是账本事实；切到另一个会话后，`/task-*` 的归属校验自然按新 sessionId 走。旧会话的任务不跟随 |
| 10 | 会话身份注册 | `authority.hasSessionScope(id)` | 若目标**未注册**，切换时补 `registerPrimarySession(id)` | 否则后续写操作会落到「未注册」口径（当前 defer，将来若翻牌会 deny） |

## 三、切换协议

```
/switch <sessionId>
```

1. 缺参 → 用法提示（含 `/sessions` 指引）。
2. `agents.get(id)` 返回 `undefined` → 拒绝：`[prts] 没有活跃会话 <id>；/sessions 查看可用会话`。**不恢复历史会话**（那是 resume，不是 switch）。
3. 目标等于当前 → 提示「已经在这个会话」并返回。
4. 成功：`agent = next`、`sessionId = id`、重置 §二 的 4/5、清本进程 pending 审批（#6）、目标未注册则补注册（#10）。
5. 输出一行确认：`[prts] 已切到 <id>`。

## 四、验收清单

- [ ] 切到存在的会话：后续 `followup` 进入新 agent（fake agents 断言调用对象）
- [ ] 切到不存在的会话：拒绝且不改变当前 agent
- [ ] 切到相同的会话：幂等提示
- [ ] 切换后 `streamed`/`attemptText`/`seenSeq` 已重置（构造跨会话文本，断言不串）
- [ ] 切换后旧会话的 pending 审批不再被本输入流应答
- [ ] 目标未注册时会补注册（`hasSessionScope(id) === true`）
- [ ] 既有 `/sessions`、`/task`、`/memory` 测试全绿（切换不破坏单会话路径）

## 五、不做

- **不做常驻 Router**（需要先解耦客户端寿命，见 `design-superagent-fusion.md`）。
- **不做多客户端并发**（`terminal-server.ts` 的单客户端约束不变）。
- **不做历史会话恢复**（`agents.resume` 是另一条路，需要会话重放语义）。

## 六、待验证

1. `agents.get(id)` 返回的 bare `Agent` 是否可直接 `followup`——类型上可以（`AgentRegistry.get` 返回 `Agent | undefined`），**运行时未实测**。
2. 切换后旧 agent 是否应 `dispose`——本设计**不 dispose**（用户可能切回去）；代价是旧 agent 常驻内存，未做压力评估。
3. pending 审批的清理钩子是否存在——`approvalBridge` 的公开面需要核实（`start.ts` 的 `PendingApproval` 是内部 Map）。
