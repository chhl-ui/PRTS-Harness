/**
 * 会话身份 API（设计见 `docs/design-session-identity.md` §3.2）。
 *
 * 本组只钉住「谁是谁」：注册、释放、查询。**不收窄任何权限**——
 * 判定收窄（w2-scope）是后续条目，本文件不涉及。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Authority } from '../../src/authority/authority.ts'
import { makeTmp } from '../support/tmp.ts'

function withAuth(fn: (ctx: { a: Authority; db: string }) => void): void {
  const t = makeTmp('prts-session-id-')
  const db = t.db('core.sqlite')
  const a = Authority.open(db, { workspaceRoots: [], protectedRoots: [] })
  try { fn({ a, db }) } finally { a.close(); t.cleanup() }
}

test('S1 主会话：hasSessionScope=true，isSubagentSession=false', () => {
  withAuth(({ a }) => {
    a.registerPrimarySession('main-1')
    assert.equal(a.hasSessionScope('main-1'), true)
    assert.equal(a.isSubagentSession('main-1'), false)
  })
})

test('S2 子会话：isSubagentSession=true；释放后 hasSessionScope=false', () => {
  withAuth(({ a }) => {
    a.registerSessionRoots('sub-1', ['C:/ws/.prts-subtask/t1'], 'main-1')
    assert.equal(a.hasSessionScope('sub-1'), true)
    assert.equal(a.isSubagentSession('sub-1'), true)
    a.releaseSession('sub-1')
    assert.equal(a.hasSessionScope('sub-1'), false, '已释放的会话不再有作用域')
    assert.equal(a.isSubagentSession('sub-1'), false)
  })
})

test('S3 空 sessionId：两者都 false（不返回任何身份）', () => {
  withAuth(({ a }) => {
    assert.equal(a.hasSessionScope(''), false)
    assert.equal(a.isSubagentSession(''), false)
  })
})

test('S4 未注册会话：两者都 false（不施加 deny，只表示「没有身份记录」）', () => {
  withAuth(({ a }) => {
    assert.equal(a.hasSessionScope('nobody'), false)
    assert.equal(a.isSubagentSession('nobody'), false)
  })
})

test('S5 同库两实例：一实例注册，另一实例立即可见', () => {
  const t = makeTmp('prts-session-id2-')
  const db = t.db('core.sqlite')
  const a = Authority.open(db, { workspaceRoots: [], protectedRoots: [] })
  const b = Authority.open(db, { workspaceRoots: [], protectedRoots: [] })
  try {
    a.registerPrimarySession('main-1')
    assert.equal(b.hasSessionScope('main-1'), true, '身份事实无进程内缓存')
  } finally { a.close(); b.close(); t.cleanup() }
})
