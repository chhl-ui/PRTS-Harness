/**
 * 压缩决策策略层的「配置项异常」边界（CE1—CE14）。
 *
 * 与 `compaction-policy-boundaries.test.ts`（CB1—CB10）不重叠：CB 钉的是窗口 / 预算 /
 * 比例三支主规则的边界，这里钉的是**同一层里每一条自由裁量的口径**——
 *
 * 1. 规格五条规则只显式要求窗口与消息预算「算不出来 → undetermined」。其余字段
 *    （比例 / 预留 / 余量 / 已用）坏掉时，本层退到安全端点：比例 → 消息预算端点、
 *    预留与余量 → 0、已用 → 按超限。CE1—CE5 把这条口径钉成可执行事实：比例不可用
 *    与比例 1 结论逐例相同，且此时的 `skip` 仍断言一个实算事实（已用 < 消息预算）。
 * 2. 规则 2 / 3 的「容量」理由不得被借用：CE3 保证窗口合法时永远不出现
 *    `capacity-unknown`。理由的种类是给调用方看的，不能漂移。
 * 3. 优先级：关闭 → 窗口 → 预算。CE9—CE11 钉住跨分支的先后。
 * 4. 不取整：阈值与预算都保留原始精度（CE12）。
 *
 * 纯行为测试：只调 `decideCompaction`，不读实现内部。
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

test('CE1 比例不可用 → config-invalid，不退化到任何端点值', () => {
  // 旧断言曾要求「与比例 1 结论逐例相同」——那是把候选自己的裁量当成了规格。
  // 退到 1 等于把压缩推到最晚（往防溢出的反方向撤退）；退到 0.8 则是原文与本层
  // 都没有的常量。配置坏了必须可见，由读配置那一层去修。
  const unusable: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.5, -1e9, undefined]
  for (const bad of unusable) {
    for (const used of [0, 100, 999, 1000]) {
      const d = decideCompaction({ ...base(), usedTokens: used, thresholdRatio: bad as number })
      assert.deepEqual(d, { action: 'undetermined', reason: 'config-invalid' }, `比例=${String(bad)} 且已用=${used} 时必须报配置不成立`)
    }
  }
})

test('CE2 比例不可用时一律 config-invalid，与已用多少无关', () => {
  // 配置不成立的结论不受运行时占用影响：已用接近上限也不该被「顺手压一次」掩盖。
  for (const used of [0, 500, 1000, 1e9]) {
    const d = decideCompaction({
      ...base(),
      contextWindow: 1000,
      thresholdRatio: Number.NaN,
      outputReserve: 300,
      safetyMargin: 200,
      usedTokens: used,
    })
    assert.deepEqual(d, { action: 'undetermined', reason: 'config-invalid' }, `已用=${used} 时仍必须报配置不成立`)
  }
})

test('CE3 窗口合法时绝不出现 capacity-unknown：容量理由不得被借去表达「配置坏了」', () => {
  for (const used of [0, 1200]) {
    const d = decideCompaction({ ...base(), usedTokens: used, contextWindow: 1000, thresholdRatio: Number.NaN })
    // 比例坏了要报 `config-invalid`——它和 `capacity-unknown` 对调用方意味着不同的修法：
    // 前者去改配置，后者去查模型窗口。理由的种类不能漂移，这正是本条要守的东西。
    assert.deepEqual(d, { action: 'undetermined', reason: 'config-invalid' }, `已用=${used} 时必须报配置理由，而不是容量理由`)
  }
})

test('CE4 比例 0 与 -0：明确要「任何占用都算超限」，0 占用即压', () => {
  for (const zero of [0, -0]) {
    const d = decideCompaction({ ...base(), usedTokens: 0, contextWindow: 1000, thresholdRatio: zero })
    assert.deepEqual(d, { action: 'compact' }, `thresholdRatio=${Object.is(zero, -0) ? '-0' : '0'} 时阈值应为 0`)
  }
})

test('CE5 极小的合法比例不等于 0：阈值仍为正数，0 占用不算超限', () => {
  const zeroUsed = decideCompaction({ ...base(), usedTokens: 0, contextWindow: 1000, thresholdRatio: 1e-9 })
  assert.deepEqual(zeroUsed, { action: 'skip', reason: 'below-threshold' }, '0 < 正阈值')

  const oneUsed = decideCompaction({ ...base(), usedTokens: 1, contextWindow: 1000, thresholdRatio: 1e-9 })
  assert.deepEqual(oneUsed, { action: 'compact' }, '1 >= 极小正阈值')
})

test('CE6 已用不是 number（字符串 / 布尔 / 对象）→ 不宣布 below-threshold', () => {
  for (const bad of ['900', true, {}, [900]] as unknown[]) {
    const d = decideCompaction({ ...base(), usedTokens: bad as number, contextWindow: 1000, thresholdRatio: 0.5 })
    assert.deepEqual(d, { action: 'compact' }, `usedTokens=${String(bad)} 时不得报 skip`)
  }
})

test('CE7 窗口不是 number（字符串 / 布尔 / 对象）→ undetermined / capacity-unknown', () => {
  for (const bad of ['1000', true, {}] as unknown[]) {
    const d = decideCompaction({ ...base(), usedTokens: 10, contextWindow: bad as number })
    assert.deepEqual(d, { action: 'undetermined', reason: 'capacity-unknown' }, `contextWindow=${String(bad)}`)
  }
})

test('CE8 只有严格 false 才算关闭：undefined / 0 / 字符串 都继续判定', () => {
  for (const enabled of [undefined, 0, 'false', null] as unknown[]) {
    const d = decideCompaction({ ...base(), usedTokens: 100, enabled: enabled as boolean })
    assert.deepEqual(d, { action: 'skip', reason: 'below-threshold' }, `enabled=${String(enabled)} 不得报 disabled`)
  }
})

test('CE9 预算为 0 且已用为 0 → undetermined，0 占用也不能宣布「不用压」', () => {
  const d = decideCompaction({
    ...base(),
    contextWindow: 356,
    outputReserve: 256,
    safetyMargin: 100,
    usedTokens: 0,
  })
  assert.deepEqual(d, { action: 'undetermined', reason: 'no-message-budget' })
})

test('CE10 关闭优先于预算被吃光：enabled=false 时不进入预算判定', () => {
  const d = decideCompaction({
    ...base(),
    contextWindow: 10,
    outputReserve: 1e9,
    safetyMargin: 1e9,
    usedTokens: 999_999,
    enabled: false,
  })
  assert.deepEqual(d, { action: 'skip', reason: 'disabled' })
})

test('CE11 窗口判定优先于预算判定：窗口非法时报 capacity-unknown，不报 no-message-budget', () => {
  const d = decideCompaction({ ...base(), contextWindow: 0, outputReserve: 1e9, safetyMargin: 1e9, usedTokens: 1 })
  assert.deepEqual(d, { action: 'undetermined', reason: 'capacity-unknown' })
})

test('CE12 阈值与预算都不取整：非整数边界按原值比较', () => {
  // 窗口 1000 × 比例 0.3125 = 312.5（二进制精确），预算 1000 → 阈值 312.5。
  assert.deepEqual(
    decideCompaction({ ...base(), usedTokens: 312.5, contextWindow: 1000, thresholdRatio: 0.3125 }),
    { action: 'compact' },
  )
  assert.deepEqual(
    decideCompaction({ ...base(), usedTokens: 312.4, contextWindow: 1000, thresholdRatio: 0.3125 }),
    { action: 'skip', reason: 'below-threshold' },
  )

  // 窗口 1000、预留 500.5 → 预算 499.5，比例 0.99 的窗口侧 990 被封顶为 499.5。
  assert.deepEqual(
    decideCompaction({ ...base(), usedTokens: 499.5, contextWindow: 1000, thresholdRatio: 0.99, outputReserve: 500.5 }),
    { action: 'compact' },
  )
  assert.deepEqual(
    decideCompaction({ ...base(), usedTokens: 499.4, contextWindow: 1000, thresholdRatio: 0.99, outputReserve: 500.5 }),
    { action: 'skip', reason: 'below-threshold' },
  )
})

test('CE13 预留 / 余量整字段缺失 → config-invalid，不按 0 放宽', () => {
  // 旧断言要求「按 0，预算 = 1000，阈值 = 500」——等于把两个缺失的配置当成「不留预留」，
  // 而那正是压缩点被推后、生成阶段失去保护的那条路。
  const input = { usedTokens: 500, contextWindow: 1000, thresholdRatio: 0.5, enabled: true } as unknown as CompactionInput
  assert.deepEqual(decideCompaction(input), { action: 'undetermined', reason: 'config-invalid' }, '缺字段是配置不成立，不是「不留预留」')
})

test('CE14 窗口 -0 与极小负数同样按「未知」：0 的另一种写法不算合法窗口', () => {
  for (const bad of [-0, -0.0001]) {
    const d = decideCompaction({ ...base(), contextWindow: bad, usedTokens: 1 })
    assert.deepEqual(d, { action: 'undetermined', reason: 'capacity-unknown' })
  }
})
