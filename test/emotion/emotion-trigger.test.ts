/**
 * V1-05 的系统侧生产者：轮次失败 → 自动写一条负面情绪。
 *
 * 为什么需要（2026-11-05 实测）：`applyEmotionEvent` 在 `src/` 里零调用——
 * 情绪库有完整的写入者限制、读时衰减、每轮注入，但**没有任何代码去写它**。
 * 结果 `renderMood()` 永远返回空串，情感状态在真实使用中从不变化。
 *
 * 三条硬约束：
 * 1. **节流**：连续失败不该把情绪压到底（同一窗口内只写一次）。
 * 2. **不拖垮上报**：情绪写入失败必须吞掉，绝不能让错误上报链断掉。
 * 3. **只写 system 通道**：模型不能自设情绪（库里 `requireWriter` 守着，这里用 system+component）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EmotionStore } from '../../src/emotion/index.ts'
import { createEmotionOnError } from '../../src/runtime/emotion-trigger.ts'
import { makeTmp } from '../support/tmp.ts'

const T0 = 1_800_000_000_000

const entry = (name = 'LlmError', code?: string): {
  turn: number
  step: number
  name: string
  code?: string
  message: string
  chain: string[]
} => ({ turn: 1, step: 1, name, code, message: 'boom', chain: [] })

test('E1 一次轮次失败写出负面情绪（system 通道）', () => {
  const t = makeTmp('prts-emo-trigger-')
  try {
    const store = EmotionStore.open(join(t.dir, 'emotion.sqlite'))
    try {
      const onError = createEmotionOnError({ store, now: () => T0 })
      onError(entry('LlmError', 'SERVER'))
      const s = store.get()
      assert.ok(s !== undefined, '必须写出状态')
      assert.ok(s.valence < 0, `valence 应为负，实际 ${s.valence}`)
      assert.equal(s.label, '受挫')
      assert.ok(s.arousal > 0, `arousal 应 > 0（受挫是激活的），实际 ${s.arousal}`)
      assert.equal(store.verifyChain().ok, true)
    } finally { store.close() }
  } finally { t.cleanup() }
})

test('E2 节流窗口内第二次失败不重复写（情绪不被连续失败压到底）', () => {
  const t = makeTmp('prts-emo-trigger-')
  try {
    const store = EmotionStore.open(join(t.dir, 'emotion.sqlite'))
    try {
      let now = T0
      const onError = createEmotionOnError({ store, now: () => now, throttleMs: 10 * 60_000 })
      onError(entry('LlmError'))
      const first = store.get()
      now = T0 + 60_000 // 1 分钟后
      onError(entry('LlmError'))
      const second = store.get()
      assert.equal(second?.updatedAt, first?.updatedAt, '窗口内不应重写（updatedAt 不变）')
      now = T0 + 11 * 60_000 // 超过窗口
      onError(entry('LlmError'))
      const third = store.get()
      assert.notEqual(third?.updatedAt, first?.updatedAt, '超过窗口后应重写')
    } finally { store.close() }
  } finally { t.cleanup() }
})

test('E3 情绪写失败不冒泡（不能拖垮错误上报链）', () => {
  const t = makeTmp('prts-emo-trigger-')
  try {
    const store = EmotionStore.open(join(t.dir, 'emotion.sqlite'))
    const broken = {
      update: () => { throw new Error('disk full') },
    } as unknown as EmotionStore
    const onError = createEmotionOnError({ store: broken, now: () => T0 })
    assert.doesNotThrow(() => onError(entry('LlmError')), '失败必须被吞掉')
    // 同时确认正常 store 不因此受影响
    const onError2 = createEmotionOnError({ store, now: () => T0 })
    assert.doesNotThrow(() => onError2(entry('LlmError')))
    store.close()
  } finally { t.cleanup() }
})

test('E4 节流按实例隔离（两个会话互不影响）', () => {
  const t = makeTmp('prts-emo-trigger-')
  try {
    const store = EmotionStore.open(join(t.dir, 'emotion.sqlite'))
    try {
      const a = createEmotionOnError({ store, now: () => T0, throttleMs: 10 * 60_000 })
      const b = createEmotionOnError({ store, now: () => T0, throttleMs: 10 * 60_000 })
      a(entry('LlmError'))
      const afterA = store.get()?.updatedAt
      const revA = store.get()?.revision ?? 0
      // b 自己的窗口是空的，应当能写（哪怕立刻）——用 revision 证明它真的写了
      b(entry('TimeoutError'))
      const revB = store.get()?.revision ?? 0
      assert.ok(afterA !== undefined)
      assert.equal(revB, revA + 1, `b 应独立于 a 的节流写入（revision 应 +1），实际 ${revA} → ${revB}`)
    } finally { store.close() }
  } finally { t.cleanup() }
})
