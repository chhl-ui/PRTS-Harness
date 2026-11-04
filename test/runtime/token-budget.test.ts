/**
 * 上下文装配 ③ 预算层的验收合同。
 *
 * 原文（`docs/context-assembly-status.md:17`）：
 * 「**预算** = min(配置上限, 模型窗口 − 输出预留 − 安全余量)；未知窗口不按无限处理」。
 *
 * 现状缺口：`memory-inject.ts:127` 只有条数上限 `limit: 5`，没有 token 预算层；
 * 窗口来自 `config/prts.yml:20` 的 `defaultContextWindow: 1000000`，未知时会被当成
 * 无限大——这正是原文点名要避免的。
 *
 * 本文件钉住两件事：
 *   TB* 预算怎么算（纯函数，含未知窗口 / 非法输入 / 已用超限 / 单调性）
 *   FB* 预算怎么裁（保序前缀、单条超限、零预算）
 *
 * 基线预期：`src/runtime/token-budget.ts` 尚不存在 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTokenBudget, fitToBudget } from '../../src/runtime/token-budget.ts'

test('TB1 已知窗口：min(配置上限, 窗口 − 输出预留 − 安全余量 − 已用)', () => {
  // 128000 - 8192 - 2048 = 117760
  assert.equal(resolveTokenBudget({ contextWindow: 128_000 }), 117_760)
  // 5000 - 100 - 50 = 4850
  assert.equal(
    resolveTokenBudget({ contextWindow: 5_000, outputReserve: 100, safetyMargin: 50 }),
    4_850,
  )
})

test('TB2 未知窗口：用保守上限，不按无限处理', () => {
  assert.equal(resolveTokenBudget({}), 4_000)
  assert.equal(resolveTokenBudget({ contextWindow: null }), 4_000)
  assert.equal(resolveTokenBudget({ contextWindow: 0 }), 4_000)
  assert.equal(resolveTokenBudget({ contextWindow: Number.NaN }), 4_000)
  assert.equal(resolveTokenBudget({ unknownBudgetTokens: 2_000 }), 2_000)
  // 未知窗口时也受已用挤压
  assert.equal(resolveTokenBudget({ usedTokens: 3_500 }), 500)
})

test('TB3 配置上限更小时取配置上限；0 是合法的显式归零', () => {
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, configMaxTokens: 1_500 }), 1_500)
  // 配置上限更大时不越过窗口
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, configMaxTokens: 999_999 }), 117_760)
  // 0 = 博士真的想关掉注入，不是「没配」
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, configMaxTokens: 0 }), 0)
})

test('TB4 已用 token 挤压：剩余不足时降到 0，不为负', () => {
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, usedTokens: 120_000 }), 0)
  // 128000 - 8192 - 2048 - 117000 = 760
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, usedTokens: 117_000 }), 760)
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, usedTokens: 100 }), 117_660)
})

test('TB5 非法输入一律回落默认，不变成 0 也不变成无限', () => {
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, outputReserve: Number.NaN }), 117_760)
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, safetyMargin: -5 }), 117_760)
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, usedTokens: -10 }), 117_760, '负的已用按 0')
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, usedTokens: Number.POSITIVE_INFINITY }), 117_760)
  assert.equal(resolveTokenBudget({ contextWindow: 128_000, configMaxTokens: Number.NaN }), 117_760)
})

test('TB6 结果是整数（floor）', () => {
  // 20000 - 8192 - 2048 = 9760
  assert.equal(resolveTokenBudget({ contextWindow: 20_000 }), 9_760)
  assert.equal(resolveTokenBudget({ contextWindow: 20_001 }), 9_761)
  const b = resolveTokenBudget({ contextWindow: 20_001, outputReserve: 8_192.5 })
  assert.equal(Number.isInteger(b), true, `必须是整数：实得 ${b}`)
})

test('TB7 窗口装不下开销：自然落 0，且对窗口单调（无断崖）', () => {
  assert.equal(resolveTokenBudget({ contextWindow: 1_001 }), 0, '1001 远小于预留+余量')
  assert.equal(resolveTokenBudget({ contextWindow: 10_240 }), 0, '恰好等于预留+余量 → 0')
  assert.equal(resolveTokenBudget({ contextWindow: 10_241 }), 1, '多 1 就是 1，不是跳变')
  assert.equal(resolveTokenBudget({ contextWindow: 10_242 }), 2)
})

test('FB1 预算充足：全部保留，顺序不变', () => {
  const r = fitToBudget(['a', 'b', 'c'], 100, () => 10)
  assert.deepEqual(r.kept, ['a', 'b', 'c'])
  assert.equal(r.usedTokens, 30)
  assert.equal(r.dropped, 0)
})

test('FB2 预算不足：保留前缀，超出的丢弃', () => {
  const r = fitToBudget(['a', 'b', 'c'], 25, () => 10)
  assert.deepEqual(r.kept, ['a', 'b'])
  assert.equal(r.usedTokens, 20)
  assert.equal(r.dropped, 1)
})

test('FB3 单条超预算：整条跳过，不截断', () => {
  const r = fitToBudget(['big', 'small'], 50, (s: string) => (s === 'big' ? 100 : 10))
  assert.deepEqual(r.kept, [])
  assert.equal(r.usedTokens, 0)
  assert.equal(r.dropped, 2, '截断的注入正文会变成半句话，比不注入更坏')
})

test('FB4 零/负预算：全部丢弃', () => {
  for (const budget of [0, -1, Number.NaN]) {
    const r = fitToBudget(['a'], budget, () => 1)
    assert.deepEqual(r.kept, [], `budget=${budget} 应全丢`)
    assert.equal(r.dropped, 1)
  }
})

test('FB5 costOf 返回非法值按 0 计，不污染累加', () => {
  const r = fitToBudget(['a', 'b', 'c'], 10, (s: string) => (s === 'b' ? Number.NaN : 5))
  assert.deepEqual(r.kept, ['a', 'b', 'c'], 'NaN 成本按 0，不应导致后续全部丢弃')
  assert.equal(r.usedTokens, 10)
})
