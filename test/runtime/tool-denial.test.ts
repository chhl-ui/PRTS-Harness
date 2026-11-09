/**
 * `isSandboxDenial` 的判定规则：把「read-only 档拒绝写入」从普通工具错误里挑出来。
 *
 * 真机文案（2026-11-09，`/sandbox view` 后模型调 write）：
 * `prts: 会话处于仅可查看（read-only）档，fs 写/删不可用（/sandbox edit 恢复）`
 *
 * 这条规则失效的代价是**审计漏记**，不是强制失效——写入照样被 DSH 拒。
 * 所以断言要钉「什么算拒绝」，不钉具体句式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSandboxDenial } from '../../src/runtime/tool-denial.ts'

test('TD1 真机文案 → 识别为 sandbox 拒绝', () => {
  const result = {
    isError: true,
    content: [{
      type: 'text',
      text: 'prts: 会话处于仅可查看（read-only）档，fs 写/删不可用（/sandbox edit 恢复）',
    }],
  }
  assert.equal(isSandboxDenial(result), true)
})

test('TD2 成功结果不误判', () => {
  assert.equal(isSandboxDenial({ isError: false, content: [{ type: 'text', text: 'ok' }] }), false)
  assert.equal(isSandboxDenial({ content: [{ type: 'text', text: 'ok' }] }), false, '缺 isError 也不得判为拒绝')
})

test('TD3 其他工具错误不误判（守卫拒绝、普通失败）', () => {
  assert.equal(isSandboxDenial({
    isError: true,
    content: [{ type: 'text', text: 'authority: 越界写入 C:\\Windows\\x 被拒绝' }],
  }), false)
  assert.equal(isSandboxDenial({ isError: true, content: [{ type: 'text', text: 'ENOENT: no such file' }] }), false)
})

test('TD4 非对象输入不崩', () => {
  for (const v of [null, undefined, 'str', 42, []]) {
    assert.equal(isSandboxDenial(v), false)
  }
})
