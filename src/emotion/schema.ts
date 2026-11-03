/**
 * 情绪库的存储结构。
 *
 * 与 ledger / audit / skills / persona 同构：`emotion_events` 是**事实来源**
 * （只追加、sha256 链），`emotion_state` 是**投影**（单行，id=1，只能由
 * `fold.ts` 的 `applyEmotionEvent` 更新，可随时 `rebuildProjections` 重建）。
 *
 * 为什么是独立 SQLite 文件而不是塞进 memory.sqlite：
 * - 记忆要遗忘衰减、要合并、要删除；情绪不删除、不合并，只覆盖与衰减。
 *   混在一条链里，「这条记录为什么消失」的口径就漂移了（V1-05 要的是可取证的情绪史）。
 * - 物理分离是「情感不参与事实层」最硬的一道保证：`EmotionStore` 的连接里
 *   根本没有 `memories` / `tasks` / `grants` 这些表。想在情绪库里影响检索，
 *   得先在没有那张表的地方写一条 SQL——做不到，而不是「约定不要做」。
 *
 * `emotion_state` 用 `CHECK (id = 1)` 把「单行投影」写进结构本身：
 * 多行状态意味着「当前心情」不唯一，任何一处读到的都可能不是真的。
 */
import { DatabaseSync } from 'node:sqlite'

const DDL = `
CREATE TABLE IF NOT EXISTS emotion_events (
  seq          INTEGER PRIMARY KEY,
  revision     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor_json   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS emotion_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  revision   INTEGER NOT NULL,
  valence    REAL NOT NULL,
  arousal    REAL NOT NULL,
  label      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export function openEmotionDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // 与 skills / memory / persona 同一取舍：WAL 让读不阻塞写，桌面单用户场景利大于弊。
  db.exec('PRAGMA journal_mode = WAL')
  // 情绪库是独立文件，TUI 与 CLI 可能同时开着它。写事务走 BEGIN IMMEDIATE
  // （见 store.ts 的 tx），没有 busy_timeout 时第二个写者会当场收到 SQLITE_BUSY；
  // 5s 内重试而不是失败，才符合「桌面单用户，绝不真并发写」的实际。
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  return db
}
