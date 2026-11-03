/**
 * 技能库的存储结构。
 *
 * 与 ledger / audit / memory 同构：`skill_events` 是**事实来源**（只追加、
 * sha256 链），`skills` 是**投影**（只能由 `fold.ts` 的 `applySkillEvent` 更新，
 * 可随时 `rebuildProjections` 重建）。
 *
 * 为什么不塞进 memory.sqlite：技能的状态机（candidate/active/retired/rejected）
 * 与记忆的（turn/fact/summary/profile）没有一处相同，生命周期也不同——技能不参与
 * 遗忘衰减，只参与评估与回退。混在一条链里会让「这条记忆从哪来」的追溯口径漂移。
 */
import { DatabaseSync } from 'node:sqlite'

const DDL = `
CREATE TABLE IF NOT EXISTS skill_events (
  seq          INTEGER PRIMARY KEY,
  skill_id     TEXT NOT NULL,
  revision     INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor_json   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skill_events_skill ON skill_events(skill_id, revision);

CREATE TABLE IF NOT EXISTS skills (
  skill_id          TEXT PRIMARY KEY,
  revision          INTEGER NOT NULL,
  phase             TEXT NOT NULL,
  title             TEXT NOT NULL,
  trigger_text      TEXT NOT NULL,
  steps_json        TEXT NOT NULL,
  pitfalls_json     TEXT NOT NULL,
  source_refs_json  TEXT NOT NULL,
  proposed_by_json  TEXT NOT NULL,
  evaluations_json  TEXT NOT NULL,
  retire_reason     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_phase ON skills(phase, updated_at);
`

export function openSkillDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  // 与 memory 同一取舍：WAL 让读不阻塞写，桌面单用户场景下利大于弊。
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL)
  return db
}
