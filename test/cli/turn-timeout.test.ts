/**
 * 回合超时的来源（S10 教训：硬编码 120s 在本地模型上常态撞墙）。
 *
 * 判别点：
 * - 默认仍是 120s（不改变既有行为，云端模型够用）
 * - `PRTS_TURN_TIMEOUT_MS` 可覆盖（本地模型 59–71 t/s + 多工具调用，120s 不够）
 * - 非法值回落默认，不因配置笔误把超时变成 0 或负数
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTurnTimeoutMs, waitIdle } from '../../src/cli/chat.ts'

const withEnv = (v: string | undefined): (() => void) => {
  const prev = process.env.PRTS_TURN_TIMEOUT_MS
  if (v === undefined) delete process.env.PRTS_TURN_TIMEOUT_MS
  else process.env.PRTS_TURN_TIMEOUT_MS = v
  return () => {
    if (prev === undefined) delete process.env.PRTS_TURN_TIMEOUT_MS
    else process.env.PRTS_TURN_TIMEOUT_MS = prev
  }
}

test('T1 未设 env 时默认 120000ms（不改变既有行为）', () => {
  const restore = withEnv(undefined)
  try { assert.equal(resolveTurnTimeoutMs(), 120_000) } finally { restore() }
})

test('T2 PRTS_TURN_TIMEOUT_MS 可覆盖', () => {
  const restore = withEnv('300000')
  try { assert.equal(resolveTurnTimeoutMs(), 300_000) } finally { restore() }
})

test('T3 非法值回落默认，不把超时变成 0/负数', () => {
  for (const bad of ['abc', '0', '-5', '']) {
    const restore = withEnv(bad)
    try { assert.equal(resolveTurnTimeoutMs(), 120_000, `输入 ${JSON.stringify(bad)} 应回落默认`) } finally { restore() }
  }
})

test('T4 waitIdle 用给定预算且到底返回 false（不会一直等）', async () => {
  const agent = { status: 'running' } // 永不 idle
  const t0 = Date.now()
  const settled = await waitIdle(agent, 300)
  const elapsed = Date.now() - t0
  assert.equal(settled, false, '永不变 idle 时必须返回 false')
  assert.ok(elapsed < 2000, `应在预算附近返回，实际 ${elapsed}ms`)
})

test('T5 已 idle 的 agent 立即收敛', async () => {
  const settled = await waitIdle({ status: 'idle' }, 5000)
  assert.equal(settled, true)
})
