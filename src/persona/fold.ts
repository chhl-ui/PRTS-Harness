/**
 * 人格库的投影器：**唯一**允许写 `persona_presets` / `persona_active` 的入口。
 *
 * 纪律与 `ledger/fold.ts`、`memory/fold.ts`、`skills/fold.ts` 相同：投影只能由事件
 * 重放得到，任何绕过这里的写入都会在 `rebuildProjections` 之后消失。
 *
 * `default` 分支必须抛错——`memory/fold.ts` 踩过这个坑：新增事件种类忘了接，
 * 事件在同一事务里抛错回滚，外层 catch 连带吞掉正常结果，症状是
 * 「写成功了但没生效」而不是报错。宁可当场炸，也不要静默漏一条。
 *
 * 这里额外做一件别处没做的事：**校验载荷的内部一致性**（`from` 必须等于投影里的旧值）。
 * 人格是取证面，一条自相矛盾的事件（「从 A 改成了 B」但当前其实是 C）说明有人
 * 绕过 store 直接写库，重放时应当炸掉而不是把谎话投影成事实。
 */
import type { DatabaseSync } from 'node:sqlite'
import { raise } from '../ledger/errors.ts'
import type { PersonaActor, PersonaEventKind } from './types.ts'

export interface PersonaEventInput {
  preset: string
  revision: number
  kind: PersonaEventKind | string
  actor: PersonaActor
  payload: unknown
  ts: number
}

interface CurrentRow {
  preset: string
  revision: number
  core: string
  style: string
}

function current(db: DatabaseSync, preset: string): CurrentRow {
  const row = db.prepare('SELECT preset, revision, core, style FROM persona_presets WHERE preset = ?')
    .get(preset) as CurrentRow | undefined
  if (row === undefined) raise('NOT_FOUND', `persona preset ${preset} not found`)
  return row
}

/** 从载荷里取一个字符串字段；缺失或类型不对都算坏事件。 */
function textField(payload: unknown, key: string, kind: string): string {
  if (typeof payload !== 'object' || payload === null) {
    raise('INVALID_INPUT', `${kind} payload must be an object`)
  }
  const value = (payload as Record<string, unknown>)[key]
  if (typeof value !== 'string') {
    raise('INVALID_INPUT', `${kind} payload.${key} must be a string`)
  }
  return value
}

/** `from` 必须与投影当前值一致，否则事件链与投影已经对不上账。 */
function checkFrom(payload: unknown, key: string, actual: string, kind: string, preset: string): void {
  const from = textField(payload, key, kind)
  if (from !== actual) {
    raise('INVALID_TRANSITION', `${kind} for ${preset} claims ${key} was ${JSON.stringify(from)}, projection holds ${JSON.stringify(actual)}`)
  }
}

export function applyPersonaEvent(db: DatabaseSync, e: PersonaEventInput): void {
  switch (e.kind) {
    case 'persona.defined': {
      const core = textField(e.payload, 'core', e.kind)
      const style = textField(e.payload, 'style', e.kind)
      // 首次定义必须是 revision 1。链上一条 revision 倒退的 defined 会让投影的
      // 修订号回退，进而让 store 的 STALE_REVISION 乐观并发保护失效——而保护失效
      // 是静默的，只在下次并发写时表现为「本该冲突却通过了」。
      if (e.revision !== 1) {
        raise('INVALID_TRANSITION', `${e.kind} for ${e.preset} must be revision 1, got ${e.revision}`)
      }
      const existing = db.prepare('SELECT preset FROM persona_presets WHERE preset = ?').get(e.preset)
      // 重复定义会把 revision 与 coreHistory 的语义打平（「定义」变成「改名」），
      // 改内容走 core-changed / style-changed。
      if (existing !== undefined) {
        raise('INVALID_TRANSITION', `persona preset ${e.preset} is already defined`)
      }
      db.prepare(
        `INSERT INTO persona_presets (preset, revision, core, style, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(e.preset, e.revision, core, style, e.ts, e.ts)
      break
    }

    case 'persona.core-changed': {
      const next = textField(e.payload, 'to', e.kind)
      const row = current(db, e.preset)
      // 修订号必须严格递增：投影的 revision 是 STALE_REVISION 保护的全部依据，
      // 允许倒退或跳跃等于允许一条事件把并发保护打穿。
      if (e.revision !== row.revision + 1) {
        raise('INVALID_TRANSITION', `${e.kind} for ${e.preset} jumps revision ${row.revision} → ${e.revision}`)
      }
      checkFrom(e.payload, 'from', row.core, e.kind, e.preset)
      db.prepare('UPDATE persona_presets SET revision = ?, core = ?, updated_at = ? WHERE preset = ?')
        .run(e.revision, next, e.ts, e.preset)
      break
    }

    case 'persona.style-changed': {
      const next = textField(e.payload, 'to', e.kind)
      const row = current(db, e.preset)
      if (e.revision !== row.revision + 1) {
        raise('INVALID_TRANSITION', `${e.kind} for ${e.preset} jumps revision ${row.revision} → ${e.revision}`)
      }
      checkFrom(e.payload, 'from', row.style, e.kind, e.preset)
      db.prepare('UPDATE persona_presets SET revision = ?, style = ?, updated_at = ? WHERE preset = ?')
        .run(e.revision, next, e.ts, e.preset)
      break
    }

    case 'persona.switched': {
      const target = textField(e.payload, 'to', e.kind)
      if (target !== e.preset) {
        raise('INVALID_INPUT', `persona.switched for ${e.preset} carries to=${JSON.stringify(target)}`)
      }
      // 切到不存在的预设必须拒绝：active 指向幽灵预设时，renderPrefix 只能二选一——
      // 静默降级成「没有人格」（底线消失）或当场报错。这里选后者。
      current(db, e.preset)
      // `from` 必须等于切换前的 active——与 core-changed / style-changed 同一条纪律。
      // 漏了这条，手工追加一条 from 撒谎的 switched 会让取证面记下从未发生的历史，
      // 而 rebuildProjections 照样接受：谎话落进「人格改过什么」的记录里，不报错。
      const activeRow = db.prepare('SELECT preset FROM persona_active WHERE id = 1')
        .get() as { preset: string } | undefined
      const expected = activeRow?.preset ?? null
      const claimed = (e.payload as { from?: unknown }).from ?? null
      if (claimed !== expected) {
        raise('INVALID_TRANSITION', `${e.kind} for ${e.preset} claims from=${JSON.stringify(claimed)}, active is ${JSON.stringify(expected)}`)
      }
      db.prepare(
        `INSERT INTO persona_active (id, preset, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET preset = excluded.preset, updated_at = excluded.updated_at`,
      ).run(e.preset, e.ts)
      break
    }

    default:
      raise('INVALID_INPUT', `unknown persona event kind: ${String(e.kind)}`)
  }
}
