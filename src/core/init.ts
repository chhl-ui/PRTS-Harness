import { DatabaseSync } from 'node:sqlite'
import { SCHEMA as LEDGER_SCHEMA } from '../ledger/ledger.ts'
import { SCHEMA as AUDIT_SCHEMA } from '../audit/audit.ts'

/**
 * 在一个事务里建齐 K1 + K4 的全部表（幂等），并设 WAL。
 * 运行时启动顺序：startupCheck → 正常则 initCoreDb → 打开 Ledger/AuditLog。
 * 只读模式下不得调用。
 */
export function initCoreDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(LEDGER_SCHEMA)
      db.exec(AUDIT_SCHEMA)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  } finally {
    db.close()
  }
}
