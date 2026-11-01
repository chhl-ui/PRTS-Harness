# 记忆调用面接线（2026-11-02）

补上 PRTS 记忆主线最大的一处缺口：**生产链路只有写入、没有读取**。

核验（议事会三席指出后独立复核）：

```
grep -rn "\.search(" src/ | grep -v "src/memory/store.ts"                        → 0 行
grep -rn "runConsolidation|consolidateProfiles|retireFacts" src/（memory 之外）  → 0 行
grep -n "memory\.|MemoryStore" src/runtime/start.ts                              → 只有 recordTurn（L402 / L452）
```

六项机制全部只被 `test/` 与 `.rivet/scratch/` 调用。

---

## 本轮接了什么

**`prts_memory_recall` 工具**（`src/runtime/memory-tools.ts`，注册于 `start.ts`）：
模型可主动检索长期记忆，命中内容作为工具结果进上下文。

| 取舍 | 决定 | 理由 |
|---|---|---|
| 检索路 | **只走 bm25（LIKE + FTS）** | 向量路要 embedder，生产不保证有 Ollama；画像 30 题全量实测无增益 |
| origin | **只读 `live`** | benchmark 不得进生产检索；画像污染事件（267 条实验画像被标 live）就是缺这道默认值 |
| `limit` | 上限 20，默认 8 | 工具结果直接进上下文，一次要太多会挤掉真实对话 |
| `query` 为空 | **抛错** | 静默返回空结果会让模型以为「记忆里没有」，实际是调用写错 |
| 写工具 | **不注册** | 退役/巩固可能跑几十秒，不该由模型在对话中触发 |

返回值带 `kind / id / text / occurredAt / score / recallPath`。时间必须给——只给正文，
任何「多少天前 / 谁先谁后」的问题都无从推理（v2.7 的实测教训）。

## 本轮没接什么（遗留，按优先级）

> **2026-11-02 续：本节的第 1、2、4 条已补齐，见文末「三块补齐」。** 第 3 条（向量与画像）
> 仍然没开——没有评测证据支持它们进生产。

1. **巩固与退役的调度**：`runConsolidation` / `consolidateProfiles` / `retireFacts`
   仍然零生产调用方。计划入口是 CLI 子命令（`prts memory consolidate|retire|stats`），
   不是模型工具——它们是运维动作，需要显式触发与预算控制。
2. **自动注入（无意识回忆）**：当前靠模型主动调。DSH 有 `system-prompt/assemble`
   waterfall 与 `PromptSection` 注册点，可以做「每轮自动注入 top-k」，但组装时拿不到
   当前用户消息（`AssembleContext` 只有 scope/signal），需要额外的桥。未做。
3. **向量与画像路**：工具不传 `queryVector` / `profileQuota`。要开先在评测集上证明增益。
4. **用进废退**：检索命中不回写强化（`search()` 只读），生命周期的「复述强化」缺失。

## 验证

```
node --disable-warning=ExperimentalWarning --test test/runtime/memory-tools.test.ts   → 7 passed
npm test                                                                              → 309 passed / 0 failed
npx tsc -p .                                                                          → 无错误
```

`test/runtime/memory-tools.test.ts` 的七个用例：

| 用例 | 钉住什么 |
|---|---|
| MT1 | 注册名、required=['query']、命中后 message 含正文、时间字段存在 |
| MT2 | 空 query / 纯空白 / 非字符串 → 抛错 |
| MT3 | limit=100 不超过 20；limit=0 夹到 1；NaN 退回默认 8 |
| MT4 | benchmark 数据不出现（工具面第二道闸） |
| MT5 | 无命中时明确说明并给下一步动作 |
| MT6 | dispose 注销工具 |
| MT7 | **端到端**：`startRuntime` 的 `toolNames` 含该工具；两轮对话后记忆库有 ≥3 条 turn，且原始正文在库里 |

MT7 是「生产生效」的最小证据：工具来自注册回执（不是手写常量），写入与读取路径同时在场。

**未做的真机验证**：`npm run chat` 里让真实模型自主调用该工具需要消耗 PRTS DeepSeek key，
按用户约束（非必要不用）未执行。替代证据是 MT7 的脚本化模型端到端。

## 复现

```sh
cd /c/prts-system
node --disable-warning=ExperimentalWarning --test test/runtime/memory-tools.test.ts
npm test
npx tsc -p .
```

---

## 三块补齐（同日续）

### 1. 巩固与退役的调度：`prts memory`

`src/cli/memory.ts`，接入 `prts.ts` 的顶层分发（原来只有一个嵌套三元，改成链式 if）。

| 子命令 | 行为 |
|---|---|
| `stats` | 打印 live / retired / deleted / permanent_live、巩固游标与实体/边/主题计数、画像与摘要数、最近退役候选 |
| `consolidate` | 触发一轮规则巩固（零模型），打印 `ConsolidateResult` JSON |
| `retire` | **默认 dry-run**；`--apply` 才写事件；支持 `--limit/--floor/--min-age-days` |
| `restore <factId...>` | 恢复退役项，打印实际恢复条数 |

库路径解析与运行时同序：`--db` > `PRTS_MEMORY_DB` > `<PRTS_DATA_ROOT>/memory.sqlite`。
`memoryCommand` 返回退出码、不调 `process.exit`，所以测试能直接调它（6 个用例）。

### 2. 用进废退：`fact.reinforced`

- `mem_facts` 增 `access_count` / `last_access_ms`（新库进 DDL，旧库 `ensureFactAccessColumns` 自愈迁移）。
- 强化以**绝对量**写事件（`access_count+1` 由调用方算好），`rebuildProjections()` 后精确还原。
- `MemoryStore.reinforceFacts()` 显式回写；`prts_memory_recall` 命中 fact 后自动调用，失败只打日志。
- 衰减用 `decayedImportance(..., accessCount)`：每召回一次半衰期 ×1.5，最多计 10 次（6 倍）。
  `accessCount = 0` 时数值与旧实现完全一致，既有基线零变化。
- 排序侧由 `rowImportance(r, nowMs)` 统一折算，三处 fact 打分（FTS / 向量 / LIKE）共用。

### 3. 每轮自动注入：`agent/pre-step`

`src/runtime/memory-inject.ts`。三条候选通道里只有它能改写本轮消息：

| 通道 | 为什么不行 / 行 |
|---|---|
| `system-prompt/assemble` | `AssembleContext` 拿不到本轮消息，且 `inbox.claim()` 在 assemble 之前就把消息移出了队列 |
| `agent/request` | `LlmCallConfig` 只有 provider/model，类型注释写明 cannot mutate messages |
| **`agent/pre-step`** | payload 带 `messages: UserMessage[]`，`next()` 返回 `{kind:'enter', messages}`，可安全追加 |

实现要点：先 `await next()` 再追加（否则会丢掉默认实现里的 runtime-context 投影）；
reject 原样透传；query 少于 4 字符不检索；同一 step 只注入一次；**整段 try/catch，检索失败返回原 decision**——
记忆是辅助，不能因为检索崩了让人这一轮说不了话。

### 验证（全部实测）

| 检查 | 结果 |
|---|---|
| `npm test` | **327 passed / 0 failed** |
| `npx tsc -p .` | 无错误 |
| `test/cli/memory-command.test.ts` | 6/6 |
| `test/memory/reinforce.test.ts` | 6/6（含 R6 排序断言：强化过的排在前面） |
| `test/runtime/memory-inject.test.ts` | 6/6 |

### 仍未解决（本轮新暴露）

**中文整句查询检索不到。** `tokenize()` 用 `/[\u4e00-\u9fff]{2,}/g` 把连续汉字当成**一个**
token，"我之前说过的光学偏好是什么"整体是一个长 token，FTS 与 LIKE 都命中不了；
只有用户恰好用空格/标点断开关键词时才有效。这是产品级缺陷，不是测试写法问题。
修复方向（未做）：中文分词，或对长汉字串做 2-gram 展开后再喂 FTS/LIKE。

**真机未验证**：`prts memory` 子命令与自动注入都只在测试里跑过。真机需要一次
`node src/cli/prts.ts memory stats --db C:\prts-benchmark\memory-s.sqlite` 与一轮真实对话
才能确认端到端可用（后者需消耗 PRTS key，按约束未执行）。
