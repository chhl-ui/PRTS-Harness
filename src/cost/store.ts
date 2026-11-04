/**
 * 费用留痕库：独立 SQLite，单表只追加。
 *
 * 为什么独立库而不是塞进 ledger / memory：
 * - 费用是**观测数据**不是事实来源，不该进哈希链（进了就要为记账错误做链修复）；
 * - 两个账户（模型 / 巩固）的生命周期与任务账本无关，混表会让 K1 的投影变脏。
 *
 * 为什么在 SQL 里做 SUM 而不是读出来再算：7 天试用可能积累上万行，
 * 每次 `summary` 都全量拉回内存是没必要的；`(kind, recorded_at_ms)` 索引让
 * 按时间窗过滤也是索引扫描。
 */
import { DatabaseSync } from 'node:sqlite'
import type {
  CostBucket, CostRecordInput, CostStore, CostSummary, CostSummaryQuery,
} from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cost_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  usd                REAL    NOT NULL,
  recorded_at_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_kind_time ON cost_entries(kind, recorded_at_ms);
`

/** 有限正数原样返回，其余按 0（坏数据不抵扣、不污染累计）。 */
function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function emptyBucket(): CostBucket {
  return { inputTokens: 0, outputTokens: 0, usd: 0 }
}

export function openCostStore(path: string): CostStore {
  if (typeof path !== 'string' || path === '') {
    throw new TypeError(`cost: 库路径必须是非空字符串，实得 ${String(path)}`)
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  let closed = false

  const insert = db.prepare(
    `INSERT INTO cost_entries
       (kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, usd, recorded_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  )

  const record = (input: CostRecordInput): void => {
    const kind = typeof input.kind === 'string' && input.kind !== '' ? input.kind : 'model'
    const at = typeof input.recordedAtMs === 'number' && Number.isFinite(input.recordedAtMs)
      ? input.recordedAtMs
      : Date.now()
    insert.run(
      kind,
      nonNegative(input.inputTokens),
      nonNegative(input.outputTokens),
      nonNegative(input.cacheReadTokens),
      nonNegative(input.cacheWriteTokens),
      nonNegative(input.usd),
      at,
    )
  }

  const summary = (opts: CostSummaryQuery = {}): CostSummary => {
    const since = typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs) ? opts.sinceMs : undefined
    const rows = db.prepare(
      `SELECT kind,
              SUM(input_tokens)  AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(usd)           AS usd
         FROM cost_entries
        ${since === undefined ? '' : 'WHERE recorded_at_ms >= ?'}
        GROUP BY kind`,
    ).all(...(since === undefined ? [] : [since])) as unknown as Array<{
      kind: string
      input_tokens: number | bigint
      output_tokens: number | bigint
      usd: number
    }>

    const model = emptyBucket()
    const consolidation = emptyBucket()
    for (const row of rows) {
      // 未知 kind 保留在库里但不进两个账户：将来加「嵌入」时才决定它归哪边，
      // 现在混进任一边都会让「模型 vs 巩固」这条判据失真。
      const target = row.kind === 'model'
        ? model
        : row.kind === 'consolidation' ? consolidation : undefined
      if (target === undefined) continue
      target.inputTokens += Number(row.input_tokens ?? 0)
      target.outputTokens += Number(row.output_tokens ?? 0)
      target.usd += Number(row.usd ?? 0)
    }

    const totalUsd = model.usd + consolidation.usd
    const capUsd = typeof opts.capUsd === 'number' && Number.isFinite(opts.capUsd) ? opts.capUsd : undefined
    return {
      model,
      consolidation,
      totalUsd,
      ...(capUsd === undefined ? {} : { capUsd }),
      exceeded: capUsd !== undefined && totalUsd > capUsd,
    }
  }

  const close = (): void => {
    if (closed) return
    closed = true
    db.close()
  }

  return { record, summary, close }
}
