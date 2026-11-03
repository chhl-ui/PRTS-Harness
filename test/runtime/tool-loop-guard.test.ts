/**
 * 工具循环检测的边界测试。
 *
 * 钉五条：阈值边界（4 次不报、5 次报）、参数不同不报、按会话分桶、
 * 键序不同视为同参、reset 生效。前三条是「不许误报」，最后两条是「不许漏报」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolLoopGuard, fingerprintArgs } from '../../src/runtime/tool-loop-guard.ts'

const obs = (sessionId: string, toolName: string, args: unknown) => ({ sessionId, toolName, args })

test('L1 连续 5 次同工具同参：第 5 次才 suspect', () => {
  const g = new ToolLoopGuard()
  const verdicts = Array.from({ length: 5 }, () => g.observe(obs('s1', 'read', { path: 'a.ts' })))
  assert.deepEqual(verdicts.slice(0, 4).map((v) => v.kind), ['ok', 'ok', 'ok', 'ok'], '1-4 次是正常重试，不许报')
  assert.equal(verdicts[4]!.kind, 'suspect')
  assert.equal(verdicts[4]!.count, 5)
})

test('L2 4 次相同不报（阈值边界，差一次也不行）', () => {
  const g = new ToolLoopGuard()
  const verdicts = Array.from({ length: 4 }, () => g.observe(obs('s1', 'read', { path: 'a.ts' })))
  assert.ok(verdicts.every((v) => v.kind === 'ok'))
})

test('L3 参数不同时计数重置（交替调用不算循环）', () => {
  const g = new ToolLoopGuard()
  const a = { path: 'a.ts' }
  const b = { path: 'b.ts' }
  const verdicts = [
    g.observe(obs('s1', 'read', a)),
    g.observe(obs('s1', 'read', b)),
    g.observe(obs('s1', 'read', a)),
    g.observe(obs('s1', 'read', b)),
    g.observe(obs('s1', 'read', a)),
  ]
  assert.ok(verdicts.every((v) => v.kind === 'ok'), '交替参数不是循环')
  // 工具名也算指纹的一部分：同名同参但工具不同，不得累加到同一个计数。
  const g2 = new ToolLoopGuard({ threshold: 3 })
  g2.observe(obs('s2', 'read', a))
  g2.observe(obs('s2', 'write', a))
  assert.equal(g2.observe(obs('s2', 'read', a)).kind, 'ok', '中间夹了 write，read 的连续计数被重置')
  g2.observe(obs('s2', 'read', a))
  assert.equal(g2.observe(obs('s2', 'read', a)).kind, 'suspect', 'read 这才连续 3 次')
})

test('L4 按 sessionId 分桶：两个会话各 3 次不合并成 6 次', () => {
  const g = new ToolLoopGuard()
  const args = { path: 'a.ts' }
  const verdicts = [
    ...Array.from({ length: 3 }, () => g.observe(obs('s1', 'read', args))),
    ...Array.from({ length: 3 }, () => g.observe(obs('s2', 'read', args))),
  ]
  assert.ok(verdicts.every((v) => v.kind === 'ok'), '并发子会话的同参重试不得并进同一计数')
})

test('L5 键序不同视为同一参数（模型两次生成的 JSON 键序可以不同）', () => {
  assert.equal(fingerprintArgs({ a: 1, b: 2 }), fingerprintArgs({ b: 2, a: 1 }))
  assert.notEqual(fingerprintArgs({ a: 1 }), fingerprintArgs({ a: 2 }))
  // 数组顺序有语义，不能排序。
  assert.notEqual(fingerprintArgs([1, 2]), fingerprintArgs([2, 1]))

  const g = new ToolLoopGuard({ threshold: 3 })
  g.observe(obs('s1', 'edit', { file: 'a.ts', old: 'x', new: 'y' }))
  g.observe(obs('s1', 'edit', { new: 'y', old: 'x', file: 'a.ts' }))
  assert.equal(g.observe(obs('s1', 'edit', { old: 'x', file: 'a.ts', new: 'y' })).kind, 'suspect', '键序不是新参数')
})

test('L6 reset 清掉指定会话（或全部）的计数', () => {
  const g = new ToolLoopGuard({ threshold: 3 })
  const args = { path: 'a.ts' }
  g.observe(obs('s1', 'read', args))
  g.observe(obs('s1', 'read', args))
  g.reset('s1')
  assert.equal(g.observe(obs('s1', 'read', args)).kind, 'ok', 'reset 后重新从 1 计')
  g.observe(obs('s1', 'read', args))
  assert.equal(g.observe(obs('s1', 'read', args)).kind, 'suspect')
  g.reset()
  assert.equal(g.observe(obs('s1', 'read', args)).kind, 'ok', 'reset() 清全部')
})
