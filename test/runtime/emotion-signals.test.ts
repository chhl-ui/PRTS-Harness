/**
 * 情感事件源扩展：turn 正常收尾、博士验收 / 否定。
 *
 * 背景：`emotion-trigger.ts` 之前只接了一类事件（`agent/error`），而架构需求 §5.1
 * 写的是四类：「对话内容、任务成败、长时间未见、博士的反馈」。生产库
 * `emotion_events = 0` 就是这个缺口的直接证据——机制通，但没人喂它。
 *
 * 本模块补三类（第四类「长时间未见」要时钟，属于另一个组件，不在这里）：
 * - `agent/turn-stopping`（DSH 定义：turn 即将正常关闭）→ 轻微正向「顺利」
 * - `/accept`（博士验收任务）→ 正向「被认可」
 * - `/reject`（博士否定）→ 负向「受挫」
 *
 * 关键约束：**失败轮不许写正向**。`agent/error` 先行，turn-stopping 随后仍可能触发，
 * 所以由本模块自己记住「哪些 turn 失败过」，收尾时跳过。否则一次失败的回合
 * 会被后到的「顺利」覆盖，情绪与实际相反。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { EmotionStore } from '../../src/emotion/index.ts'
import { createEmotionSignals } from '../../src/runtime/emotion-signals.ts'
import { makeTmp } from '../support/tmp.ts'

function open(): { store: EmotionStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-emotion-sig-')
  return { store: EmotionStore.open(join(tmp.dir, 'emotion.sqlite')), tmp }
}

const errEntry = (turn: number) => ({ turn, step: 1, name: 'LLMError', code: 'bad_gateway', message: 'x', chain: [] })

test('ES1 turn 正常收尾 → 写「顺利」，且受节流保护', () => {
  const c = open()
  let now = 1_000_000
  try {
    const sig = createEmotionSignals({ store: c.store, now: () => now, turnEndThrottleMs: 60_000 })
    sig.onTurnStopping({ turn: 1 })
    assert.equal(c.store.get()?.label, '顺利', '正常收尾应写正向')

    now += 1_000 // 节流窗口内
    sig.onTurnStopping({ turn: 2 })
    const st = c.store.get()
    assert.equal(st?.label, '顺利', '节流窗口内不再覆盖')
    assert.equal(st?.revision, 1, '节流应该是「不写」，而不是写同值')
  } finally { c.tmp.cleanup(c.store) }
})

test('ES2 失败轮不写正向——error 先到，turn-stopping 随后必须跳过', () => {
  const c = open()
  try {
    const sig = createEmotionSignals({ store: c.store })
    sig.onError(errEntry(7))
    assert.equal(c.store.get()?.label, '受挫', '失败先写受挫')
    sig.onTurnStopping({ turn: 7 })
    assert.equal(c.store.get()?.label, '受挫', '同一 turn 的收尾不得把受挫改写成顺利')
    // 别的 turn 不受影响
    sig.onTurnStopping({ turn: 8 })
    assert.equal(c.store.get()?.label, '顺利')
  } finally { c.tmp.cleanup(c.store) }
})

test('ES3 博士验收 / 否定各有对应情绪', () => {
  const c = open()
  try {
    const sig = createEmotionSignals({ store: c.store })
    sig.onOwnerAccept('任务验收通过')
    const accepted = c.store.get()
    assert.equal(accepted?.label, '被认可')
    assert.ok((accepted?.valence ?? 0) > 0, '被认可应是正效价')

    sig.onOwnerReject('结果不达标')
    const rejected = c.store.get()
    assert.equal(rejected?.label, '受挫')
    assert.ok((rejected?.valence ?? 0) < 0, '被否定应是负效价')
  } finally { c.tmp.cleanup(c.store) }
})

test('ES4 情绪库写失败不得影响调用方（错误上报是诊断生命线）', () => {
  const broken = { update(): never { throw new Error('磁盘满') } } as unknown as EmotionStore
  const sig = createEmotionSignals({ store: broken })
  assert.doesNotThrow(() => sig.onError(errEntry(1)))
  assert.doesNotThrow(() => sig.onTurnStopping({ turn: 1 }))
  assert.doesNotThrow(() => sig.onOwnerAccept('x'))
  assert.doesNotThrow(() => sig.onOwnerReject('y'))
})
