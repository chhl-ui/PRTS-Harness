/**
 * `MemoryStore.recentTurns` 的补充行为测试——钉住验收合同
 * （`test/memory/recent-turns.test.ts`）没有覆盖的条款：
 *
 * - `occurred_at_ms` 为 NULL 的行排**最后**（既不被丢掉，也不被排最前——
 *   时间缺失不等于「刚刚」，也不等于「很久以前」）
 * - 非有限的 `limit` 回落 1，不把整段静默变成空（0 条与「库里没数据」不可区分）
 * - `RecentTurn` 从模块入口导出：消费方只 import 入口，不走深路径
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import type { RecentTurn } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

test('RTX1 occurred_at_ms 缺失的行排最后，且仍被返回', () => {
  const t = makeTmp('prts-recent-extra-')
  const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({
      actor: 'owner', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '没有时间戳',
    })
    store.recordTurn({
      actor: 'owner', sessionId: 's1', turnIndex: 1, speaker: 'user',
      text: '有时间戳', occurredAtMs: 1_700_000_000_000,
    })

    const out = store.recentTurns()
    assert.deepEqual(out.map((r) => r.text), ['有时间戳', '没有时间戳'])
    assert.equal(out[1].occurredAtMs, null, '时间缺失的原始值必须是 null，不能被填成 0')
  } finally { t.cleanup(store) }
})

test('RTX2 非有限的 limit 回落 1，不把整段静默变成空', () => {
  const t = makeTmp('prts-recent-extra-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn({ actor: 'owner', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '第一条', occurredAtMs: base })
    store.recordTurn({ actor: 'owner', sessionId: 's1', turnIndex: 1, speaker: 'user', text: '第二条', occurredAtMs: base + 60_000 })

    assert.equal(store.recentTurns({ limit: Number.NaN }).length, 1)
    assert.equal(store.recentTurns({ limit: Number.POSITIVE_INFINITY }).length, 1)
    assert.equal(store.recentTurns({ limit: -3 }).length, 1)
  } finally { t.cleanup(store) }
})

test('RTX3 RecentTurn 从模块入口导出（类型契约）', () => {
  const row: RecentTurn = {
    turnId: 'turn-1', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '内容', occurredAtMs: null,
  }
  assert.equal(row.turnId, 'turn-1')
})
