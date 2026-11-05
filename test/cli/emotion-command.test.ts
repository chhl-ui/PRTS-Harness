/**
 * V1-05：`prts emotion` 子命令——情绪库的 owner 侧入口。
 *
 * 为什么需要它（2026-11-05 实测）：`src/emotion/` 的机制完整（写入者限制、
 * 读时衰减、每轮注入、与事实隔离），但 `applyEmotionEvent` 在 `src/` 里
 * **零调用**——运行时没有任何生产者，`renderMood()` 永远返回空串。
 * 也就是说：不补入口，「10 个情境样本」测到的会是「没有情感状态的普通对话」。
 *
 * 本测试钉住 owner 侧最小路径：set 能写、get 能读回、非法输入不写库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EmotionStore } from '../../src/emotion/index.ts'
import { emotionCommand } from '../../src/cli/emotion.ts'
import { makeTmp } from '../support/tmp.ts'

test('EM1 set 写入后 get 能读回同样的 label 与强度', () => {
  const t = makeTmp('prts-emotion-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    const code = emotionCommand([
      'set', '--data-root', dataRoot,
      '--valence', '0.2', '--arousal', '0.3',
      '--label', '低落', '--reason', '连续受挫',
    ])
    assert.equal(code, 0, 'set 应返回 0')

    const store = EmotionStore.open(join(dataRoot, 'emotion.sqlite'))
    try {
      const state = store.get()
      assert.equal(state?.label, '低落')
      assert.equal(state?.valence, 0.2)
      assert.equal(state?.arousal, 0.3)
      assert.equal(store.verifyChain().ok, true, '写入必须留链')
    } finally { store.close() }
  } finally {
    t.cleanup()
  }
})

test('EM2 get 在空库上返回 0 且不创建假状态', () => {
  const t = makeTmp('prts-emotion-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    assert.equal(emotionCommand(['get', '--data-root', dataRoot]), 0)
    const store = EmotionStore.open(join(dataRoot, 'emotion.sqlite'))
    try {
      assert.equal(store.get(), undefined, '空库不得凭空生成状态')
    } finally { store.close() }
  } finally {
    t.cleanup()
  }
})

test('EM3 非法标签/越界数值被拒，且不写库', () => {
  const t = makeTmp('prts-emotion-cli-')
  try {
    const dataRoot = join(t.dir, 'data')
    assert.notEqual(emotionCommand(['set', '--data-root', dataRoot, '--valence', '2', '--arousal', '0.3', '--label', 'x', '--reason', 'y']), 0, 'valence 越界必须拒绝')
    assert.notEqual(emotionCommand(['set', '--data-root', dataRoot, '--valence', '0.2', '--arousal', '0.3', '--label', '', '--reason', 'y']), 0, '空标签必须拒绝')
    const store = EmotionStore.open(join(dataRoot, 'emotion.sqlite'))
    try {
      assert.equal(store.get(), undefined, '被拒的调用不得留下状态')
    } finally { store.close() }
  } finally {
    t.cleanup()
  }
})
