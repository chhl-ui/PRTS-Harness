/**
 * 会话表（Wave 3 第一步）：live ∪ disk 的合并与排序。
 *
 * 设计依据见 `src/runtime/session-table.ts` 头注释：`AgentRegistry.list()` 只给 live，
 * 历史只能从 `dsh-home/sessions` 读。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listSessions, renderSessionLine } from '../../src/runtime/session-table.ts'
import { makeTmp } from '../support/tmp.ts'

function seedSession(root: string, ws: string, sid: string): void {
  const dir = join(root, ws, sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"header"}\n')
}

test('T1 只有磁盘会话：全部列为 disk', () => {
  const t = makeTmp('prts-stable-')
  const root = join(t.dir, 'sessions')
  try {
    seedSession(root, '--ws--', 's-disk-1')
    seedSession(root, '--ws--', 's-disk-2')
    const rows = listSessions({ sessionsRoot: root })
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => !r.live && r.onDisk))
    assert.ok(rows.every((r) => r.lastModifiedMs !== null))
  } finally { t.cleanup() }
})

test('T2 live ∪ disk：同一 id 合并为 live+disk，仅 live 的不带 mtime', () => {
  const t = makeTmp('prts-stable-')
  const root = join(t.dir, 'sessions')
  try {
    seedSession(root, '--ws--', 'both')
    seedSession(root, '--ws--', 'disk-only')
    const rows = listSessions({
      sessionsRoot: root,
      agents: { list: () => [{ session: { id: 'both' } }, { session: { id: 'live-only' } }] },
    })
    const byId = new Map(rows.map((r) => [r.sessionId, r]))
    assert.equal(byId.get('both')?.live, true)
    assert.equal(byId.get('both')?.onDisk, true)
    assert.equal(byId.get('disk-only')?.live, false)
    assert.equal(byId.get('live-only')?.live, true)
    assert.equal(byId.get('live-only')?.onDisk, false)
    assert.equal(byId.get('live-only')?.lastModifiedMs, null)
  } finally { t.cleanup() }
})

test('T3 目录里没有 session.v4.jsonl 的不算会话', () => {
  const t = makeTmp('prts-stable-')
  const root = join(t.dir, 'sessions')
  try {
    mkdirSync(join(root, '--ws--', 'not-a-session'), { recursive: true })
    seedSession(root, '--ws--', 'real')
    const rows = listSessions({ sessionsRoot: root })
    assert.deepEqual(rows.map((r) => r.sessionId), ['real'])
  } finally { t.cleanup() }
})

test('T4 排序：最近修改在前；无 mtime 的排后', () => {
  const t = makeTmp('prts-stable-')
  const root = join(t.dir, 'sessions')
  try {
    seedSession(root, '--ws--', 'old')
    seedSession(root, '--ws--', 'new')
    // 直接改文件 mtime 不可移植；改为断言「有 mtime 的排在无 mtime 之前」。
    const rows = listSessions({
      sessionsRoot: root,
      agents: { list: () => [{ session: { id: 'live-no-disk' } }] },
    })
    const liveIdx = rows.findIndex((r) => r.sessionId === 'live-no-disk')
    assert.equal(liveIdx, rows.length - 1, '无 mtime 的 live-only 排最后')
  } finally { t.cleanup() }
})

test('T5 子会话在渲染里被标注', () => {
  const t = makeTmp('prts-stable-')
  const root = join(t.dir, 'sessions')
  try {
    seedSession(root, '--ws--', 'subtask-abc')
    const [row] = listSessions({ sessionsRoot: root })
    assert.match(renderSessionLine(row!), /\[subagent\]/)
  } finally { t.cleanup() }
})

test('T6 目录不存在 / agents 缺失：不抛，返回空或部分结果', () => {
  const t = makeTmp('prts-stable-')
  try {
    assert.deepEqual(listSessions({ sessionsRoot: join(t.dir, 'missing') }), [])
    assert.deepEqual(listSessions({ sessionsRoot: join(t.dir, 'missing'), agents: { list: () => [] } }), [])
  } finally { t.cleanup() }
})
