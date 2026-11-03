/**
 * 情绪库的投影器：**唯一**允许写 `emotion_state` 的入口。
 *
 * 纪律与 `ledger/fold.ts`、`memory/fold.ts`、`skills/fold.ts`、`persona/fold.ts` 相同：
 * 投影只能由事件重放得到，任何绕过这里的写入都会在 `rebuildProjections` 之后消失。
 *
 * `default` 分支必须抛错——`memory/fold.ts` 踩过这个坑：新增事件种类忘了接，
 * 事件在同一事务里抛错回滚，外层 catch 连带吞掉正常结果，症状是
 * 「写成功了但没生效」而不是报错。宁可当场炸，也不要静默漏一条。
 *
 * 这里额外校验载荷的**值与范围**（不只是类型）：链是事实来源，一条
 * `valence: 42` 的事件说明有人绕过 store 直接写库。重放时应当炸掉，
 * 而不是把越界的数投影成「当前心情」，再让 `renderMood` 把它说出口。
 * 范围常量与 `store.ts` 的输入校验保持一致（同一份业务规则，两个入口都守）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { raise } from '../ledger/errors.ts'
import type { EmotionActor, EmotionEventKind } from './types.ts'

export interface EmotionEventInput {
  revision: number
  kind: EmotionEventKind | string
  actor: EmotionActor
  payload: unknown
  ts: number
}

interface StateRow {
  revision: number
}

/** 载荷必须是对象；数组/字符串/null 都算坏事件。 */
function fields(payload: unknown, kind: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    raise('INVALID_INPUT', `${kind} payload must be an object`)
  }
  return payload as Record<string, unknown>
}

/**
 * 取一个有限数并校验区间。
 *
 * 非有限数（NaN / ±Infinity）与越界同样致命：`canonicalJson` 会把 NaN 序列化成
 * `null` 写进链，于是链上留下一条「没有 valence」的事件，而投影里是 NaN——
 * 之后每次比较（`===`、`<`）都是 false，安静得像什么都没坏。
 */
function finiteNumber(
  payload: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  kind: string,
): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    raise('INVALID_INPUT', `${kind} payload.${key} must be a finite number, got ${String(value)}`)
  }
  if (value < min || value > max) {
    raise('INVALID_INPUT', `${kind} payload.${key} out of range [${min}, ${max}]: ${value}`)
  }
  return value
}

function textField(payload: Record<string, unknown>, key: string, kind: string): string {
  const value = payload[key]
  if (typeof value !== 'string') {
    raise('INVALID_INPUT', `${kind} payload.${key} must be a string`)
  }
  return value
}

export function applyEmotionEvent(db: DatabaseSync, e: EmotionEventInput): void {
  switch (e.kind) {
    case 'emotion.updated': {
      const payload = fields(e.payload, e.kind)
      const valence = finiteNumber(payload, 'valence', -1, 1, e.kind)
      const arousal = finiteNumber(payload, 'arousal', 0, 1, e.kind)
      const label = textField(payload, 'label', e.kind)
      const row = db.prepare('SELECT revision FROM emotion_state WHERE id = 1').get() as StateRow | undefined
      if (row === undefined) {
        // 空投影上的第一条事件必须是 revision 1。投影被删过（还没重建）时，
        // 一条 revision>1 的事件会在这里炸掉，而不是把「第 7 次修改」投影成
        // 「第 1 次」——后者会让重放出的状态与链上的历史彻底对不上账，且不报错。
        if (e.revision !== 1) {
          raise('INVALID_TRANSITION',
            `${e.kind} on an empty projection must be revision 1, got ${e.revision} — call rebuildProjections()`)
        }
        db.prepare(
          `INSERT INTO emotion_state (id, revision, valence, arousal, label, updated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
        ).run(e.revision, valence, arousal, label, e.ts)
        break
      }
      // 修订号必须严格递增：投影的 revision 是「重放顺序对不对」的唯一依据，
      // 允许倒退或跳跃等于允许一条事件把两次修改压成一次。
      if (e.revision !== row.revision + 1) {
        raise('INVALID_TRANSITION', `${e.kind} jumps revision ${row.revision} → ${e.revision}`)
      }
      db.prepare(
        'UPDATE emotion_state SET revision = ?, valence = ?, arousal = ?, label = ?, updated_at = ? WHERE id = 1',
      ).run(e.revision, valence, arousal, label, e.ts)
      break
    }

    default:
      raise('INVALID_INPUT', `unknown emotion event kind: ${String(e.kind)}`)
  }
}
