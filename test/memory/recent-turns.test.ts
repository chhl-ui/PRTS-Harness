/**
 * `recentTurns`：按时间倒序取最近的 turn，跨会话。
 *
 * 用途是 ⑦ 跨会话连续（`src/runtime/session-recall.ts`）：「上次聊到哪里」
 * 需要一段**与当前查询无关**的时序切片。`search()` 回答不了这个——它是相关性
 * 检索，没有查询词时的「最近」是纯时间语义，硬塞给 BM25 只会得到按字面重叠排序的结果。
 *
 * 与 `recentCorrections` 的区别：那个按更正标记筛，只取 user；这个不筛内容，
 * 由调用方决定渲染谁。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const MIN = 60_000
const HOUR = 60 * MIN

interface RecOver {
  speaker?: string
  origin?: 'live' | 'benchmark'
}

const rec = (sessionId: string, turnIndex: number, text: string, atMs: number, over: RecOver = {}) => ({
  actor: 'owner' as const,
  sessionId,
  turnIndex,
  speaker: over.speaker ?? 'user',
  text,
  occurredAtMs: atMs,
  ...(over.origin === undefined ? {} : { origin: over.origin }),
})

test('RT1 空库返回空数组', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    assert.deepEqual(store.recentTurns(), [])
  } finally { t.cleanup(store) }
})

test('RT2 按发生时刻倒序返回，最近的在最前', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s1', 0, '最早说的', base))
    store.recordTurn(rec('s1', 1, '中间说的', base + HOUR))
    store.recordTurn(rec('s1', 2, '最后说的', base + 2 * HOUR))

    const out = store.recentTurns()
    assert.deepEqual(out.map((r) => r.text), ['最后说的', '中间说的', '最早说的'])
    assert.equal(out[0].turnIndex, 2)
    assert.equal(out[0].sessionId, 's1')
  } finally { t.cleanup(store) }
})

test('RT3 跨会话都返回——这是「跨会话连续」的数据基础', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s-a', 0, '上个会话说的', base))
    store.recordTurn(rec('s-b', 0, '这个会话说的', base + HOUR))

    const out = store.recentTurns()
    assert.equal(out.length, 2)
    assert.deepEqual(out.map((r) => r.sessionId), ['s-b', 's-a'])
  } finally { t.cleanup(store) }
})

test('RT4 excludeSessionId 排除当前会话——它已经在上下文里，重复注入只占预算', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s-old', 0, '旧会话', base))
    store.recordTurn(rec('s-now', 0, '当前会话', base + HOUR))

    const out = store.recentTurns({ excludeSessionId: 's-now' })
    assert.deepEqual(out.map((r) => r.text), ['旧会话'])
  } finally { t.cleanup(store) }
})

test('RT5 sinceMs 窗口过滤：窗口外的旧 turn 不返回', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s1', 0, '很久以前', base))
    store.recordTurn(rec('s1', 1, '刚刚', base + 10 * HOUR))

    const out = store.recentTurns({ sinceMs: base + 5 * HOUR })
    assert.deepEqual(out.map((r) => r.text), ['刚刚'])
  } finally { t.cleanup(store) }
})

test('RT6 limit 截断，默认 5 条', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    for (let i = 0; i < 8; i += 1) store.recordTurn(rec('s1', i, `第 ${i} 条`, base + i * MIN))

    assert.equal(store.recentTurns().length, 5)
    assert.equal(store.recentTurns({ limit: 2 }).length, 2)
    // limit 非法（0 / 负数 / NaN）回落 1，不静默变成「不返回」以外的语义
    assert.equal(store.recentTurns({ limit: 0 }).length, 1)
  } finally { t.cleanup(store) }
})

test('RT7 只返回 live：基准数据的 turn 不进验收路径', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s1', 0, '基准题', base, { origin: 'benchmark' }))
    store.recordTurn(rec('s1', 1, '真实对话', base + HOUR))

    const out = store.recentTurns()
    assert.deepEqual(out.map((r) => r.text), ['真实对话'])
  } finally { t.cleanup(store) }
})

test('RT8 speaker 过滤：只要用户说的', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s1', 0, '主人说的', base, { speaker: 'user' }))
    store.recordTurn(rec('s1', 1, '模型说的', base + MIN, { speaker: 'assistant' }))

    assert.deepEqual(store.recentTurns({ speaker: 'user' }).map((r) => r.text), ['主人说的'])
    assert.equal(store.recentTurns().length, 2, '不传 speaker 时两种都返回')
  } finally { t.cleanup(store) }
})

test('RT9 空正文的 turn 跳过——注进去只有壳没有内容', () => {
  const t = makeTmp('prts-recent-')
  const store = MemoryStore.open(t.db())
  try {
    const base = 1_700_000_000_000
    store.recordTurn(rec('s1', 0, '', base))
    store.recordTurn(rec('s1', 1, '有内容', base + MIN))

    assert.deepEqual(store.recentTurns().map((r) => r.text), ['有内容'])
  } finally { t.cleanup(store) }
})
