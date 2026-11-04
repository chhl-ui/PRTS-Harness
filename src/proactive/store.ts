/**
 * V1-07 主动回忆：留痕库（独立 SQLite，单表、只追加）。
 *
 * ## 为什么是独立库而不是 `src/memory` 的第 N 张表
 *
 * 主动回忆是**行为日志**，不是事实来源。它不需要哈希链（没有「篡改即失效」的
 * 语义要求），也不该被 `fold.ts` 的投影规则约束——塞进记忆库只会让两张不相干的
 * 生命周期表互相牵连。独立库还带来一个实际好处：`record()` 的写失败不会污染
 * 记忆库的事务边界，注入层可以「留痕失败但照常注入」。
 *
 * ## 为什么只追加
 *
 * 「同一条记忆被提起两次」不是重复行，是**两次独立的评价样本**。V1-07 要求的
 * 70% 恰当率就是对这批样本抽样；去重写真会把「提了两次都不合适」压成一条。
 *
 * ## 为什么冷却按 `mentioned_at_ms` 的最大值算
 *
 * 跨会话冷却（PR6）的语义是「这条旧事最近一次被说起是什么时候」，与在哪个会话
 * 说的无关。取最新一次即最长冷却，宁可少提也不要连提同一条。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  ProactiveListQuery, ProactiveMention, ProactiveRecordInput, ProactiveStore,
} from './types.ts'

/** 冷却窗口默认 7 天（V1-07「7 天试用」的时间口径）。 */
export const DEFAULT_COOLDOWN_MS = 7 * 86_400_000

/**
 * 单表结构。
 *
 * `id` 用 AUTOINCREMENT：普通 INTEGER PRIMARY KEY 会复用被删的最大 rowid，
 * 而这张表**不该有删除**——真出现删除（人工清理），复用 id 会让「第几次提起」
 * 的先后序失去意义。代价只是多一张 sqlite_sequence。
 *
 * 两个索引对应两条热路径：`countBySession` / `list({sessionId})` 走 session 索引，
 * `isCoolingDown` 走 memory 索引。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS proactive_mentions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT    NOT NULL,
  turn            INTEGER NOT NULL,
  memory_id       TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  score           REAL    NOT NULL,
  mentioned_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_session ON proactive_mentions(session_id, id);
CREATE INDEX IF NOT EXISTS idx_proactive_memory ON proactive_mentions(memory_id, mentioned_at_ms);
`

const SELECT_COLUMNS = 'id, session_id, turn, memory_id, kind, score, mentioned_at_ms'

/** SQLite 的 INTEGER 在超出安全整数时会以 bigint 返回，统一收敛到 number。 */
interface MentionRow {
  id: number | bigint
  session_id: string
  turn: number | bigint
  memory_id: string
  kind: string
  score: number
  mentioned_at_ms: number | bigint
}

function toMention(row: MentionRow): ProactiveMention {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    turn: Number(row.turn),
    memoryId: row.memory_id,
    kind: row.kind,
    score: Number(row.score),
    mentionedAtMs: Number(row.mentioned_at_ms),
  }
}

/**
 * 必填文本字段。空串直接拒——`sessionId` 为空会让「会话隔离」退化成
 * 「所有会话共用一个桶」，而这种退化不会报错，只会让上限与去重静默失效。
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`proactive: ${field} 必须是非空字符串，实得 ${String(value)}`)
  }
  return value
}

/**
 * 必填数值字段。非有限数（NaN / Infinity / null / 字符串）拒收，而不是静默落 0：
 * 留痕是评价样本，`turn = NaN` 会被当成第 0 轮参与间隔计算，等于伪造证据。
 */
function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`proactive: ${field} 必须是有限数，实得 ${String(value)}`)
  }
  return value
}

/** `limit` 归一化：非有限数 / 负数 → 不设限；0 保留（= 空数组）。 */
function normalizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

export function openProactiveStore(path: string): ProactiveStore {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(`proactive: 库路径必须是非空字符串，实得 ${String(path)}`)
  }
  // `:memory:` 与普通文件一视同仁——WAL 对内存库是空操作，不额外分支。
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  let closed = false

  const record = (input: ProactiveRecordInput): number => {
    const sessionId = requireText(input.sessionId, 'sessionId')
    const memoryId = requireText(input.memoryId, 'memoryId')
    const kind = requireText(input.kind, 'kind')
    const turn = requireFinite(input.turn, 'turn')
    const score = requireFinite(input.score, 'score')
    const mentionedAtMs = requireFinite(input.mentionedAtMs, 'mentionedAtMs')
    const info = db.prepare(
      `INSERT INTO proactive_mentions (session_id, turn, memory_id, kind, score, mentioned_at_ms)
       VALUES (?,?,?,?,?,?)`,
    ).run(sessionId, turn, memoryId, kind, score, mentionedAtMs)
    return Number(info.lastInsertRowid)
  }

  const list = (query: ProactiveListQuery = {}): ProactiveMention[] => {
    const sessionId = typeof query.sessionId === 'string' && query.sessionId !== ''
      ? query.sessionId
      : undefined
    const limit = normalizeLimit(query.limit)
    if (limit === 0) return []
    const where = sessionId === undefined ? '' : ' WHERE session_id = ?'
    const args: Array<string | number> = sessionId === undefined ? [] : [sessionId]
    if (limit === undefined) {
      const rows = db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM proactive_mentions${where} ORDER BY id ASC`,
      ).all(...args) as unknown as MentionRow[]
      return rows.map(toMention)
    }
    // 给了上限就取「最近 N 条」，再翻转回升序——调用方关心的是最近的轨迹，
    // 但返回顺序与无上限时一致（按写入先后），两种调用不必分两套读法。
    const rows = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM proactive_mentions${where} ORDER BY id DESC LIMIT ?`,
    ).all(...args, limit) as unknown as MentionRow[]
    return rows.map(toMention).reverse()
  }

  const countBySession = (sessionId: string): number => {
    // 空会话名不是一个会话，而「没提起过」是它唯一可能的答案——不抛错。
    if (typeof sessionId !== 'string' || sessionId === '') return 0
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM proactive_mentions WHERE session_id = ?',
    ).get(sessionId) as unknown as { n: number | bigint } | undefined
    return row === undefined ? 0 : Number(row.n)
  }

  const isCoolingDown = (
    memoryId: string,
    nowMs: number = Date.now(),
    windowMs: number = DEFAULT_COOLDOWN_MS,
  ): boolean => {
    if (typeof memoryId !== 'string' || memoryId === '') return false
    // 0 是合法窗口（= 不冷却）；负数 / 非有限数是参数错误，回落默认而不是变成「永不冷却」。
    const window = typeof windowMs === 'number' && Number.isFinite(windowMs) && windowMs >= 0
      ? windowMs
      : DEFAULT_COOLDOWN_MS
    const at = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
    const row = db.prepare(
      `SELECT mentioned_at_ms AS at FROM proactive_mentions
        WHERE memory_id = ? ORDER BY mentioned_at_ms DESC LIMIT 1`,
    ).get(memoryId) as unknown as { at: number | bigint } | undefined
    if (row === undefined) return false
    const elapsed = at - Number(row.at)
    // 未来时刻的留痕（时钟回拨、多机写同一个库）按冷却处理：宁可这一轮不提，
    // 也不要因为「时间差是负数」就同一条旧事连提三次。
    if (!Number.isFinite(elapsed)) return true
    return elapsed < window
  }

  const close = (): void => {
    if (closed) return
    closed = true
    db.close()
  }

  return { record, list, countBySession, isCoolingDown, close }
}
