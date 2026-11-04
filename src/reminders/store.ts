/**
 * W3 任务提醒：留痕库实现（独立 SQLite，单表、只追加）。
 *
 * 语义与取舍见 `./types.ts` 头部；这里只交代实现层面的三件事。
 *
 * 1. **单表无索引之外的结构**。热路径只有查询 `wasNotified`（每个停滞候选调一次），
 *    所以给 `(task_id, kind)` 建索引——不加它，任务一多就是每次全表扫。
 * 2. **`wasNotified` 用 `EXISTS`**，不用 `COUNT(*)`：语义是「有没有过」，
 *    `EXISTS` 命中第一条就停，且不会因为历史行累积变慢。
 * 3. **写入失败只抛不改**。`record` 抛错由调用方（注入层）决定是吞还是传——
 *    留痕库不该替它选择「提醒发不出去」还是「重复提醒」。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  ReminderListQuery, ReminderRecordInput, ReminderRow, ReminderStore,
} from './types.ts'

/**
 * 单表结构。
 *
 * `id` 用 AUTOINCREMENT：普通 `INTEGER PRIMARY KEY` 会复用被删的最大 rowid，
 * 而这张表**不该有删除**——真出现人工清理，复用 id 会让「第几次提醒」的
 * 先后序失去意义（同 `src/proactive/store.ts` 的判断）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reminders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  notified_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_task ON reminders(task_id, kind);
`

const SELECT_COLUMNS = 'id, task_id, kind, notified_at_ms'

/** SQLite 的 INTEGER 在超出安全整数时会以 bigint 返回，统一收敛到 number。 */
interface ReminderDbRow {
  id: number | bigint
  task_id: string
  kind: string
  notified_at_ms: number | bigint
}

function toRow(row: ReminderDbRow): ReminderRow {
  return {
    id: Number(row.id),
    taskId: row.task_id,
    kind: row.kind,
    notifiedAtMs: Number(row.notified_at_ms),
  }
}

/**
 * 必填文本字段。空串直接拒——`taskId` 为空会让「按任务隔离」退化成
 * 「所有空 id 共用一个桶」，而这种退化不会报错，只会让去重静默失效。
 */
function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`reminders: ${field} 必须是非空字符串，实得 ${String(value)}`)
  }
  return value
}

/**
 * 必填数值字段。非有限数（NaN / Infinity / null / 字符串）拒收，而不是静默落 0：
 * 留痕是「什么时候提醒的」证据，落 0 等于把一次真实提醒记成 1970 年。
 */
function requireFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`reminders: ${field} 必须是有限数，实得 ${String(value)}`)
  }
  return value
}

/** `limit` 归一化：非有限数 / 负数 → 不设限；0 保留（= 空数组）。 */
function normalizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

export function openReminderStore(path: string): ReminderStore {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(`reminders: 库路径必须是非空字符串，实得 ${String(path)}`)
  }
  // `:memory:` 与普通文件一视同仁——WAL 对内存库是空操作，不额外分支。
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  let closed = false

  const wasNotified = (taskId: string, kind: string): boolean => {
    // 空 id / 空阶段不是一个「提醒对象」，而「没提醒过」是它唯一可能的答案——
    // 不抛错：注入层会拿账本里的 phase 直接调它，那里抛错等于让提醒链路整段失效。
    if (typeof taskId !== 'string' || taskId === '') return false
    if (typeof kind !== 'string' || kind === '') return false
    const row = db.prepare(
      'SELECT EXISTS(SELECT 1 FROM reminders WHERE task_id = ? AND kind = ?) AS hit',
    ).get(taskId, kind) as unknown as { hit: number | bigint } | undefined
    return row !== undefined && Number(row.hit) === 1
  }

  const lastNotifiedAt = (taskId: string, kind: string): number | undefined => {
    // 同 wasNotified：空 id / 空阶段不是一个「提醒对象」，不抛错。
    if (typeof taskId !== 'string' || taskId === '') return undefined
    if (typeof kind !== 'string' || kind === '') return undefined
    const row = db.prepare(
      'SELECT notified_at_ms AS at FROM reminders WHERE task_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    ).get(taskId, kind) as unknown as { at: number | bigint } | undefined
    return row === undefined ? undefined : Number(row.at)
  }

  const record = (input: ReminderRecordInput): void => {
    const taskId = requireText(input.taskId, 'taskId')
    const kind = requireText(input.kind, 'kind')
    const notifiedAtMs = requireFinite(input.notifiedAtMs, 'notifiedAtMs')
    db.prepare(
      `INSERT INTO reminders (task_id, kind, notified_at_ms) VALUES (?,?,?)`,
    ).run(taskId, kind, notifiedAtMs)
  }

  const list = (opts: ReminderListQuery = {}): ReminderRow[] => {
    const limit = normalizeLimit(opts.limit)
    if (limit === 0) return []
    if (limit === undefined) {
      const rows = db.prepare(
        `SELECT ${SELECT_COLUMNS} FROM reminders ORDER BY id ASC`,
      ).all() as unknown as ReminderDbRow[]
      return rows.map(toRow)
    }
    // 给了上限就取「最近 N 条」，再翻转回升序——调用方关心的是最近的轨迹，
    // 但返回顺序与无上限时一致（按写入先后），两种调用不必分两套读法。
    const rows = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM reminders ORDER BY id DESC LIMIT ?`,
    ).all(limit) as unknown as ReminderDbRow[]
    return rows.map(toRow).reverse()
  }

  const close = (): void => {
    if (closed) return
    closed = true
    db.close()
  }

  return { wasNotified, lastNotifiedAt, record, list, close }
}
