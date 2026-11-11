/**
 * 情绪库（架构需求 §7 V1-05）。
 *
 * 一句话说清它守什么：**情绪能被博士或系统设定、随时间自行平息、并且永远够不着事实。**
 *
 * ## 为什么衰减是读时计算
 *
 * 「一次不愉快锁死一整天」是错的，「半小时后一点痕迹都没有」也是错的。
 * 指数衰减（半衰期 3 小时，可注入）把强度按 `0.5^(elapsed/halfLife)` 拉回 0，
 * 而 `updatedAt` 与 `label` 不动。**衰减绝不写链**：一旦把衰减后的值写回去，
 * 同一个库在「读了几次」之后会给出不同历史，而链上一个字节都没变——无声漂移，
 * 而且它会在某天变成「上周明明很开心，现在翻出来是平淡」。读时计算保证：
 * 链只记「发生了什么」，当前心情是链与时钟的纯函数。
 *
 * ## 为什么模型不能 update
 *
 * 情绪一旦能被模型自己设定，它就有了一个不需要理由的挡箭牌（「今天心情不好」）。
 * 守卫点在库里而不是调用方：`requireWriter` 只认 `owner` 与带 component 的 `system`，
 * 且在**任何写入之前**抛——被拒的调用连一条 UPDATE 都不会跑。
 *
 * ## 为什么没有 search / task / grant 之类的方法
 *
 * V1-05 要求情感变化不改变任何事实性回答。这里不是「小心不要动」而是「够不着」：
 * 情绪库是独立 SQLite 文件，代码里没有任何 ledger / memory / skills 的 import，
 * 所以「心情不好所以少返两条记忆」在机制上不可能发生。别在这里加那种通道。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { appendChained, canonicalJson, verifyChainRows, type ChainVerifyResult } from '../chain/index.ts'
import { raise } from '../ledger/errors.ts'
import { applyEmotionEvent } from './fold.ts'
import { openEmotionDb } from './schema.ts'
import type {
  EmotionActor,
  EmotionEventKind,
  EmotionEventRow,
  EmotionState,
  EmotionUpdateInput,
} from './types.ts'

/**
 * 3 小时半衰期：一次不愉快不该锁死一整天，也不该在半小时里消失得无影无踪。
 * 可经 `EmotionStore.open(path, { halfLifeMs })` 注入——测试要能钉住零点与半衰点。
 */
export const DEFAULT_HALF_LIFE_MS = 3 * 3_600_000

export interface EmotionStoreOptions {
  halfLifeMs?: number
}

/** 渲染出的标签最多留 40 字符，保证整句稳定落在「一句话」的长度里。 */
const MOOD_LABEL_MAX = 40

interface StateRow {
  revision: number
  valence: number
  arousal: number
  label: string
  updated_at: number
}

/**
 * 取一个有限数并校验区间。
 *
 * 非有限数与越界同样致命：`canonicalJson` 会把 NaN 写成 `null` 落进链，
 * 于是链上留下一条「没有 valence」的事件，投影里却是 NaN——之后每次比较都是
 * false，安静得像什么都没坏。字符串形式的数字（`'0.5'`）同样拒：它不是数值，
 * 只是长得像。
 */
function requireRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    raise('INVALID_INPUT', `${field} must be a finite number, got ${String(value)}`)
  }
  if (value < min || value > max) {
    raise('INVALID_INPUT', `${field} out of range [${min}, ${max}]: ${value}`)
  }
  return value
}

/** 文本字段判空用 trim，存原样（标签可能是故意的表情符号或标点，保真优先于整洁）。 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    raise('INVALID_INPUT', `${field} must be a non-empty string`)
  }
  return value
}

/** 时间戳：非负有限数。负数等于「事件发生在纪元前」，那是坏输入而不是宽容点。 */
function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    raise('INVALID_INPUT', `${field} must be a non-negative finite number, got ${String(value)}`)
  }
  return value
}

/** 半衰期必须是正的有限数：0 会让 `0.5^(elapsed/0)` 变 Infinity → 0，瞬时清零。 */
function requireHalfLife(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    raise('INVALID_INPUT', `halfLifeMs must be a positive finite number, got ${String(value)}`)
  }
  return value
}

function toState(row: StateRow): EmotionState {
  return {
    valence: row.valence,
    arousal: row.arousal,
    label: row.label,
    updatedAt: row.updated_at,
    revision: row.revision,
  }
}

/**
 * 读时衰减：把 valence / arousal 按 `0.5^(elapsed/halfLife)` 拉回 0。
 *
 * `updatedAt`、`label`、`revision` 原样带走——衰减能改的只有强度。
 * 时钟回拨（`elapsed < 0`）不衰减也不放大：用 `!(elapsed > 0)` 而不是
 * `elapsed <= 0`，让 NaN 也落在「不衰减」这一侧，而不是把 NaN 传播给调用方。
 */
function decayed(state: EmotionState, nowMs: number, halfLifeMs: number): EmotionState {
  const elapsed = nowMs - state.updatedAt
  if (!(elapsed > 0)) return { ...state }
  const factor = Math.pow(0.5, elapsed / halfLifeMs)
  return { ...state, valence: state.valence * factor, arousal: state.arousal * factor }
}

/** 标签里的换行/连续空白折叠成单空格：一句中文不能因为标签带换行变成两行。 */
function flattenLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

/**
 * 一句中文，只描述情绪本身。
 *
 * 长度上限是硬要求（< 120）：模板固定，标签再长也被截到 `MOOD_LABEL_MAX`。
 * 这里不出现任务、记忆、检索、权限之类的事实名词——情绪只能进表达层，
 * 而表达层里最容易被顺手写进去的，正是「因为刚才那件事失败了」。
 */
function moodSentence(state: EmotionState): string {
  const label = (flattenLabel(state.label) || '未标注').slice(0, MOOD_LABEL_MAX)
  const tone = state.valence > 0.15 ? '偏明亮' : state.valence < -0.15 ? '偏低沉' : '平稳'
  return `此刻情绪是「${label}」，基调${tone}：愉悦度 ${state.valence.toFixed(2)}，唤醒度 ${state.arousal.toFixed(2)}。`
}

/** 链上行解析失败说明库被人动过——不能把 SyntaxError 漏给调用方当业务错误。 */
function parseEventJson(raw: string, seq: number, field: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raise('CHAIN_BROKEN', `emotion event seq=${seq} has unparsable ${field}`)
  }
}

export class EmotionStore {
  private readonly db: DatabaseSync
  private readonly halfLifeMs: number

  private constructor(db: DatabaseSync, halfLifeMs: number) {
    this.db = db
    this.halfLifeMs = halfLifeMs
  }

  static open(dbPath: string, options?: EmotionStoreOptions): EmotionStore {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      raise('INVALID_INPUT', 'emotion db path must be a non-empty string')
    }
    // 配置校验必须发生在 `openEmotionDb` **之前**：先建连接再校验的话，
    // `halfLifeMs: 0` 这类写错的配置会抛在连接已经建好之后，而那个连接再没人负责关。
    // 症状不是报错，是「配置改对了之后这个 sqlite 文件仍然删不掉/开不了」——
    // Windows 上一个泄漏的句柄会一直占着文件，而调用方只看到一句 INVALID_INPUT。
    const halfLife = options?.halfLifeMs
    const halfLifeMs = halfLife === undefined ? DEFAULT_HALF_LIFE_MS : requireHalfLife(halfLife)
    return new EmotionStore(openEmotionDb(dbPath), halfLifeMs)
  }

  close(): void {
    try {
      this.db.close()
    } catch { /* 已关闭则忽略 */ }
  }

  // ---------- 写通道（owner / system） ----------

  /**
   * 覆盖当前情绪，返回写入后的状态（**未衰减**的原值）。
   *
   * 校验顺序固定为「actor → 输入 → 事务」：被拒的调用停在这一层，
   * 连 `BEGIN IMMEDIATE` 都不开，所以失败路径不会留下任何痕迹。
   */
  update(actor: EmotionActor, input: EmotionUpdateInput): EmotionState {
    this.requireWriter(actor, 'set')
    const given = input as Partial<EmotionUpdateInput> | null | undefined
    const valence = requireRange(given?.valence, 'valence', -1, 1)
    const arousal = requireRange(given?.arousal, 'arousal', 0, 1)
    const label = requireText(given?.label, 'label')
    const reason = requireText(given?.reason, 'reason')
    const atMs = given?.atMs === undefined ? Date.now() : requireTimestamp(given.atMs, 'atMs')
    const refId = given?.refId === undefined ? undefined : requireText(given.refId, 'refId')
    return this.tx(() => {
      const current = this.get()
      if (current === undefined && this.eventCount() > 0) {
        // 投影缺行但链非空：此刻若按 revision 1 追加，`rebuildProjections` 会在
        // 重放到第二条 revision 1 时抛错——而链本身「看着完好」，症状会变成
        // 「某天重建突然失败」。当场指路才是对的。
        raise('INVALID_TRANSITION',
          'emotion projection is missing while the event chain is not empty — call rebuildProjections()')
      }
      const revision = current === undefined ? 1 : current.revision + 1
      this.append(revision, 'emotion.updated', actor, {
        valence, arousal, label, reason,
        ...(refId === undefined ? {} : { refId }),
      }, atMs)
      const next = this.get()
      if (next === undefined) raise('NOT_FOUND', 'emotion state vanished right after write')
      return next
    })
  }

  // ---------- 读通道 ----------

  /** 当前投影。进程内不缓存——别的连接改了投影，这里立刻看得见。 */
  get(): EmotionState | undefined {
    const row = this.db.prepare(
      'SELECT revision, valence, arousal, label, updated_at FROM emotion_state WHERE id = 1',
    ).get() as StateRow | undefined
    return row === undefined ? undefined : toState(row)
  }

  /**
   * 衰减到 `nowMs` 时刻的状态。**纯读**：不写链、不写投影。
   *
   * 没有任何状态时抛 NOT_FOUND 而不是编一个「中性」：`EmotionState` 不是可选返回，
   * 编出来的数值会被 `renderMood` 说成博士的心情，而他从没表达过。
   * 需要「没有就空着」的调用方请用 `renderMood`（它在空库返回空串）。
   */
  decay(nowMs?: number): EmotionState {
    const current = this.get()
    if (current === undefined) raise('NOT_FOUND', 'no emotion state yet; call update() first')
    const now = nowMs === undefined ? Date.now() : requireTimestamp(nowMs, 'nowMs')
    return decayed(current, now, this.halfLifeMs)
  }

  /** 渲染一句情绪描述。空库返回空串——**不编一段默认心情**。 */
  renderMood(nowMs?: number): string {
    const current = this.get()
    if (current === undefined) return ''
    const now = nowMs === undefined ? Date.now() : requireTimestamp(nowMs, 'nowMs')
    return moodSentence(decayed(current, now, this.halfLifeMs))
  }

  /**
   * 链上某个 system component 最近一次写入的时刻（§G2 ④ 去重用）。
   * 事实来源是链不是投影：重建、重启后判定不变。json_extract 查链有先例
   * （memory/store.ts 的 deletion 清单）。
   * 传 refId 时收窄到「该 component 且 payload.refId 等于它」的最新一条
   * （M→E 的 per-fact / per-task 去重，DESIGN-07 D5/D8）。
   */
  lastEventAtMs(component: string, refId?: string): number | undefined {
    const row = (refId === undefined
      ? this.db.prepare(
        `SELECT ts FROM emotion_events
          WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = ?
          ORDER BY seq DESC LIMIT 1`,
      ).get(component)
      : this.db.prepare(
        `SELECT ts FROM emotion_events
          WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = ?
            AND json_extract(payload_json, '$.refId') = ?
          ORDER BY seq DESC LIMIT 1`,
      ).get(component, refId)) as { ts: number } | undefined
    return row?.ts
  }

  // ---------- 链与重建 ----------

  verifyChain(): ChainVerifyResult {
    const rows = this.db.prepare('SELECT * FROM emotion_events ORDER BY seq').all() as unknown as EmotionEventRow[]
    // `seq` 必须回填：`appendChained` 写入时算的是 `chainHash(prev, {...fields, seq})`，
    // 而 `verifyChainRows` 把这里返回的对象**原样**喂给 `chainHash`（chain/index.ts）。
    // 少一个字段，正常链也会被判成断链——而「断链测试」恰好断言 ok:false，
    // 于是一个漏字段的实现照样能通过断链用例，只在正常链上翻车。
    return verifyChainRows(rows, (r) => ({
      seq: r.seq,
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
      this.db.prepare('DELETE FROM emotion_state').run()
      const rows = this.db.prepare('SELECT * FROM emotion_events ORDER BY seq').all() as unknown as EmotionEventRow[]
      for (const r of rows) {
        applyEmotionEvent(this.db, {
          revision: r.revision,
          kind: r.kind,
          actor: parseEventJson(r.actor_json, r.seq, 'actor_json') as EmotionActor,
          payload: parseEventJson(r.payload_json, r.seq, 'payload_json'),
          ts: r.ts,
        })
      }
    })
  }

  // ---------- 内部 ----------

  /**
   * 守卫点在库里，不在调用方：模型通道一律 FORBIDDEN。
   *
   * `system` 必须报出 component——一条匿名情绪无从追溯是谁判定的，
   * 而情绪是「谁在什么时候因为什么改了什么」的取证面。
   */
  private requireWriter(actor: EmotionActor, op: string): void {
    const kind = actor?.kind
    if (kind === 'owner') return
    if (kind === 'system') {
      const component: unknown = (actor as { component?: unknown }).component
      if (typeof component === 'string' && component.trim() !== '') return
      raise('FORBIDDEN', `system actor must name its component to ${op} the emotion state`)
    }
    raise('FORBIDDEN', `only owner or system may ${op} the emotion state`)
  }

  private eventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM emotion_events').get() as { n: number }
    return row.n
  }

  private append(
    revision: number,
    kind: EmotionEventKind,
    actor: EmotionActor,
    payload: unknown,
    ts: number,
  ): void {
    // 一个 ts 同时给链和投影：同一个事实不该有两个时间戳。`applyEmotionEvent` 必须
    // 在追加之后立即执行，中途抛出会连同链上事件一起回滚（记忆模块踩过的坑）。
    appendChained(this.db, 'emotion_events', {
      revision,
      kind,
      actor_json: canonicalJson(actor),
      payload_json: canonicalJson(payload),
      ts,
    }, (f) => f as Record<string, SQLInputValue>)
    applyEmotionEvent(this.db, { revision, kind, actor, payload, ts })
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
