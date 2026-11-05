/**
 * V1-16 装配延迟回归：`turnEntities` 的查询计划必须先用 `turn_id` 索引。
 *
 * 背景（2026-11-05 实测）：原 SQL 把 `e.scope = ?` 写在 JOIN 条件上，SQLite 选择
 * 「先扫 scope='prts' 的全部实体，再对每个实体回查 mentions」——在 71.7 万条
 * mentions 的基准库上单次 **646ms**。装配每轮调它一次，把 V1-16 的端到端 p95
 * 推到 1610ms（判据是 ≤1s）。
 *
 * 这里钉的是**计划**而不是墙钟：耗时断言在不同机器上不稳，而「先按 turn_id
 * 索引筛 mentions」是这条 SQL 唯一正确的执行形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { turnEntitiesSql } from '../../src/memory/store.ts'
import { makeTmp } from '../support/tmp.ts'

test('T1 turnEntities 先用 turn_id 索引筛 mentions，而不是先扫全部实体', () => {
  const t = makeTmp('prts-mem-turnent-')
  const m = MemoryStore.open(t.db('memory.sqlite'))
  const path = t.db('memory.sqlite')
  try {
    // 造出「实体多、mentions 少」的形状——正是基准库（24.6 万 turn / 71.7 万
    // mentions）会让优化器选错计划的那种分布。
    const raw = new DatabaseSync(path)
    try {
      const insEntity = raw.prepare(
        'INSERT INTO mem_entities (entity_key, scope, name, kind, mention_count, first_seen_ms, last_seen_ms)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (let i = 0; i < 200; i += 1) {
        insEntity.run(`ent-${i}`, 'prts', `name-${i}`, 'proper', 1, 1, 1)
      }
      const insMention = raw.prepare('INSERT INTO mem_mentions (entity_key, turn_id) VALUES (?, ?)')
      for (let i = 0; i < 5; i += 1) insMention.run(`ent-${i}`, `turn-${i}`)

      // 用**产品代码的查询文本**做计划断言——测试自己写一份 SQL 只能证明那份 SQL 对，
      // 证明不了线上跑的那条对。
      const plan = raw.prepare(`EXPLAIN QUERY PLAN ${turnEntitiesSql(5)}`)
        .all('turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4', 'prts') as Array<{ detail: string }>
      const details = plan.map((r) => r.detail).join(' | ')
      assert.match(details, /SEARCH m USING (COVERING )?INDEX idx_mentions_turn \(turn_id=\?\)/,
        `计划必须先用 turn_id 索引筛 mentions，实际：${details}`)
    } finally {
      raw.close()
    }
  } finally {
    t.cleanup(m)
  }
})
