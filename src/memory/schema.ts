/** 记忆模块：库结构与打开入口。DDL 对应 `docs/design-memory-v1.md` §6.2。 */
import { DatabaseSync } from 'node:sqlite'

/**
 * 七张表。`memory_events` 是事实来源（只追加哈希链），其余是投影。
 *
 * 两条约束写在 SQL 里而不是只写文档：
 * - `provenance` / `confirmation_basis` 的组合白名单（设计稿 §八 第 14 条）
 * - `scope` 出现在每张投影表上（设计稿 §八 第 13 条的守卫测试要扫它）
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_events (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  kind           TEXT NOT NULL,
  occurred_at_ms INTEGER,
  occurred_raw   TEXT,
  recorded_at_ms INTEGER NOT NULL,
  actor_kind     TEXT NOT NULL,
  scope          TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_bodies (
  body_ref       TEXT PRIMARY KEY,
  sha256         TEXT NOT NULL,
  body           TEXT,
  byte_length    INTEGER NOT NULL,
  written_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_turns (
  turn_id        TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'prts',
  session_id     TEXT NOT NULL,
  turn_index     INTEGER NOT NULL,
  external_id    TEXT,
  speaker        TEXT NOT NULL,
  body_ref       TEXT,
  occurred_at_ms INTEGER,
  occurred_raw   TEXT,
  origin         TEXT NOT NULL,
  is_evidence    INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON mem_turns(session_id, turn_index);
CREATE INDEX IF NOT EXISTS idx_turns_origin  ON mem_turns(origin, deleted_at_ms);

CREATE TABLE IF NOT EXISTS mem_facts (
  fact_id            TEXT PRIMARY KEY,
  scope              TEXT NOT NULL DEFAULT 'prts',
  subject            TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  body_ref           TEXT,
  valid_from_ms      INTEGER,
  valid_to_ms        INTEGER,
  recorded_at_ms     INTEGER NOT NULL,
  provenance         TEXT NOT NULL,
  confirmation_basis TEXT NOT NULL,
  origin             TEXT NOT NULL,
  confidence         REAL,
  revision           INTEGER NOT NULL DEFAULT 1,
  applicable_when    TEXT,
  retention_class    TEXT NOT NULL DEFAULT 'clearable',
  source_turn_ids    TEXT,
  importance         REAL NOT NULL DEFAULT 0.5,
  retired_at_ms      INTEGER,
  deleted_at_ms      INTEGER,
  CHECK (provenance IN ('stated','inferred')),
  CHECK (confirmation_basis IN ('owner-stated','model-inferred','verifier')),
  CHECK (NOT (provenance = 'stated' AND confirmation_basis = 'model-inferred')),
  CHECK (origin IN ('live','benchmark')),
  CHECK (retention_class IN ('permanent','retirable','clearable'))
);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON mem_facts(scope, deleted_at_ms, retired_at_ms);

CREATE TABLE IF NOT EXISTS mem_summaries (
  summary_id     TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'prts',
  subject_kind   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  body_ref       TEXT,
  source_turn_ids TEXT,
  generated_at_ms INTEGER NOT NULL,
  deleted_at_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS mem_topics (
  topic          TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'prts',
  entry_count    INTEGER NOT NULL,
  last_seen_ms   INTEGER,
  source_kind    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_deletions (
  deletion_id     TEXT PRIMARY KEY,
  scope           TEXT NOT NULL DEFAULT 'prts',
  target_json     TEXT NOT NULL,
  derivatives_json TEXT NOT NULL,
  state           TEXT NOT NULL,
  completed_scope TEXT,
  completed       INTEGER NOT NULL DEFAULT 0,
  requested_at    INTEGER NOT NULL,
  completed_at    INTEGER,
  CHECK (state IN ('requested','purged-in-tx','external-pending','completed'))
);

-- 全文索引（v2.6）：trigram 是唯一能匹配中文 3 字以上的 tokenizer
-- （unicode61 / porter 对"光学镜"恒为 0，实测见 docs/design-memory-v1.md §5.3），
-- 同时对英文子串有效。中文 2 字它匹配不了，由 search() 的 LIKE 回退承担。
-- rowid 与 mem_turns / mem_facts 的隐式 rowid 对齐，由 fold.ts 在投影更新时同步维护。
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts_turns USING fts5(body, tokenize='trigram');
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts_facts USING fts5(body, tokenize='trigram');
`

/** 打开（或创建）记忆库。`secure_delete` 是设计稿 §八 第 15 条的硬要求。 */
export function openMemoryDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA secure_delete = ON')
  db.exec(SCHEMA)
  ensureFtsIndexed(db)
  return db
}

/**
 * 索引自愈（v2.6）。
 *
 * 旧库在升级前没有 FTS 表，`CREATE VIRTUAL TABLE IF NOT EXISTS` 会建出**空表**，
 * 而历史行早已走过 fold、不会重放——检索于是静默退化成全表 LIKE。
 * 实测：10,960 turn 的旧库打开后 recallPath 全是 'like'，无任何报错。
 * 计数不一致就按投影重建：这是唯一不需要重放事件链就能修复索引的时点。
 */
function ensureFtsIndexed(db: DatabaseSync): void {
  const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
  const turnsExpect = count(
    `SELECT count(*) c FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
      WHERE b.body IS NOT NULL AND t.deleted_at_ms IS NULL`,
  )
  const turnsActual = count('SELECT count(*) c FROM mem_fts_turns')
  const factsExpect = count('SELECT count(*) c FROM mem_facts WHERE deleted_at_ms IS NULL')
  const factsActual = count('SELECT count(*) c FROM mem_fts_facts')
  if (turnsExpect === turnsActual && factsExpect === factsActual) return

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM mem_fts_turns; DELETE FROM mem_fts_facts')
    db.exec(`
      INSERT INTO mem_fts_turns(rowid, body)
        SELECT t.rowid, b.body FROM mem_turns t
          JOIN mem_bodies b ON b.body_ref = t.body_ref
         WHERE b.body IS NOT NULL AND t.deleted_at_ms IS NULL;
      INSERT INTO mem_fts_facts(rowid, body)
        SELECT f.rowid, f.subject || ' ' || f.predicate || ' ' || COALESCE(b.body, '')
          FROM mem_facts f LEFT JOIN mem_bodies b ON b.body_ref = f.body_ref
         WHERE f.deleted_at_ms IS NULL;
    `)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
