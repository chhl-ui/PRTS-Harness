import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { verifyChainRows } from '../chain/index.ts'
import type { ChainVerifyResult } from '../chain/index.ts'

export type TableCheckResult = ChainVerifyResult | { ok: false; missing: true }

export interface StartupCheckResult {
  mode: 'normal' | 'read-only'
  ledger: TableCheckResult
  audit: TableCheckResult
  problems: string[]
}

interface RawEventRow {
  seq: number
  prev_hash: string
  hash: string
  [col: string]: unknown
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return row !== undefined
}

/**
 * 启动完整性检查（K5 的前半）：单条只读连接查 sqlite_master 判定表存在性，
 * 再逐表 verifyChain。缺表或断链 → mode 'read-only'，problems 逐条记录。
 * 文件不存在 → normal、两链 events=0，且不创建文件。不写任何东西。
 */
export function startupCheck(dbPath: string): StartupCheckResult {
  const problems: string[] = []
  const empty: ChainVerifyResult = { ok: true, events: 0 }
  if (!existsSync(dbPath)) {
    return { mode: 'normal', ledger: empty, audit: { ...empty }, problems }
  }

  // 单只读连接：不存在第二个 open，无泄漏面；无论如何都关闭。
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')

    const ledger = checkTable(db, 'ledger_events', (r) => ({
      seq: r.seq,
      task_id: r.task_id,
      revision: r.revision,
      kind: r.kind,
      actor: JSON.parse(r.actor_json as string),
      payload: JSON.parse(r.payload_json as string),
      ts: r.ts,
    }), problems)
    const audit = checkTable(db, 'audit_events', (r) => ({
      seq: r.seq,
      kind: r.kind,
      actor: JSON.parse(r.actor_json as string),
      payload: JSON.parse(r.payload_json as string),
      ts: r.ts,
    }), problems)

    const mode: StartupCheckResult['mode'] =
      ledger.ok === true && audit.ok === true ? 'normal' : 'read-only'
    return { mode, ledger, audit, problems }
  } finally {
    db.close()
  }
}

function checkTable(
  db: DatabaseSync,
  table: string,
  toFields: (row: RawEventRow) => Record<string, unknown>,
  problems: string[],
): TableCheckResult {
  if (!tableExists(db, table)) {
    problems.push(`missing table: ${table}`)
    return { ok: false, missing: true }
  }
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY seq`).all() as unknown as RawEventRow[]
  const res = verifyChainRows(rows, toFields)
  if (!res.ok) {
    problems.push(`${table} hash chain broken at seq ${res.brokenAtSeq}`)
  }
  return res
}
