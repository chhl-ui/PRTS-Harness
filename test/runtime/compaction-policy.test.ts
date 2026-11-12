/**
 * 压缩决策的策略层（CP1—CP7）。
 *
 * 依据 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §5.3 第④条
 * 「压缩：超限时先移除低相关材料与可回读的原文，再压缩旧对话。压缩结果保留指向
 * 原文的引用」与第③条「未知窗口不按无限处理」。
 *
 * 为什么需要这一层：DSH 的 `compactIfNeeded` 在 `requestHeader` / `routedTarget`
 * 为空时静默 `return null`（dsh-compaction-basic/lib/index.js:932-935），
 * 既不压也不报告。PRTS 的取向相反——信息不足必须可见，不能伪装成「不需要压」。
 *
 * 所以本层把二值（压/不压）改成三态：
 *   compact      确定要压
 *   skip         确定不压（带理由）
 *   undetermined 信息不足，既不能压也不能装作没事——必须上报
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompaction } from '../../src/runtime/compaction-policy.ts'

test('CP1 已用超过阈值 → compact', () => {
  const d = decideCompaction({
    usedTokens: 3846,
    contextWindow: 2000,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 0,
    enabled: true,
  })
  assert.equal(d.action, 'compact')
})

test('CP2 未到阈值 → skip，理由是低于阈值', () => {
  const d = decideCompaction({
    usedTokens: 100,
    contextWindow: 2000,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 0,
    enabled: true,
  })
  assert.equal(d.action, 'skip')
  assert.equal(d.reason, 'below-threshold')
})

test('CP3 窗口未知 → undetermined，不得退化成 skip', () => {
  const d = decideCompaction({
    usedTokens: 100_000,
    contextWindow: undefined,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 0,
    enabled: true,
  })
  assert.equal(d.action, 'undetermined')
  assert.equal(d.reason, 'capacity-unknown')
})

test('CP4 窗口非法（0 / NaN / 负数）同样 → undetermined', () => {
  for (const bad of [0, Number.NaN, -1]) {
    const d = decideCompaction({
      usedTokens: 100,
      contextWindow: bad,
      thresholdRatio: 0.8,
      outputReserve: 256,
      safetyMargin: 0,
      enabled: true,
    })
    assert.equal(d.action, 'undetermined', `contextWindow=${String(bad)} 必须判为信息不足`)
  }
})

test('CP5 显式关闭 → skip，理由为 disabled（关闭是明确表态，不是信息不足）', () => {
  const d = decideCompaction({
    usedTokens: 999_999,
    contextWindow: 2000,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 0,
    enabled: false,
  })
  assert.equal(d.action, 'skip')
  assert.equal(d.reason, 'disabled')
})

test('CP6 窗口被输出预留与安全余量吃光 → undetermined，不静默当 0 处理', () => {
  const d = decideCompaction({
    usedTokens: 10,
    contextWindow: 300,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 128,
    enabled: true,
  })
  assert.equal(d.action, 'undetermined')
  assert.equal(d.reason, 'no-message-budget')
})

test('CP7 阈值必须严格可比：等于阈值算超限（与「超限时压缩」同向）', () => {
  const d = decideCompaction({
    usedTokens: 1600,
    contextWindow: 2000,
    thresholdRatio: 0.8,
    outputReserve: 256,
    safetyMargin: 0,
    enabled: true,
  })
  assert.equal(d.action, 'compact')
})
