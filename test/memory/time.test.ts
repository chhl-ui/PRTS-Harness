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

test('M6c 时间解析：LongMemEval 的 "YYYY/MM/DD (Day) HH:mm" 格式', () => {
  // 实测 longmemeval_oracle.json 的 haystack_dates 就是这个形态。
  // 首轮导入时 unparsedTime=948/948——解析器不认识它，真实数据才发现。
  assert.equal(parseTime('2023/04/10 (Mon) 17:50'), Date.UTC(2023, 3, 10, 17, 50))
  assert.equal(parseTime('2023/01/13 (Fri) 18:07'), Date.UTC(2023, 0, 13, 18, 7))
  assert.equal(parseTime('2023/03/15 (Wed) 00:56'), Date.UTC(2023, 2, 15, 0, 56))
  // 不带星期括号、不补零也要认
  assert.equal(parseTime('2023/4/10 17:50'), Date.UTC(2023, 3, 10, 17, 50))
})
