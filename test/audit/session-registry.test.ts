/**
 * 会话身份注册表：事件 + 投影 + 重建。
 *
 * 设计见 `docs/design-session-identity.md` §3.1。本组测试只钉住基础设施：
 * 注册/释放落链、投影可读、重建等价、同库两实例可见、校验拒空。
 * **不收窄任何权限**——未注册仍按主会话走原逻辑（设计 §3.5）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AuditLog } from '../../src/audit/index.ts'
import { makeTmp } from '../support/tmp.ts'

const sys = { kind: 'system', component: 'authority' } as const

function tmp() {
  const t = makeTmp('prts-session-reg-')
  return {
    db: t.db('a.sqlite'),
    cleanup(...closables: { close(): void }[]) { t.cleanup(...closables) },
  }
}

test('R1 注册主会话与子会话：事件落链，投影可读', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.registerSession(sys, { sessionId: 'main-1', kind: 'primary', roots: ['C:/ws'] })
    a.registerSession(sys, {
      sessionId: 'sub-1', kind: 'subagent', roots: ['C:/ws/.prts-subtask/t1'], parentSession: 'main-1',
    })
    const rows = a.listSessions()
    assert.equal(rows.length, 2)
    const sub = rows.find((r) => r.sessionId === 'sub-1')
    assert.equal(sub?.kind, 'subagent')
    assert.deepEqual(sub?.roots, ['C:/ws/.prts-subtask/t1'])
    assert.equal(sub?.parentSession, 'main-1')
    assert.equal(sub?.releasedAtMs, null)
    assert.ok((sub?.registeredAtMs ?? 0) > 0)
  } finally { t.cleanup(a) }
})

test('R2 释放：released_at_ms 落投影，行保留', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.registerSession(sys, { sessionId: 'sub-1', kind: 'subagent', roots: [] })
    a.releaseSession(sys, 'sub-1')
    const rows = a.listSessions()
    assert.equal(rows.length, 1, '释放不删行——审计只追加')
    assert.notEqual(rows[0]?.releasedAtMs, null)
  } finally { t.cleanup(a) }
})

test('R3 重建：增量 == 重建', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    a.registerSession(sys, { sessionId: 'main-1', kind: 'primary', roots: ['C:/ws'] })
    a.registerSession(sys, { sessionId: 'sub-1', kind: 'subagent', roots: ['C:/ws/sub'], parentSession: 'main-1' })
    a.releaseSession(sys, 'sub-1')
    const before = a.listSessions()
    a.rebuildProjections()
    assert.deepEqual(a.listSessions(), before, 'rebuild 后投影必须与增量一致')
  } finally { t.cleanup(a) }
})

test('R4 同库两实例：一实例注册，另一实例立即可见（无进程内缓存）', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  const b = AuditLog.open(t.db)
  try {
    a.registerSession(sys, { sessionId: 's1', kind: 'subagent', roots: [] })
    assert.equal(b.listSessions().length, 1, '授权事实无进程内缓存')
  } finally { t.cleanup(a, b) }
})

test('R5 校验：空 sessionId / 坏 kind 拒收；空 roots 合法', () => {
  const t = tmp()
  const a = AuditLog.open(t.db)
  try {
    assert.throws(
      () => a.registerSession(sys, { sessionId: '', kind: 'primary', roots: [] }),
      /sessionId|INVALID_INPUT/,
    )
    assert.throws(
      () => a.registerSession(sys, { sessionId: 's', kind: 'bad' as never, roots: [] }),
      /kind|INVALID_INPUT/,
    )
    a.registerSession(sys, { sessionId: 's2', kind: 'primary', roots: [] })
    assert.equal(a.listSessions().length, 1, '空 roots 是合法状态（只读会话）')
  } finally { t.cleanup(a) }
})
