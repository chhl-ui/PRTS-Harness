import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retainText } from '../../src/spill/retention.ts'

// 逐 code unit 扫描代理对：不依赖 ES2024 的 String.prototype.isWellFormed。
const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

test('R1: 预算充足时 head+tail 覆盖全文，omittedBytes 为 0', () => {
  const content = 'hello world'
  const r = retainText(content, 100)
  assert.equal(r.head + r.tail, content)
  assert.equal(r.omittedBytes, 0)
})

test('R2: 预算为 0 时 head 与 tail 皆空，omittedBytes 为全文字节数', () => {
  const r = retainText('abcdef', 0)
  assert.deepEqual(r, { head: '', tail: '', omittedBytes: 6 })
  assert.deepEqual(retainText('中文', -5), { head: '', tail: '', omittedBytes: 6 })
})

test('R3: 预算为 1 时 head 取 1 字符、tail 取 0 字符', () => {
  const r = retainText('abcdef', 1)
  assert.equal(r.head, 'a')
  assert.equal(r.tail, '')
  assert.equal(r.omittedBytes, 5)
})

test('R4: emoji 恰好跨切点时不留孤立代理项', () => {
  // 'ab' + '😀' + 'cdef'：😀 占下标 2-3，budget=5 时 ceil(5/2)=3 的切点正落在代理对中间。
  const content = 'ab😀cdef'
  const r = retainText(content, 5)
  assert.equal(r.head, 'ab')
  assert.equal(r.head.length, 2)
  assert.equal(r.tail, 'def')
  for (const piece of [r.head, r.tail]) {
    assert.ok(isWellFormed(piece), `切出的片段不应含孤立代理项：${JSON.stringify(piece)}`)
    assert.equal(Buffer.from(piece, 'utf8').toString('utf8'), piece)
  }
  // 头尾都经过 UTF-8 往返后仍与原串对应片段一致。
  assert.equal(Buffer.from(r.head + r.tail, 'utf8').toString('utf8'), r.head + r.tail)
  // head 少切 1、tail 多留 1：被省略区间左移一个字符，'😀'(4 字节) + 'c'(1 字节) = 5 字节。
  assert.equal(r.omittedBytes, 5)
})

test('R5: 中文按 UTF-8 字节计 omittedBytes', () => {
  const content = '中文测试'
  const r = retainText(content, 2)
  assert.equal(r.head, '中')
  assert.equal(r.tail, '试')
  // 12 字节原文 − 3 − 3 = 6
  assert.equal(r.omittedBytes, 6)
})

test('R6: 原文短于预算时原样保留', () => {
  const r = retainText('hi', 50)
  assert.equal(r.head + r.tail, 'hi')
  assert.equal(r.omittedBytes, 0)
})

test('R7: 奇数预算 head 多取 1 个字符', () => {
  const r = retainText('abcdefg', 5)
  assert.equal(r.head, 'abc')
  assert.equal(r.tail, 'fg')
  assert.equal(r.omittedBytes, 2)
})
