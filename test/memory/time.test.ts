import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTime } from '../../src/memory/time.ts'

test('M6 时间解析：LoCoMo 的自由文本格式', () => {
  // "1:56 pm on 8 May, 2023" —— 实测 locomo10.json 的 session_1_date_time
  assert.equal(parseTime('1:56 pm on 8 May, 2023'), Date.UTC(2023, 4, 8, 13, 56))
  assert.equal(parseTime('9:05 am on 1 January, 2022'), Date.UTC(2022, 0, 1, 9, 5))
  assert.equal(parseTime('12:00 am on 31 December, 2023'), Date.UTC(2023, 11, 31, 0, 0))
  assert.equal(parseTime('12:30 pm on 15 June, 2024'), Date.UTC(2024, 5, 15, 12, 30))
})

test('M6b 时间解析：ISO 与纯日期', () => {
  assert.equal(parseTime('2023-05-08T13:56:00Z'), Date.UTC(2023, 4, 8, 13, 56))
  assert.equal(parseTime('2023-05-08'), Date.UTC(2023, 4, 8))
  assert.equal(parseTime('8 May 2023'), Date.UTC(2023, 4, 8))
  assert.equal(parseTime('May 8, 2023'), Date.UTC(2023, 4, 8))
})

test('M7 无法解析的时间返回 null（调用方保留原始串，不丢证据）', () => {
  for (const bad of ['', 'garbage', 'sometime last week', '2023-13-45']) {
    assert.equal(parseTime(bad), null, `应拒绝: ${bad}`)
  }
})
