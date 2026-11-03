/**
 * 人格库的存储结构。
 *
 * 与 ledger / audit / skills 同构：`persona_events` 是**事实来源**（只追加、
 * sha256 链），`persona_presets` 与 `persona_active` 是**投影**（只能由
 * `fold.ts` 的 `applyPersonaEvent` 更新，可随时 `rebuildProjections` 重建）。
 *
 * 为什么不塞进 config/prts.yml 或 memory.sqlite：
 * - 配置文件改了就没了——没有「谁在什么时候把底线从 A 改成了 B」。V1-09 要的正是这个。
 * - 记忆要遗忘衰减，人格不能衰减：人格不参与任何衰减/淘汰，只参与取证。
 *   混在一条链里，「这条记录为什么消失」的口径就漂移了。
 *
 * 独立 SQLite 文件还有一个副作用是好的：人格库与账本库物理分离，
 * 切换人格连「顺手改一下账本」的可能性都没有（V1-04）。
 */
import { DatabaseSync } from 'node:sqlite'

const DDL = `
CREATE TABLE IF NOT EXISTS persona_events (
  seq          INTEGER PRIMARY KEY,
  preset       TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor_json   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_events_preset ON persona_events(preset, revision);

CREATE TABLE IF NOT EXISTS persona_presets (
  preset     TEXT PRIMARY KEY,
  revision   INTEGER NOT NULL,
  core       TEXT NOT NULL,
  style      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_active (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  preset     TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function openPersonaDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // 与 skills / memory 同一取舍：WAL 让读不阻塞写，桌面单用户场景利大于弊。
  db.exec('PRAGMA journal_mode = WAL')
  // 人格库是**独立文件**，TUI 与 CLI 可能同时开着它。写事务走 BEGIN IMMEDIATE
  // （见 store.ts 的 tx），没有 busy_timeout 时第二个写者会当场收到 SQLITE_BUSY；
  // 5s 内重试而不是失败，才符合「桌面单用户，绝不真并发写」的实际。
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  return db
}
