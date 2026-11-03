/**
 * 人格库（架构需求 §7 V1-09 / V1-04 / V1-05 的共同底座）。
 *
 * 一句话说清它守什么：**人格只能被 owner 改，改一次留一次痕，切换人格动不了任何能力。**
 *
 * ## 为什么核心与风格分开
 *
 * 「改了语气」和「改了底线」是两件事，混成一个 `personaPrefix` 字符串之后再也分不开。
 * 分开存之后，`coreHistory` 只回核心的取值史——那正是「悄悄改掉自己的底线」的取证面。
 *
 * ## 为什么每条变更都要事务
 *
 * 「追加事件 + 应用投影」必须同生共死。分两步走的话，中间崩一次就会出现
 * 「事件在链上、投影没动」——重开库时投影与链对不上账，而链又看着完好。
 * 这里统一走 `tx()`：`BEGIN IMMEDIATE` → fn() → `COMMIT`，出错 `ROLLBACK`。
 *
 * ## 为什么没有 setTask / grantXxx 之类的方法
 *
 * V1-04 要求切换人格前后任务与权限不变。这里不是「小心不要动」而是「够不着」：
 * 人格库是独立 SQLite 文件，代码里没有任何 ledger / authority 的 import，
 * 所以「切换人格顺手放宽了权限」在机制上不可能发生。别在这里加那种通道。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { appendChained, canonicalJson, verifyChainRows, type ChainVerifyResult } from '../chain/index.ts'
import { raise } from '../ledger/errors.ts'
import { applyPersonaEvent } from './fold.ts'
import { openPersonaDb } from './schema.ts'
import type {
  PersonaActor,
  PersonaCoreChange,
  PersonaDefineInput,
  PersonaEventKind,
  PersonaEventRow,
  PersonaPreset,
  PersonaRef,
} from './types.ts'

interface PresetRow {
  preset: string
  revision: number
  core: string
  style: string
  created_at: number
  updated_at: number
}

interface HistoryRow {
  seq: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
}

/** 预设名是标识符，两端空白一律规整掉；空名是个 bug，当场拒。 */
function normalizePreset(value: unknown): string {
  if (typeof value !== 'string') raise('INVALID_INPUT', 'preset must be a string')
  const id = value.trim()
  if (id === '') raise('INVALID_INPUT', 'preset must be a non-empty string')
  return id
}

/**
 * 核心设定按**原样**存，不 trim。
 *
 * 核心是内容（可能故意带缩进、换行），逐字节保真才谈得上取证；
 * 只在判空时 trim 一下——空白核心等价于「没有底线」，那必须拒。
 */
function requireCore(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    raise('INVALID_INPUT', 'core must be a non-empty string')
  }
  return value
}

/** `define` 的 style 可省略（等价空串）——「不加风格」是合法选择，「风格不是底线」。 */
function optionalStyle(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') raise('INVALID_INPUT', 'style must be a string')
  return value
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    raise('INVALID_INPUT', `revision must be a positive integer, got ${String(value)}`)
  }
  return value
}

/** 链上行解析失败说明库被人动过——不能把 SyntaxError 漏给调用方当业务错误。 */
function parseEventJson(raw: string, seq: number, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raise('CHAIN_BROKEN', `persona event seq=${seq} has unparsable ${field}`)
  }
}

function asObject(value: unknown, seq: number, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    raise('CHAIN_BROKEN', `persona event seq=${seq} has non-object ${field}`)
  }
  return value as Record<string, unknown>
}

function toPreset(row: PresetRow): PersonaPreset {
  return { preset: row.preset, revision: row.revision, core: row.core, style: row.style }
}

export class PersonaStore {
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(dbPath: string): PersonaStore {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      raise('INVALID_INPUT', 'persona db path must be a non-empty string')
    }
    return new PersonaStore(openPersonaDb(dbPath))
  }

  close(): void {
    try {
      this.db.close()
    } catch { /* 已关闭则忽略 */ }
  }

  // ---------- 写通道（全部 owner only） ----------

  /** 定义一个预设。重复定义是 INVALID_TRANSITION——改内容走 setCore / setStyle。 */
  define(actor: PersonaActor, input: PersonaDefineInput): void {
    this.requireOwner(actor, 'define')
    const preset = normalizePreset(input?.preset)
    const core = requireCore(input?.core)
    const style = optionalStyle(input?.style)
    this.tx(() => {
      if (this.get(preset) !== undefined) {
        raise('INVALID_TRANSITION', `persona preset ${preset} is already defined; change it with setCore/setStyle`)
      }
      // 投影被删过（还没重建）时，上面那步查不到东西，但链上可能早有一条 persona.defined。
      // 此时再追加一条，`rebuildProjections` 会永久失败——重放到第二条 defined 直接抛错，
      // 而链本身「看着完好」。所以「是否定义过」必须问链，不只问投影。
      if (this.definedInChain(preset)) {
        raise('INVALID_TRANSITION', `persona preset ${preset} already has a persona.defined event but no projection row — call rebuildProjections()`)
      }
      this.append(preset, 1, 'persona.defined', actor, { core, style })
    })
  }

  /** 改核心设定（V1-09 的正门）。前后值都进链，coreHistory 可查。 */
  setCore(actor: PersonaActor, ref: PersonaRef, core: string): PersonaPreset {
    this.requireOwner(actor, 'change the core setting of')
    const preset = normalizePreset(ref?.preset)
    const next = requireCore(core)
    const revision = requireRevision(ref?.revision)
    return this.tx(() => {
      const row = this.mustPreset(preset, revision)
      this.append(preset, row.revision + 1, 'persona.core-changed', actor, { from: row.core, to: next })
      return this.requirePreset(preset)
    })
  }

  /** 改风格。与 setCore 同一条修订号纪律，但允许空串（去掉风格是合法动作）。 */
  setStyle(actor: PersonaActor, ref: PersonaRef, style: string): PersonaPreset {
    this.requireOwner(actor, 'change the style of')
    const preset = normalizePreset(ref?.preset)
    if (typeof style !== 'string') raise('INVALID_INPUT', 'style must be a string')
    const revision = requireRevision(ref?.revision)
    return this.tx(() => {
      const row = this.mustPreset(preset, revision)
      this.append(preset, row.revision + 1, 'persona.style-changed', actor, { from: row.style, to: style })
      return this.requirePreset(preset)
    })
  }

  /**
   * 切换当前人格，返回新的 activePreset。
   *
   * 切到不存在的预设是 NOT_FOUND 而不是「静默生效」：active 指向一个没有内容的预设时，
   * `renderPrefix()` 只能二选一——静默降级成「没有人格」（等于悄悄抹掉底线），
   * 或者当场报错。前者是产品事故，后者是一次可修的配置错误，所以选后者。
   */
  switchTo(actor: PersonaActor, preset: string): string {
    this.requireOwner(actor, 'switch')
    const target = normalizePreset(preset)
    return this.tx(() => {
      const row = this.get(target)
      if (row === undefined) raise('NOT_FOUND', `persona preset ${target} ${this.missingHint(target)}`)
      const from = this.activePreset() ?? null
      this.append(target, row.revision, 'persona.switched', actor, { from, to: target })
      const now = this.activePreset()
      if (now === undefined) raise('NOT_FOUND', 'active persona preset vanished right after switch')
      return now
    })
  }

  // ---------- 读通道 ----------

  /** 当前预设。进程内不缓存——别的连接改了投影，这里立刻看得见。 */
  activePreset(): string | undefined {
    const row = this.db.prepare('SELECT preset FROM persona_active WHERE id = 1').get() as { preset: string } | undefined
    return row?.preset
  }

  /** 按名字取预设。查不到就是 undefined（不抛：`get` 是查表，不是断言）。 */
  get(preset: string): PersonaPreset | undefined {
    if (typeof preset !== 'string') return undefined
    const id = preset.trim()
    if (id === '') return undefined
    const row = this.db.prepare('SELECT * FROM persona_presets WHERE preset = ?').get(id) as PresetRow | undefined
    return row === undefined ? undefined : toPreset(row)
  }

  /**
   * 渲染给 DSH 用的前缀：核心 + 换行 + 风格。
   *
   * 空库返回空串——**不编一段默认人设**。人格内容按架构需求 §10 第 7 条需博士审定，
   * 这里凭空补一句「你是 PRTS」等于绕过审定把内容塞进系统提示。
   */
  renderPrefix(): string {
    const active = this.activePreset()
    if (active === undefined) return ''
    const preset = this.get(active)
    if (preset === undefined) {
      // 投影缺行说明库被绕过 store 改过（或投影被删还没重建）。静默返回 '' 会让
      // 「底线消失」表现得像「今天没配人格」，所以这里炸。
      raise('NOT_FOUND', `active persona preset ${active} has no row; call rebuildProjections()`)
    }
    return preset.style.trim() === '' ? preset.core : `${preset.core}\n${preset.style}`
  }

  /**
   * 核心设定的取值史，按因果顺序（seq）升序，含 `define` 那一次。
   *
   * 用 seq 而不是 ts 排序：同一毫秒内连改两次时 ts 会打平，谁先谁后就丢了，
   * 而「先改成 A 再改成 B」与「先 B 后 A」是两回事。
   */
  coreHistory(preset: string): PersonaCoreChange[] {
    const id = normalizePreset(preset)
    const rows = this.db.prepare(
      `SELECT seq, kind, actor_json, payload_json, ts FROM persona_events
        WHERE preset = ? AND kind IN ('persona.defined', 'persona.core-changed')
        ORDER BY seq`,
    ).all(id) as unknown as HistoryRow[]
    // 一个人格都没有的预设名，回空数组等于说「它从没被改过」——那是谎话，报 NOT_FOUND。
    if (rows.length === 0) raise('NOT_FOUND', `no persona history for ${id}`)
    return rows.map((r) => {
      const payload = asObject(parseEventJson(r.payload_json, r.seq, 'payload_json'), r.seq, 'payload_json')
      const value = r.kind === 'persona.defined' ? payload.core : payload.to
      if (typeof value !== 'string') {
        raise('CHAIN_BROKEN', `persona event seq=${r.seq} carries no core value`)
      }
      const actor = asObject(parseEventJson(r.actor_json, r.seq, 'actor_json'), r.seq, 'actor_json')
      return { value, by: actor.kind === 'model' ? 'model' : 'owner', atMs: r.ts }
    })
  }

  // ---------- 链与重建 ----------

  verifyChain(): ChainVerifyResult {
    const rows = this.db.prepare('SELECT * FROM persona_events ORDER BY seq').all() as unknown as PersonaEventRow[]
    // `seq` 必须回填：`appendChained` 写入时算的是 `chainHash(prev, {...fields, seq})`，
    // 而 `verifyChainRows` 把这里返回的对象**原样**喂给 `chainHash`（chain 的 index.ts）。
    // 少一个字段，正常链也会被判成断链——而「断链测试」恰好断言 ok:false，
    // 于是一个漏字段的实现照样能通过断链用例，只在正常链上翻车。
    return verifyChainRows(rows, (r) => ({
      seq: r.seq,
      preset: r.preset,
      revision: r.revision,
      kind: r.kind,
      actor_json: r.actor_json,
      payload_json: r.payload_json,
      ts: r.ts,
    }))
  }

  /** 投影重建：删干净再按 seq 重放。链是事实来源，投影永远可以重来。 */
  rebuildProjections(): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM persona_presets').run()
      this.db.prepare('DELETE FROM persona_active').run()
      const rows = this.db.prepare('SELECT * FROM persona_events ORDER BY seq').all() as unknown as PersonaEventRow[]
      for (const r of rows) {
        applyPersonaEvent(this.db, {
          preset: r.preset,
          revision: r.revision,
          kind: r.kind,
          actor: parseEventJson(r.actor_json, r.seq, 'actor_json') as PersonaActor,
          payload: parseEventJson(r.payload_json, r.seq, 'payload_json'),
          ts: r.ts,
        })
      }
    })
  }

  // ---------- 内部 ----------

  /** 守卫点在库里，不在调用方：模型通道一律 FORBIDDEN（V1-09 的第三半）。 */
  private requireOwner(actor: PersonaActor, op: string): void {
    if (actor?.kind !== 'owner') raise('FORBIDDEN', `only owner may ${op} a persona preset`)
  }

  /** 链上有没有这个预设的 `persona.defined`——投影与链对不上账时，这是唯一可信的答案。 */
  private definedInChain(preset: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 AS hit FROM persona_events WHERE preset = ? AND kind = 'persona.defined' LIMIT 1",
    ).get(preset)
    return row !== undefined
  }

  /**
   * NOT_FOUND 的措辞要指向正确的修法。
   *
   * 「投影缺行」与「这个预设从来没定义过」是两种完全不同的故障：前者一条
   * `rebuildProjections()` 就好，后者得先 define。都说成 `not found`，排查会跑偏到
   * 「是不是名字写错了」，而真正的原因在投影上。
   */
  private missingHint(preset: string): string {
    return this.definedInChain(preset)
      ? 'has no projection row but exists in the event chain — call rebuildProjections()'
      : 'not found'
  }

  private mustPreset(preset: string, revision: number): PersonaPreset {
    const row = this.get(preset)
    if (row === undefined) raise('NOT_FOUND', `persona preset ${preset} ${this.missingHint(preset)}`)
    if (row.revision !== revision) {
      raise('STALE_REVISION', `persona preset ${preset} is at revision ${row.revision}, got ${revision}`)
    }
    return row
  }

  private requirePreset(preset: string): PersonaPreset {
    const row = this.get(preset)
    if (row === undefined) raise('NOT_FOUND', `persona preset ${preset} vanished after write`)
    return row
  }

  private append(
    preset: string,
    revision: number,
    kind: PersonaEventKind,
    actor: PersonaActor,
    payload: unknown,
  ): void {
    // 一个 ts 同时给链和投影：同一个事实不该有两个时间戳。`applyPersonaEvent` 必须
    // 在追加之后立即执行，中途抛出会连同链上事件一起回滚（记忆模块踩过的坑）。
    const ts = Date.now()
    appendChained(this.db, 'persona_events', {
      preset,
      revision,
      kind,
      actor_json: canonicalJson(actor),
      payload_json: canonicalJson(payload),
      ts,
    }, (f) => f as Record<string, SQLInputValue>)
    applyPersonaEvent(this.db, { preset, revision, kind, actor, payload, ts })
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 事务已被 SQLite 回滚 */ }
      throw error
    }
  }
}
