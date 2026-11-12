/**
 * 压缩阈值配置的来源判定（RT1—RT6）。
 *
 * 为什么需要它：0.8 是 **DSH 的默认**（`dsh-compaction-basic/lib/index.js:15`
 * `DEFAULT_THRESHOLD_RATIO = .8`），不是 PRTS 的决定。架构需求 §5.3 第④条只说
 * 「超限时压缩」，没有定义「超限」是多少。把 0.8 直接写成默认值，等于让一个
 * 继承值冒充 PRTS 的策略——调用方看不到它从哪来，也就无从评估。
 *
 * 所以本函数把「用哪个值、它从哪来」一起返回：
 *   source='config'      PRTS 自己配的
 *   source='dsh-default' 没配，沿用 DSH 默认（附来源，供启动时打印）
 *   source='invalid'     配了但不是可用的数 → ratio 为 undefined，交给上层报配置不成立
 *
 * 注意 0 是合法值（明确要「任何占用都算超限」），不能按缺省处理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveThresholdRatio, DSH_DEFAULT_RATIO } from '../../src/runtime/compaction-policy.ts'

test('RT1 未配置 → 用 DSH 默认，且来源标为 dsh-default', () => {
  const r = resolveThresholdRatio(undefined)
  assert.equal(r.ratio, DSH_DEFAULT_RATIO)
  assert.equal(r.source, 'dsh-default')
})

test('RT2 空白串按未配置处理', () => {
  const r = resolveThresholdRatio('   ')
  assert.equal(r.ratio, DSH_DEFAULT_RATIO)
  assert.equal(r.source, 'dsh-default')
})

test('RT3 显式配置 → 用配置值，来源标为 config', () => {
  const r = resolveThresholdRatio('0.6')
  assert.equal(r.ratio, 0.6)
  assert.equal(r.source, 'config')
})

test('RT4 配置 0 是合法语义（任何占用都算超限），不是缺省', () => {
  const r = resolveThresholdRatio('0')
  assert.equal(r.ratio, 0)
  assert.equal(r.source, 'config')
})

test('RT5 非法配置 → ratio 为 undefined，来源标为 invalid（不悄悄退默认）', () => {
  for (const bad of ['abc', '-0.5', 'NaN', 'Infinity']) {
    const r = resolveThresholdRatio(bad)
    assert.equal(r.ratio, undefined, `${bad} 必须判为不可用`)
    assert.equal(r.source, 'invalid', `${bad} 必须标为 invalid`)
  }
})

test('RT6 DSH 默认常量本身是 0.8——与 dsh-compaction-basic:15 同值', () => {
  // 这个断言的意义：如果哪天 DSH 改了默认值，本仓的「继承」就不再成立，
  // 测试会红，逼人重新决定，而不是继续以为自己在跟随上游。
  assert.equal(DSH_DEFAULT_RATIO, 0.8)
})
