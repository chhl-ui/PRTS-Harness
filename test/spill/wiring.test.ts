import test from 'node:test'

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createSpillPolicy } from '../../src/spill/policy.ts'
import { createLocalSpillStore } from '../../src/spill/store.ts'
import { makeTmp } from '../support/tmp.ts'
import type { SpillStore } from '../../src/spill/types.ts'

const LONG = `${'a'.repeat(20_000)}TAIL_MARKER`

function setup(overrides: Partial<Parameters<typeof createSpillPolicy>[0]> = {}) {
  const t = makeTmp('prts-spill-policy-')
  const warnings: string[] = []
  const deps = {
    store: createLocalSpillStore({ root: join(t.dir, 'spill') }) as SpillStore,
    maxInlineTokens: 100,
    sessionMaxBytes: 64 * 1024 * 1024,
    sessionMaxFiles: 200,
    warn: (m: string) => { warnings.push(m) },
    ...overrides,
  }
  return { t, deps, warnings, policy: createSpillPolicy(deps) }
}

const input = (over: Partial<{ sessionId: string; toolName: string; callId: string; isError: boolean; text: string }> = {}) => ({
  sessionId: 's1', toolName: 'pwsh', callId: 'c1', isError: false, text: LONG, ...over,
})

test('T1 超阈值且存储可用 → 截断，locator 指向的文件逐字等于原文', async () => {
  const { t, policy } = setup()
  try {
    const out = await policy.maybeSpill(input())
    assert.ok(out, '应当返回替换结果')
    assert.match(out.text, /\[\.\.\.\]/)
    assert.ok(out.text.length < LONG.length)
    // 从提示里取出路径，读回原文比对。
    const m = out.text.match(/已存至 (.+?)，/)
    assert.ok(m, '提示里应含存储路径')
    assert.equal(readFileSync(m[1], 'utf8'), LONG)
  } finally { t.cleanup() }
})

test('T2 存储抛错 → 返回 undefined（调用方保留原内联结果）并告警', async () => {
  const { t, policy, warnings } = setup()
  try {
    const failing: SpillStore = { saveText: () => Promise.reject(new Error('ENOSPC')) }
    const p = createSpillPolicy({
      store: failing, maxInlineTokens: 100, sessionMaxBytes: 1e9, sessionMaxFiles: 999,
      warn: (m) => { warnings.push(m) },
    })
    const out = await p.maybeSpill(input())
    assert.equal(out, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /ENOSPC/)
  } finally { t.cleanup() }
})

test('T3 read 工具的结果不替换（防套娃）', async () => {
  const { t, policy } = setup()
  try {
    assert.equal(await policy.maybeSpill(input({ toolName: 'read' })), undefined)
  } finally { t.cleanup() }
})

test('T4 sessionId 为空 → 不替换、不写文件、告警只一次', async () => {
  const { t, policy, warnings } = setup()
  try {
    assert.equal(await policy.maybeSpill(input({ sessionId: '' })), undefined)
    assert.equal(await policy.maybeSpill(input({ sessionId: '' })), undefined)
    assert.equal(warnings.length, 1, '同一原因的告警应去重')
    assert.equal(existsSync(join(t.dir, 'spill')), false, '不应创建任何存储')
  } finally { t.cleanup() }
})

test('T4b 超会话字节上限 → 不替换且不新增文件', async () => {
  const { t, policy } = setup({ sessionMaxBytes: 1000 })
  try {
    assert.equal(await policy.maybeSpill(input()), undefined, '首次已超上限应当直接跳过')
    const root = join(t.dir, 'spill')
    assert.equal(existsSync(root) ? readdirSync(root).length : 0, 0)
  } finally { t.cleanup() }
})

test('T4c 超会话文件数上限 → 不替换', async () => {
  const { t, policy } = setup({ sessionMaxFiles: 0 })
  try {
    assert.equal(await policy.maybeSpill(input()), undefined)
  } finally { t.cleanup() }
})

test('isError 的结果不替换（截断错误信息会丢诊断价值）', async () => {
  const { t, policy } = setup()
  try {
    assert.equal(await policy.maybeSpill(input({ isError: true })), undefined)
  } finally { t.cleanup() }
})

test('未超阈值 → 不替换', async () => {
  const { t, policy } = setup({ maxInlineTokens: 100_000 })
  try {
    assert.equal(await policy.maybeSpill(input({ text: 'short' })), undefined)
  } finally { t.cleanup() }
})

test('store 未提供（未启用）→ 不替换', async () => {
  const t = makeTmp('prts-spill-off-')
  try {
    const p = createSpillPolicy({
      store: undefined, maxInlineTokens: 1, sessionMaxBytes: 1e9, sessionMaxFiles: 10,
      warn: () => { /* 预期不告警 */ },
    })
    assert.equal(await p.maybeSpill(input()), undefined)
  } finally { t.cleanup() }
})

test('替换结果保留头部与尾部标记', async () => {
  const { t, policy } = setup()
  try {
    const out = await policy.maybeSpill(input())
    assert.ok(out)
    assert.equal(out.text.startsWith('a'.repeat(10)), true, '应保留原文头部')
    assert.equal(out.text.includes('TAIL_MARKER'), true, '应保留原文尾部')
  } finally { t.cleanup() }
})
