# U5 评估：`uncertain` 结论与 `derived_from` 的影响面

**状态：只读评估，未改实现。** 2026-10-31。

回答 `docs/task-entry-design.md` 里留下的两个未做项：

1. **`uncertain` 结论**——"依赖 CheckSpec 扩展，独立设计"
2. **`derived_from`**——"等记忆层"

本文把两个"独立设计"的边界量清楚，给出可执行的前置清单。

---

## 1. 现状（全部读到源码）

| 层 | 位置 | 当前形态 |
|---|---|---|
| 检查种类 | `src\ledger\types.ts:20-22` | 只有 `file-exists` / `file-sha256` 两种 |
| 检查执行 | `src\ledger\ledger.ts:880` `runCheck()` | **同步**函数，`existsSync` / `readFileSync` |
| 结果结构 | `ledger.ts:874` `CheckResult` | `ok: boolean`——**只有两态** |
| 任务阶段 | `types.ts:11-19` `TaskPhase` | 8 个阶段，**无 `uncertain`** |
| 事件分支 | `src\ledger\fold.ts` | 22 个 case，含 `task.verified`（`:120`）、`task.owner-rejected`（`:130`） |
| 模型可发操作 | `ledger.ts:122-125` `MODEL_OPS` | 12 个操作白名单 |
| 投影重建 | `ledger.ts:799` `rebuildProjections()` | 删三张表 → 按 seq 重放 `applyEvent` |
| 记忆层 | `src\` 目录列表 | **不存在**（只有 audit/authority/chain/cli/core/integrity/ledger/runtime/stop/supervisor） |

---

## 2. 加 `command-exit` 的影响面

### 2.1 类型层（小）

```ts
// types.ts:20-22 增加一个 variant
export type CheckSpec =
  | { kind: 'file-exists'; path: string }
  | { kind: 'file-sha256'; path: string; sha256: string }
  | { kind: 'command-exit'; command: string; expectExit: number; timeoutMs?: number }
```

**但语义问题比类型问题大**：命令在哪跑？谁的权限？工作区外写怎么办？

`command-exit` 本质上是把「执行能力」塞进了「验收判定」——这会让 K2a 守卫的判定面从「工具调用」扩大到「校验器内部」。**必须明确：校验器的命令走不走 `Authority.guard`？** 如果不走，就是一个绕过守卫的执行通道。

### 2.2 执行层（**最大改动面**）

`runCheck` 当前是**同步**的（`ledger.ts:880`）。`command-exit` 需要 spawn + 等待，必须改异步：

```ts
function runCheck(check: CheckSpec): CheckResult        // 现在
async function runCheck(check: CheckSpec): Promise<CheckResult>  // 改后
```

连带改动：
- 上层调用点（`claimDone` 的校验流程）全部 async 化
- 所有 `runCheck` 的测试要改成 await
- 事务边界：现在 checks 跑在什么事务里？异步期间不能持有 DB 事务

**这一层的工作量超过 `command-exit` 本身**——它是把整个校验路径从同步改成异步。

### 2.3 结果三态化

`CheckResult.ok: boolean`（`ledger.ts:874`）无法表达「不确定」。要支持 `uncertain` 必须是三态：

```ts
type CheckOutcome = 'pass' | 'fail' | 'uncertain'
interface CheckResult {
  check: CheckSpec
  outcome: CheckOutcome       // 替代 ok
  detail: string
}
```

**这是破坏性改动**：所有读 `ok` 的地方都要改。

---

## 3. `uncertain` 结论的影响面

### 3.1 新增 `TaskPhase.uncertain`（`types.ts:11-19`）

关键决策：**`uncertain` 是不是终态？**

- 若是终态：加进 `TERMINAL`（`ledger.ts:119`），任务不再能推进
- 若不是：需要新的转换规则（谁能把它改回 active？）

设计文档的语义是「环境缺失/超时导致判不了」，那它**不应该是终态**——环境恢复后应能重试。建议：`uncertain` 可回到 `active`（由 owner 或 verifier 触发）。

### 3.2 事件与 fold 分支

新增事件 `task.uncertain`（或扩展 `task.verified` 的结论字段）：

- `fold.ts` 加 case（现有 `task.verified` 在 `:120`，`task.owner-rejected` 在 `:130`，照抄结构）
- `MODEL_OPS`（`ledger.ts:122-125`）决定谁能发：**模型不能**（否则模型可以用「不确定」逃避失败判定）；应归 `system: verifier`
- audit 事件类型同步

### 3.3 重放一致性（`ledger.ts:799`）

新事件必须能被 `applyEvent` 重放。验证方式：

```ts
// 写入若干含 uncertain 的事件 → rebuildProjections() → 投影应与重建前一致
```

现有测试是否有这个模式？需要加一条**专门的**重放一致性用例——这是设计文档点名的门槛。

---

## 4. `derived_from`：阻塞，前置不存在

`src\` 下**没有记忆层**（只有 audit/authority/chain/cli/core/integrity/ledger/runtime/stop/supervisor）。

`derived_from`（任务由哪条记忆派生）需要：
1. 记忆实体的存在与标识
2. 账本事件能引用记忆 id
3. 反向查询：这条记忆派生过哪些任务

前两条是账本侧能做的（加一个 `derivedFrom?: string` 字段 + 事件字段），第三条依赖记忆层的索引。

**结论**：`derived_from` 现在做不了，**不是设计问题，是依赖缺失**。它应该排在记忆层之后。

---

## 5. 工作量与建议

| 子项 | 改动面 | 估计 | 建议 |
|---|---|---|---|
| `command-exit` 类型 | `types.ts` 一处 | 小时级 | 可做 |
| `runCheck` 异步化 | `ledger.ts` + 所有调用点 + 测试 | **天级** | 独立提交，先做 |
| 结果三态化 | `CheckResult` + 所有消费点 | 天级 | 与上一条同批 |
| `TaskPhase.uncertain` + 事件 + fold | `types.ts` / `fold.ts` / `ledger.ts` | 天级 | 依赖前两条 |
| 重放一致性用例 | 测试 | 小时级 | 必须做，设计文档点名 |
| `derived_from` | — | **阻塞** | 等记忆层 |

### 一个必须先答的设计问题

**校验器跑 `command-exit` 时，命不命 K2a 守卫？**

- 若命：校验器需要在 `Authority` 上下文里，且可能弹审批——验收流程会变得很重
- 若不命：这就是一条**绕过守卫的执行通道**，与「守卫是唯一强制点」的不变量冲突

**这条不答清楚，`command-exit` 不该动手。** 我倾向：校验器的执行走独立的、受限的执行器（只读工作区 + 固定超时 + 禁止网络），并在设计文档里明确它是**第二个执行面**，不是绕过守卫。

### 推荐顺序

1. **先做 `runCheck` 异步化**（不带 `command-exit`）——纯结构性改动，为后续铺路，可独立验证
2. **再三态化**——同样是纯结构改动
3. **最后加 `command-exit`**——此时类型、异步、三态都已就位
4. `derived_from` 挂到记忆层里程碑

这样每一步都能单独跑 `npm test` 验证，不会一次性大爆炸。

---

## 6. 复现本评估

```sh
cd C:\prts-system
sed -n '20,22p' src/ledger/types.ts          # CheckSpec 两种
sed -n '880,903p' src/ledger/ledger.ts       # runCheck 同步
sed -n '11,19p' src/ledger/types.ts          # TaskPhase 无 uncertain
grep -n "MODEL_OPS" -A 5 src/ledger/ledger.ts # 操作白名单
ls src/                                       # 无 memory 目录
```
