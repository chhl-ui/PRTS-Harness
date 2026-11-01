import test from 'node:test'

import assert from 'node:assert/strict'

import { encodeSegment } from '../../src/spill/encode.ts'

/**
 * 编码必须是注入式：不同输入编码成不同路径段，且输出里不含分隔符、
 * 不含可单独构成穿越的 `.` / `..`。
 */

test('安全字符原样保留', () => {
  assert.equal(encodeSegment('a.txt'), 'a.txt')
  assert.equal(encodeSegment('A-Z_0-9.md'), 'A-Z_0-9.md')
})

test('空串编码成 ~（永不产生空路径段）', () => {
  assert.equal(encodeSegment(''), '~')
})

test('单独的 . 与 .. 被转义，不能构成穿越', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('路径分隔符被转义，输出永远是单个路径段', () => {
  const encoded = encodeSegment('../x')
  assert.equal(encoded, '..~002Fx')
  assert.equal(encoded.includes('/'), false)
  assert.equal(encoded.includes('\\'), false)
})

test('反斜杠与盘符被转义', () => {
  assert.equal(encodeSegment('C:\\abs\\path'), 'C~003A~005Cabs~005Cpath')
})

test('~ 自身被转义，保证映射可逆', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

test('NUL 被转义', () => {
  assert.equal(encodeSegment('a\u0000b'), 'a~0000b')
})

test('中文与 emoji 按 UTF-16 码元转义', () => {
  assert.equal(encodeSegment('中文'), '~4E2D~6587')
  assert.equal(encodeSegment('\u{1F600}'), '~D83D~DE00')
})

test('不同输入不碰撞（~ 的转义保证注入性）', () => {
  assert.notEqual(encodeSegment('a/b'), encodeSegment('a~002Fb'))
  assert.notEqual(encodeSegment('.'), encodeSegment('~002E'))
  assert.notEqual(encodeSegment(''), encodeSegment('~'))
})

test('输出只含安全字符', () => {
  for (const raw of ['../x', 'C:\\a', 'a~b', '中文', '\u{1F600}', 'a\u0000b', '.', '..', '']) {
    assert.match(encodeSegment(raw), /^[A-Za-z0-9._\-~]+$/u, `输入 ${JSON.stringify(raw)} 的编码含非法字符`)
  }
})
