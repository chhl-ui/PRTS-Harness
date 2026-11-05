/**
 * `prts emotion` —— 情绪库的 owner 侧入口（V1-05）。
 *
 * 为什么需要它：`src/emotion/` 的机制完整（写入者只认 owner 与 system、
 * 读时衰减、每轮注入、与事实隔离），但 `applyEmotionEvent` 在 `src/` 里
 * **零调用**——运行时没有任何生产者，`renderMood()` 永远返回空串。
 * 没有本入口，情感状态在真实使用中不会被设定过，「10 个情境样本」也就无从验证。
 *
 * 边界（照 `src/emotion/store.ts:16-20`）：**模型不能设自己的情绪**，
 * 所以这里固定用 `{ kind: 'owner' }`，不接受 actor 参数。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EmotionStore } from '../emotion/index.ts'

const arg = (args: string[], key: string): string | undefined => {
  const i = args.indexOf(key)
  return i >= 0 ? args[i + 1] : undefined
}

const USAGE = 'usage: prts emotion <get|set> --data-root <d>'
  + ' [--valence -1..1] [--arousal 0..1] [--label <l>] [--reason <r>]'

export function emotionCommand(args: string[]): number {
  const action = args[0]
  if (action !== 'get' && action !== 'set') {
    console.error(USAGE)
    return 2
  }
  const dataRoot = arg(args, '--data-root')
  if (dataRoot === undefined) {
    console.error(USAGE)
    return 2
  }
  const dbPath = join(dataRoot, 'emotion.sqlite')
  // dataRoot 可能还不存在（首次使用）：先建目录，否则 SQLite 报
  // `unable to open database file`——那是路径问题，不是库坏了。
  mkdirSync(dataRoot, { recursive: true })

  const store = EmotionStore.open(dbPath)
  try {
    if (action === 'get') {
      const state = store.get()
      if (state === undefined) {
        console.log('（无情绪状态——尚未设定过）')
        return 0
      }
      console.log(`label=${state.label} valence=${state.valence} arousal=${state.arousal}`)
      const decayed = store.decay()
      console.log(`衰减后 valence=${decayed.valence.toFixed(3)} arousal=${decayed.arousal.toFixed(3)}`)
      const mood = store.renderMood()
      console.log(mood === '' ? '（表达基调：已平息）' : `表达基调：${mood}`)
      return 0
    }

    // set：数值范围按 EmotionState 的定义校验（valence ∈ [-1,1]，arousal ∈ [0,1]）。
    const valenceRaw = arg(args, '--valence')
    const arousalRaw = arg(args, '--arousal')
    const label = arg(args, '--label')
    const reason = arg(args, '--reason')
    const valence = Number(valenceRaw)
    const arousal = Number(arousalRaw)
    if (valenceRaw === undefined || !Number.isFinite(valence) || valence < -1 || valence > 1) {
      console.error('--valence 必须是 [-1, 1] 内的数')
      return 2
    }
    if (arousalRaw === undefined || !Number.isFinite(arousal) || arousal < 0 || arousal > 1) {
      console.error('--arousal 必须是 [0, 1] 内的数')
      return 2
    }
    if (label === undefined || label.trim() === '') {
      console.error('--label 不能为空')
      return 2
    }
    if (reason === undefined || reason.trim() === '') {
      console.error('--reason 不能为空（情绪必须带理由，否则等于挡箭牌）')
      return 2
    }
    store.update(
      { kind: 'owner' },
      { valence, arousal, label: label.trim(), reason: reason.trim() },
    )
    console.log(`已设定：${label.trim()}（valence ${valence} / arousal ${arousal}）`)
    return 0
  } finally {
    store.close()
  }
}
