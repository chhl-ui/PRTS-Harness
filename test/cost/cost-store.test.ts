/**
 * V1-16 费用计量的验收合同（只做费用，不做 P95 延迟）。
 *
 * 原文（架构需求 §7 V1-16）：「7 天试用的**模型费用与巩固费用分开计量**，
 * 不超过预先冻结的额度」。
 *
 * 现状：`Usage.costUsd` 只存在于任务账本（K1）里，是**任务级**的单个数；
 * 没有「模型 vs 巩固」分开，没有周期累计，没有冻结额度判定。
 *
 * 数据源已确认：`agent/assistant-stream` 的 `frame.chunk` 是 `StreamChunk`，
 * 其中 `{ type: 'usage', usage: TokenUsage }` 带 input/output/cache 四路 token
 * （`dsh-llm/lib/types/types.d.ts:160-174`）。
 *
 * 本文件钉住：
 *   CP* 计价（单价可配、四路分开、未配置时不编造金额）
 *   CS* 存储与汇总（两类分开、重启不丢、冻结额度判定、非法输入不污染）
 *
 * 基线预期：`src/cost/` 尚不存在 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openCostStore } from '../../src/cost/index.ts'
import { priceOf, priceFromEnv } from '../../src/cost/index.ts'
import { makeTmp } from '../support/tmp.ts'

const NOW = 1_700_000_000_000

/** 金额是浮点累加，断言用容差（`0.1 + 0.05` 在 IEEE754 下不等于 `0.15`）。 */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9

function fresh() {
  const t = makeTmp('prts-cost-')
  const store = openCostStore(t.db('cost.sqlite'))
  return { t, store }
}

// ---------------------------------------------------------------- 计价

test('CP1 四路 token 分别按单价计费（每百万 token 美元）', () => {
  const price = { inputPerM: 1, outputPerM: 2, cacheReadPerM: 0.1, cacheWritePerM: 0.5 }
  // 100万 input @1 + 50万 output @2 + 100万 cacheRead @0.1 + 100万 cacheWrite @0.5
  const usd = priceOf(
    { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
    price,
  )
  assert.equal(usd, 1 + 1 + 0.1 + 0.5)
})

test('CP2 未配置单价（全 0）：金额为 0，不编造', () => {
  const price = priceFromEnv({})
  assert.equal(price.inputPerM, 0)
  assert.equal(price.outputPerM, 0)
  assert.equal(priceOf({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, price), 0)
})

test('CP3 单价从环境变量读，非法值回落 0（不变成负数或 NaN）', () => {
  const price = priceFromEnv({
    PRTS_PRICE_INPUT_PER_M: '2.5',
    PRTS_PRICE_OUTPUT_PER_M: 'abc',
    PRTS_PRICE_CACHE_READ_PER_M: '-1',
    PRTS_PRICE_CACHE_WRITE_PER_M: 'NaN',
  })
  assert.equal(price.inputPerM, 2.5)
  assert.equal(price.outputPerM, 0, '非数字回落 0')
  assert.equal(price.cacheReadPerM, 0, '负数回落 0')
  assert.equal(price.cacheWritePerM, 0)
})

test('CP4 缺省 token 字段（cache 未上报）按 0 计', () => {
  const price = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 1, cacheWritePerM: 1 }
  assert.equal(priceOf({ inputTokens: 1_000_000, outputTokens: 0 }, price), 1)
})

// ---------------------------------------------------------------- 存储与汇总

test('CS1 空库：两类都是 0，未超额度', () => {
  const { t, store } = fresh()
  try {
    const s = store.summary()
    assert.equal(s.model.inputTokens, 0)
    assert.equal(s.model.usd, 0)
    assert.equal(s.consolidation.usd, 0)
    assert.equal(s.totalUsd, 0)
    assert.equal(s.exceeded, false)
  } finally { store.close(); t.cleanup() }
})

test('CS2 模型调用记账：token 与金额都进汇总', () => {
  const { t, store } = fresh()
  try {
    store.record({ kind: 'model', inputTokens: 1000, outputTokens: 200, usd: 0.01, recordedAtMs: NOW })
    const s = store.summary()
    assert.equal(s.model.inputTokens, 1000)
    assert.equal(s.model.outputTokens, 200)
    assert.equal(s.model.usd, 0.01)
    assert.equal(s.consolidation.usd, 0)
  } finally { store.close(); t.cleanup() }
})

test('CS3 两类分开计量：模型与巩固互不串账', () => {
  const { t, store } = fresh()
  try {
    store.record({ kind: 'model', inputTokens: 100, outputTokens: 10, usd: 0.1, recordedAtMs: NOW })
    store.record({ kind: 'consolidation', inputTokens: 500, outputTokens: 50, usd: 0.05, recordedAtMs: NOW })
    const s = store.summary()
    assert.equal(s.model.inputTokens, 100)
    assert.equal(s.consolidation.inputTokens, 500)
    assert.equal(s.model.usd, 0.1)
    assert.equal(s.consolidation.usd, 0.05)
    assert.ok(near(s.totalUsd, 0.15), `totalUsd 应为 0.15：实得 ${s.totalUsd}`)
  } finally { store.close(); t.cleanup() }
})

test('CS4 冻结额度：总费用超过 cap 时 exceeded=true', () => {
  const { t, store } = fresh()
  try {
    store.record({ kind: 'model', inputTokens: 1, outputTokens: 1, usd: 0.6, recordedAtMs: NOW })
    store.record({ kind: 'consolidation', inputTokens: 1, outputTokens: 1, usd: 0.5, recordedAtMs: NOW })
    assert.equal(store.summary({ capUsd: 2 }).exceeded, false, '1.1 ≤ 2')
    assert.equal(store.summary({ capUsd: 1 }).exceeded, true, '1.1 > 1')
    assert.equal(store.summary({ capUsd: 0 }).exceeded, true, 'cap=0 表示一分钱都不许花')
    assert.equal(store.summary().exceeded, false, '未设 cap 不判定超限')
  } finally { store.close(); t.cleanup() }
})

test('CS5 重启不丢：重开同一个库，累计仍在', () => {
  const t = makeTmp('prts-cost-r-')
  const dbPath = t.db('cost.sqlite')
  try {
    const s1 = openCostStore(dbPath)
    try {
      s1.record({ kind: 'model', inputTokens: 42, outputTokens: 7, usd: 0.001, recordedAtMs: NOW })
    } finally { s1.close() }
    const s2 = openCostStore(dbPath)
    try {
      const s = s2.summary()
      assert.equal(s.model.inputTokens, 42)
      assert.equal(s.model.usd, 0.001)
    } finally { s2.close() }
  } finally { t.cleanup() }
})

test('CS6 非法输入不污染累计：负 token 按 0，NaN 金额按 0', () => {
  const { t, store } = fresh()
  try {
    store.record({ kind: 'model', inputTokens: 100, outputTokens: 10, usd: 0.1, recordedAtMs: NOW })
    store.record({ kind: 'model', inputTokens: -5, outputTokens: Number.NaN, usd: Number.NaN, recordedAtMs: NOW })
    const s = store.summary()
    assert.equal(s.model.inputTokens, 100, '负 token 不抵扣')
    assert.equal(s.model.outputTokens, 10, 'NaN token 不污染')
    assert.equal(s.model.usd, 0.1, 'NaN 金额不污染')
  } finally { store.close(); t.cleanup() }
})

test('CS7 按时间窗过滤：sinceMs 之前的不计入', () => {
  const { t, store } = fresh()
  try {
    store.record({ kind: 'model', inputTokens: 10, outputTokens: 1, usd: 0.01, recordedAtMs: NOW - 1000 })
    store.record({ kind: 'model', inputTokens: 20, outputTokens: 2, usd: 0.02, recordedAtMs: NOW })
    assert.ok(near(store.summary({ sinceMs: NOW }).model.usd, 0.02), '时间窗内只有第二笔')
    assert.ok(near(store.summary().model.usd, 0.03), '全量两笔')
  } finally { store.close(); t.cleanup() }
})
