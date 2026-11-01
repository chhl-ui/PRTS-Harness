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
