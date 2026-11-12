/**
 * 压缩决策策略层的边界与「同类隐患」测试（CB1—CB10）。
 *
 * `compaction-policy.test.ts` 的 CP1—CP7 钉住了五条主规则；这里补的是同一缺陷模式的
 * 兄弟实例：非法 / 非有限的每一个数值字段、预算与阈值相撞的两支 min、以及若干规则
 * 之间的优先级。核心命题只有一条：**信息不足不得伪装成 `skip`**，而坏配置不得
 * 误触发压缩。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompaction, type CompactionInput } from '../../src/runtime/compaction-policy.ts'

function base(): CompactionInput {
  return {
    usedTokens: 0,
    contextWindow: 1000,
    thresholdRatio: 0.5,
    outputReserve: 0,
    safetyMargin: 0,
    enabled: true,
  }
}

test('CB1 窗口非有限（±Infinity）→ undetermined / capacity-unknown', () => {
  for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const d = decideCompaction({ ...base(), usedTokens: 10, contextWindow: bad })
    assert.equal(d.action, 'undetermined', `contextWindow=${String(bad)} 必须判为信息不足`)
    assert.deepEqual(d, { action: 'undetermined', reason: 'capacity-unknown' })
  }
})

test('CB2 消息预算恰好为 0 → undetermined；多 1 就恢复判定', () => {
  const zero = decideCompaction({ ...base(), contextWindow: 356, usedTokens: 1, outputReserve: 256, safetyMargin: 100 })
  assert.deepEqual(zero, { action: 'undetermined', reason: 'no-message-budget' })

  // 预算 1：窗口 357 − 256 − 100 = 1。比例 1 → 阈值 = min(357, 1) = 1，已用 1 等于阈值 → 压。
  const one = decideCompaction({
    ...base(),
    contextWindow: 357,
    usedTokens: 1,
    thresholdRatio: 1,
    outputReserve: 256,
    safetyMargin: 100,
  })
  assert.deepEqual(one, { action: 'compact' })
})

test('CB3 阈值取「消息预算」那一支：窗口比例更高时被预算封顶', () => {
  // 窗口 500、比例 0.99 → 窗口侧 495；预留 100 → 预算 400。阈值应为 400，不是 495。
  const at = decideCompaction({ ...base(), contextWindow: 500, thresholdRatio: 0.99, outputReserve: 100, usedTokens: 400 })
  assert.deepEqual(at, { action: 'compact' }, '已用等于 400（预算）必须算超限')

  const below = decideCompaction({ ...base(), contextWindow: 500, thresholdRatio: 0.99, outputReserve: 100, usedTokens: 399 })
  assert.deepEqual(below, { action: 'skip', reason: 'below-threshold' }, '预算封顶后 399 仍低于阈值')
})

test('CB4 比例大于 1 → 封顶为 1，不越过消息预算', () => {
  const d = decideCompaction({ ...base(), usedTokens: 999, contextWindow: 1000, thresholdRatio: 5 })
  assert.deepEqual(d, { action: 'skip', reason: 'below-threshold' }, '阈值封顶 1000，已用 999 未到')

  const at = decideCompaction({ ...base(), usedTokens: 1000, contextWindow: 1000, thresholdRatio: 5 })
  assert.deepEqual(at, { action: 'compact' })
})

test('CB5 比例非法（NaN / 负数 / Infinity / 缺失）→ config-invalid，不拿端点值顶替', () => {
  // 为什么不是「按 1 退到消息预算」：比例决定「多早压」。悄悄换成 1 等于把压缩推到最晚，
  // 是往防溢出的反方向撤退；换成 0.8 又是原文与本层配置都没有的常量。配置坏了就该可见。
  const bads: unknown[] = [Number.NaN, -0.5, Number.POSITIVE_INFINITY, undefined]
  for (const bad of bads) {
    const d = decideCompaction({
      ...base(),
      usedTokens: 100,
      contextWindow: 1000,
      thresholdRatio: bad as number,
    })
    assert.deepEqual(d, { action: 'undetermined', reason: 'config-invalid' }, `thresholdRatio=${String(bad)} 必须报配置不成立`)
  }
})

test('CB6 输出预留 / 安全余量非法 → config-invalid，不按 0 放宽', () => {
  // 按 0 会让消息预算变大、压缩点推后——预留与余量本来就是为了给生成阶段留空间，
  // 把它们换成 0 等于拆掉这层保护，与 token-budget.ts「宁可少装」的方向相反。
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -128, undefined]) {
    const d = decideCompaction({
      ...base(),
      usedTokens: 500,
      contextWindow: 1000,
      thresholdRatio: 0.5,
      outputReserve: bad as number,
      safetyMargin: bad as number,
    })
    assert.deepEqual(d, { action: 'undetermined', reason: 'config-invalid' }, `outputReserve/safetyMargin=${String(bad)} 必须报配置不成立`)
  }
})

test('CB7 已用未知（NaN / 缺失）→ 不宣布 below-threshold', () => {
  const cases: unknown[] = [Number.NaN, undefined, null]
  for (const bad of cases) {
    const d = decideCompaction({ ...base(), usedTokens: bad as number, contextWindow: 1000, thresholdRatio: 0.5 })
    assert.deepEqual(d, { action: 'compact' }, `usedTokens=${String(bad)} 时不得报 skip`)
  }
})

test('CB8 关闭优先于窗口未知：enabled=false 时不要求调用方先解析窗口', () => {
  const d = decideCompaction({ ...base(), usedTokens: 1_000_000, contextWindow: undefined, enabled: false })
  assert.deepEqual(d, { action: 'skip', reason: 'disabled' })
})

test('CB9 负的已用按 0：不因坏值把结论翻成 compact', () => {
  const d = decideCompaction({ ...base(), usedTokens: -500, contextWindow: 1000, thresholdRatio: 0.5 })
  assert.deepEqual(d, { action: 'skip', reason: 'below-threshold' }, '阈值 500，负已用按 0 后仍低于阈值')
})

test('CB10 无模块级状态：连调不同输入互不影响，且不修改传入对象', () => {
  const first = Object.freeze({ ...base(), usedTokens: 900 })
  const a = decideCompaction(first)
  const b = decideCompaction({ ...base(), usedTokens: 1, contextWindow: 2000 })
  const c = decideCompaction(first)
  assert.deepEqual(a, { action: 'compact' })
  assert.deepEqual(b, { action: 'skip', reason: 'below-threshold' })
  assert.deepEqual(c, a, '同一输入重复调用必须给出同一结论')
  assert.equal(first.usedTokens, 900, '输入对象不得被就地修改')
})
