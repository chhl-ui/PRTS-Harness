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
  identity_key       TEXT,
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
-- idx_facts_identity 由 ensureFactIdentityColumn 创建，不放在 SCHEMA 里：
-- 旧库执行 SCHEMA 时 identity_key 列还不存在（ALTER 在 SCHEMA 之后），
-- 索引若写在这里，SQLite 会在建索引阶段抛 no such column，迁移函数根本没机会跑。

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

CREATE TABLE IF NOT EXISTS mem_sessions (
  session_id     TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'prts',
  origin         TEXT NOT NULL,
  body           TEXT NOT NULL,
  turn_count     INTEGER NOT NULL DEFAULT 0,
  updated_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_scope ON mem_sessions(scope, origin);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts_sessions USING fts5(body, tokenize='trigram');

CREATE TABLE IF NOT EXISTS mem_profiles (
  profile_id         TEXT PRIMARY KEY,
  scope              TEXT NOT NULL DEFAULT 'prts',
  subject            TEXT NOT NULL,
  aspect             TEXT NOT NULL,
  profile_body       TEXT NOT NULL,
  evidence_fact_ids  TEXT,
  confidence         REAL NOT NULL DEFAULT 0.5,
  updated_at_ms      INTEGER NOT NULL,
  deleted_at_ms      INTEGER,
  CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX IF NOT EXISTS idx_profiles_scope ON mem_profiles(scope, aspect, deleted_at_ms);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts_profiles USING fts5(body, tokenize='trigram');

-- 向量（v2.17）：只对派生项（fact / profile）建，不对 turn 建——turn 是 24.6 万级，
-- 全量余弦不划算；且 turn 的瓶颈在粒度不在语义（v2.11）。
-- 主键 (owner_kind, owner_id) 不含 model：换模型就地覆盖，避免新旧向量混用
-- 产生「同一个库里有两种语义空间」的静默错误。
-- 不参与 rebuildProjections——与 mem_profiles 同理，它是巩固/向量化的派生项，
-- 不是事件链的纯函数（重建后保留，见 test/memory/profile-gate.test.ts P3 的同款约定）。
CREATE TABLE IF NOT EXISTS mem_vectors (
  owner_kind     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  model          TEXT NOT NULL,
  dim            INTEGER NOT NULL,
  vector         BLOB NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (owner_kind, owner_id)
);

-- ---- 巩固管线（Wave 2，规则部分）----
-- 这三张表与 mem_profiles 同类：**链外派生项**，不是事件序列的纯函数。
-- 理由：巩固依赖 turn 正文，而正文外置在 mem_bodies（不在事件链上，设计稿 §6.2 路线 D）。
-- 把正文烤进事件会破坏链上只留 body_ref + sha256 的形状，那是唯一不可逆点（§八 不变量 9）。
-- 因此它们不参与 rebuildProjections，重建后如实保留；清空它们等于重置巩固进度。

-- 水位线：处理到哪一行。游标只前进，重复跑同一游标必然幂等。
CREATE TABLE IF NOT EXISTS mem_consolidation (
  scope              TEXT PRIMARY KEY,
  cursor_turn_rowid  INTEGER NOT NULL DEFAULT 0,
  cursor_event_seq   INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL,
  budget_spent       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mem_entities (
  entity_key     TEXT PRIMARY KEY,
  scope          TEXT NOT NULL DEFAULT 'prts',
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  mention_count  INTEGER NOT NULL DEFAULT 0,
  first_seen_ms  INTEGER NOT NULL,
  last_seen_ms   INTEGER NOT NULL,
  CHECK (kind IN ('proper','quoted','quantity','acronym'))
);
CREATE INDEX IF NOT EXISTS idx_entities_scope ON mem_entities(scope, kind, mention_count);

-- 无向边只存一条：规范化 from_key < to_key。存双向会让「A–B 共现 3 次」在两行上
-- 各记 3 次，扩散激活按 weight 取邻居时得到双份权重——比例是对的，绝对值会翻倍，
-- 之后任何阈值（SPREAD_MIN_WEIGHT）都要跟着猜。
-- 本表不设 scope 列：边的两端是 entity_key，scope 已隐含在实体键里；
-- 强行加入会破坏 (from_key,to_key,kind) 这个唯一性语义。
CREATE TABLE IF NOT EXISTS mem_links (
  from_key      TEXT NOT NULL,
  to_key        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  weight        REAL NOT NULL DEFAULT 1,
  last_seen_ms  INTEGER NOT NULL,
  PRIMARY KEY (from_key, to_key, kind)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON mem_links(to_key, weight);

-- 实体 → 出现位置（Wave 4 补的洞）。
--
-- 没有这张表，关联图只能导航到「实体名」，召回不了任何内容：mem_links 是
-- 实体↔实体，mem_entities 只有实体自身。扩散激活要产出候选，必须有这一步。
-- 也不能用 FTS 代替：trigram 对 AI / TV 这类 2 字符实体恒为 0，而它们
-- 恰恰是出现最多的一批。
--
-- 键用 turn_id 而不是 rowid：rebuildProjections 会重建 mem_turns，rowid 会漂；
-- mentions 是链外派生项不参与重放，漂了之后会永久指向错误的 turn 且无报错。
CREATE TABLE IF NOT EXISTS mem_mentions (
  entity_key  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  PRIMARY KEY (entity_key, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_turn ON mem_mentions(turn_id);
`

/** 打开（或创建）记忆库。`secure_delete` 是设计稿 §八 第 15 条的硬要求。 */
export function openMemoryDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA secure_delete = ON')
  db.exec(SCHEMA)
  ensureFactIdentityColumn(db)
  ensureFtsIndexed(db)
  ensureSessionsBuilt(db)
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
/**
 * `identity_key` 列的自愈迁移（v2.9）。
 *
 * 新旧库都要能用：新库由 SCHEMA 直接建列；旧库执行到这里时列不存在，需要
 * ALTER 并**回填**——没有回填的老行身份键为 NULL，冲突检测永远不命中，
 * 会静默退化成「重复堆积」的旧行为。
 *
 * 身份键 = lower(trim(subject)) + '|' + lower(trim(predicate))。
 * 语义：同一主体同一谓词的新值取代旧值，旧行 retired 而非删除——即架构需求
 * §5.3 的「冲突保留，不静默覆盖」；保留不等于堆积。
 */
function ensureFactIdentityColumn(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(mem_facts)').all() as Array<{ name: string }>).map((c) => c.name)
  if (!cols.includes('identity_key')) db.exec('ALTER TABLE mem_facts ADD COLUMN identity_key TEXT')
  // 老行没有 sha256 可当指纹，回填成逐行唯一的键（legacy:<fact_id>）：
  // 宁可让它们互不去重，也不能把两条不同的老事实错判成同一条。
  db.exec("UPDATE mem_facts SET identity_key = lower(trim(subject)) || '|' || lower(trim(predicate)) || '|legacy:' || fact_id WHERE identity_key IS NULL")
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_identity ON mem_facts(identity_key, retired_at_ms, deleted_at_ms)')
}

/**
 * session 级索引（v2.12）。
 *
 * 为什么需要：turn 级检索从每题 491 个候选里选 8 个，噪声把信号淹了——
 * 实测 any@8 只有 38.8%。而按 session 检索（每题中位 48 个候选里选 3-10 个），
 * 同样的朴素方法就能到 any@3 85.6% / all@10 80.8%。
 *
 * 为什么不能复用 turn 级索引聚合：实测只到 55.8%（turn 级 top-200 再聚合），
 * 比直接检索 session 文本低 25pp——turn 级每条只留最佳匹配，聚合后丢了
 * session 的整体主题信号。
 *
 * 维护方式：turn 写入时按 session 重算聚合文本（单个 session 约 10 turn，
 * 成本可忽略）；这里负责把**旧的或缺失的** session 补建出来。
 */
/**
 * @param inTransaction 调用方已开事务时传 true——SQLite 不允许嵌套 BEGIN，
 *   `rebuildProjections` 就是在自己的事务里调它。
 */
export function ensureSessionsBuilt(db: DatabaseSync, inTransaction = false): void {
  const missing = db.prepare(
    `SELECT t.session_id AS sid, t.scope AS scope, t.origin AS origin,
            group_concat(b.body, ' ') AS body, count(*) AS n, max(t.rowid) AS maxrid
       FROM mem_turns t
       JOIN mem_bodies b ON b.body_ref = t.body_ref
      WHERE b.body IS NOT NULL AND t.deleted_at_ms IS NULL
        AND t.session_id NOT IN (SELECT session_id FROM mem_sessions)
      GROUP BY t.session_id`,
  ).all() as Array<{ sid: string; scope: string; origin: string; body: string | null; n: number; maxrid: number }>
  if (missing.length === 0) return

  if (!inTransaction) db.exec('BEGIN IMMEDIATE')
  try {
    const ins = db.prepare(
      `INSERT INTO mem_sessions (session_id, scope, origin, body, turn_count, updated_at_ms)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET body = excluded.body,
         turn_count = excluded.turn_count, updated_at_ms = excluded.updated_at_ms`,
    )
    const del = db.prepare('DELETE FROM mem_fts_sessions WHERE rowid = (SELECT rowid FROM mem_sessions WHERE session_id = ?)')
    const insFts = db.prepare(
      'INSERT INTO mem_fts_sessions(rowid, body) SELECT rowid, body FROM mem_sessions WHERE session_id = ?',
    )
    for (const r of missing) {
      const body = r.body ?? ''
      ins.run(r.sid, r.scope, r.origin, body, r.n, Date.now())
      del.run(r.sid)
      insFts.run(r.sid)
    }
    if (!inTransaction) db.exec('COMMIT')
  } catch (e) {
    if (!inTransaction) db.exec('ROLLBACK')
    throw e
  }
}

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
