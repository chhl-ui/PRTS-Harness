/**
 * 重连退避的纯函数验收：单调不降、上限 5s、非法输入不制造等待。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconnectDelayMs } from '../../src/runtime/reconnect.ts'

test('RC1 退避：1s 起、每次 +1s、上限 5s', () => {
  assert.equal(reconnectDelayMs(1), 1000)
  assert.equal(reconnectDelayMs(2), 2000)
  assert.equal(reconnectDelayMs(3), 3000)
  assert.equal(reconnectDelayMs(5), 5000)
  assert.equal(reconnectDelayMs(10), 5000, '超过上限后保持 5s')
})

test('RC2 非法输入不制造等待', () => {
  assert.equal(reconnectDelayMs(0), 0)
  assert.equal(reconnectDelayMs(-3), 0)
  assert.equal(reconnectDelayMs(1.5), 0)
  assert.equal(reconnectDelayMs(Number.NaN), 0)
})

test('RC3 单调不降', () => {
  let prev = 0
  for (let n = 1; n <= 10; n += 1) {
    const d = reconnectDelayMs(n)
    assert.ok(d >= prev, `attempt ${n} 的等待 ${d} 小于前一次 ${prev}`)
    prev = d
  }
})
