/**
 * 授权的作用域：批准与授予都是「给某个会话（的某一次调用）」的，不是「给某个能力的」。
 *
 * 两类作用域，两处判定：
 * 1. **once**（`audit_once.session_id`）：`decide` 的 covered 判定比 `callId + sessionId +
 *    capabilities`。空 sessionId 一律不 covered——运行时确有 `sessionId = ''` 的历史
 *    （见 spill/policy.ts），不能把「没有会话」当成「任何会话」。
 * 2. **grant**（`audit_grants.session_id`，可空）：非空 → 只对该会话生效；null → 全局
 *    （旧数据与所有者显式发的全局授权）。`grantsForSession` 在 `evalCap` 之前统一过滤，
 *    fs.write / net / exec / tool 四族共用同一份收窄，没有哪一族能绕开。
 *
 * 两处收窄都指向同一个不变量：父会话问出来的东西，子会话不能静默继承。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Authority, cap } from '../../src/authority/index.ts'
import { makeTmp } from '../support/tmp.ts'

const CAPS = [cap.net('example.com')]

/** 在 parent 会话上对 callId 'c1' 记一次 allowed-once。 */
function withApprovedOnce(fn: (a: Authority) => void): void {
  const t = makeTmp('prts-once-scope-')
  const a = Authority.open(t.db(), { workspaceRoots: [t.dir], protectedRoots: [] })
  try {
    a.recordOwnerDecision({
      sessionId: 'parent', callId: 'c1', tool: 'fetch',
      capabilities: CAPS, outcome: 'allowed-once',
    })
    fn(a)
  } finally {
    a.close()
    t.cleanup()
  }
}

test('S1 同会话同 callId：批准仍然生效（不因收紧而误伤正常路径）', () => {
  withApprovedOnce((a) => {
    const d = a.decide({ sessionId: 'parent', callId: 'c1', tool: 'fetch', capabilities: CAPS })
    assert.equal(d.kind, 'allow')
    assert.equal(d.kind === 'allow' ? d.via : undefined, 'once', '走的是一次性通道')
  })
})

test('S2 子会话拿同一 callId：批准不跨会话，不得静默放行', () => {
  withApprovedOnce((a) => {
    const call = { sessionId: 'child', callId: 'c1', tool: 'fetch', capabilities: CAPS }
    assert.notEqual(a.decide(call).kind, 'allow', '同一 callId 换会话不能复用 parent 的批准')
    assert.equal(typeof a.guard(call), 'string', '守卫必须拒绝，并返回理由串')
  })
})

test('S3 子会话用另一 callId：没有对应 once 记录，仍是 ask / 拒绝', () => {
  withApprovedOnce((a) => {
    const call = { sessionId: 'child', callId: 'c2', tool: 'fetch', capabilities: CAPS }
    assert.equal(a.decide(call).kind, 'ask', '没有 once 记录就是正常 ask')
    assert.equal(typeof a.guard(call), 'string')
  })
})

test('S4 空 sessionId：一律不 covered', () => {
  withApprovedOnce((a) => {
    const call = { sessionId: '', callId: 'c1', tool: 'fetch', capabilities: CAPS }
    assert.notEqual(a.decide(call).kind, 'allow', '空会话不能继承任何 once')
    assert.equal(typeof a.guard(call), 'string')
  })
})

test('S5 能力不覆盖时依然不回落到 once（能力判定不被会话判定取代）', () => {
  withApprovedOnce((a) => {
    const d = a.decide({
      sessionId: 'parent', callId: 'c1', tool: 'fetch', capabilities: [cap.net('other.com')],
    })
    assert.equal(d.kind, 'ask', 'once 记的是 example.com，other.com 不该被覆盖')
  })
})

// ── 持久 grant 的会话归属 ────────────────────────────────────────────────

/** 独立 tmp 目录：一个工作区（ws）、一个工作区外目录（outside）。 */
function withScopedAuth(fn: (ctx: { a: Authority; outside: string; ws: string }) => void): void {
  const t = makeTmp('prts-grant-scope-')
  const ws = join(t.dir, 'ws')
  const outside = join(t.dir, 'outside')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
  const a = Authority.open(t.db(), {
    workspaceRoots: [realpathSync.native(ws)],
    protectedRoots: [],
  })
  try {
    fn({ a, outside: realpathSync.native(outside), ws: realpathSync.native(ws) })
  } finally {
    a.close()
    t.cleanup()
  }
}

const GRANT_FAMILIES: { name: string; capability: (outside: string) => string; call: (outside: string) => string }[] = [
  { name: 'fs.write', capability: (o) => cap.fsWrite(join(o, 'note.txt')), call: (o) => cap.fsWrite(join(o, 'note.txt')) },
  { name: 'net', capability: () => cap.net('example.com'), call: () => cap.net('example.com') },
  { name: 'exec', capability: () => cap.execShell(), call: () => cap.execShell() },
  { name: 'tool', capability: () => cap.tool('memory_search'), call: () => cap.tool('memory_search') },
]

for (const f of GRANT_FAMILIES) {
  test(`G/父会话的 ${f.name} 持久 grant 不使子会话放行；同会话仍放行`, () => {
    withScopedAuth(({ a, outside }) => {
      a.issueGrant({ subject: 'model', capability: f.capability(outside) as never, expiresAt: null, sessionId: 'parent' })
      const capability = f.call(outside) as never

      const own = a.decide({ sessionId: 'parent', callId: 'c-own', tool: 't', capabilities: [capability] })
      assert.equal(own.kind, 'allow', '归属会话自己的 grant 必须有效')
      assert.equal((own as { via?: string }).via, 'grant', '走的是 grant 通道')

      const child = { sessionId: 'child', callId: 'c-child', tool: 't', capabilities: [capability] }
      assert.notEqual(a.decide(child).kind, 'allow', `${f.name}：子会话不得继承父会话的 grant`)
      assert.equal(typeof a.guard(child), 'string', '守卫必须拒绝，并返回理由串')
    })
  })
}

test('G5 空 sessionId 不匹配任何会话绑定 grant（「没有会话」≠「任何会话」）', () => {
  withScopedAuth(({ a }) => {
    a.issueGrant({ subject: 'model', capability: cap.execShell(), expiresAt: null, sessionId: 'parent' })
    const d = a.decide({ sessionId: '', callId: 'c-empty', tool: 'pwsh', capabilities: [cap.execShell()] })
    assert.notEqual(d.kind, 'allow', '空会话不能吃会话绑定的 grant')
  })
})

test('G6 不带 sessionId 的 grant 是全局授予（旧数据兼容）', () => {
  withScopedAuth(({ a }) => {
    a.issueGrant({ subject: 'model', capability: cap.execShell(), expiresAt: null })
    const d = a.decide({ sessionId: 'anyone', callId: 'c-global', tool: 'pwsh', capabilities: [cap.execShell()] })
    assert.equal(d.kind, 'allow', '全局授予对任意会话有效')
    assert.equal((d as { via?: string }).via, 'grant')
    const empty = a.decide({ sessionId: '', callId: 'c-global-2', tool: 'pwsh', capabilities: [cap.execShell()] })
    // 空会话是「解析失败」，不是「任何会话」：连全局授予也不放行（fail-closed）。
    // 旧库的无 session_id 授予仍对任何真实会话生效（上一条），只是不覆盖空串。
    assert.notEqual(empty.kind, 'allow', '空会话连全局授予也不放行')
  })
})

test('G7 allowed-always 落下的 grant 归属提问的会话，不是全局', () => {
  withScopedAuth(({ a, outside }) => {
    const target = join(outside, 'always.txt')
    const r = a.recordOwnerDecision({
      sessionId: 'parent', callId: 'c-always', tool: 'write',
      capabilities: [cap.fsWrite(target)], outcome: 'allowed-always',
    })
    assert.equal(r.grantIds.length, 1, 'fs.write 应生成一条授予')
    const g = a.activeGrants()[0]
    assert.equal(g.sessionId, 'parent', '授予必须归属提问的会话')

    const own = a.decide({ sessionId: 'parent', callId: 'c-own', tool: 'write', capabilities: [cap.fsWrite(target)] })
    assert.equal(own.kind, 'allow', '提问会话自己仍被覆盖')
    const child = a.decide({ sessionId: 'child', callId: 'c-child', tool: 'write', capabilities: [cap.fsWrite(target)] })
    assert.equal(child.kind, 'ask', '子会话不得继承「总是允许」')
  })
})

test('G8 老库迁移：缺 session_id 列时补列且不重置数据（幂等）', () => {
  const t = makeTmp('prts-grant-migrate-')
  const dbPath = t.db()
  try {
    // 用旧 schema（无 session_id）建库并塞一条 grant 投影行，模拟升级前的库
    const first = Authority.open(dbPath, { workspaceRoots: [t.dir], protectedRoots: [] })
    try {
      first.issueGrant({ subject: 'model', capability: cap.execShell(), expiresAt: null })
    } finally { first.close() }

    // 把列抹掉：重建一张同结构但无 session_id 的表并搬数据
    const raw = new DatabaseSync(dbPath)
    try {
      raw.exec(`CREATE TABLE audit_grants_old (
        grant_id TEXT PRIMARY KEY, subject TEXT NOT NULL, capability TEXT NOT NULL,
        expires_at INTEGER, issued_at INTEGER NOT NULL, revoked_at INTEGER, revoke_reason TEXT)`)
      raw.exec('INSERT INTO audit_grants_old SELECT grant_id, subject, capability, expires_at, issued_at, revoked_at, revoke_reason FROM audit_grants')
      raw.exec('DROP TABLE audit_grants')
      raw.exec('ALTER TABLE audit_grants_old RENAME TO audit_grants')
    } finally { raw.close() }

    // 再打开：迁移补列、旧行保留、按全局授予（sessionId=null）读取
    const second = Authority.open(dbPath, { workspaceRoots: [t.dir], protectedRoots: [] })
    try {
      const grants = second.activeGrants()
      assert.equal(grants.length, 1, '迁移不得丢行')
      assert.equal(grants[0].sessionId, null, '旧行按全局授予读回')
      assert.equal(second.decide({ sessionId: 's', callId: 'c', tool: 'pwsh', capabilities: [cap.execShell()] }).kind, 'allow')
    } finally { second.close() }

    // 第三次打开：迁移幂等，不报错
    const third = Authority.open(dbPath, { workspaceRoots: [t.dir], protectedRoots: [] })
    try {
      assert.equal(third.activeGrants().length, 1)
    } finally { third.close() }
  } finally { t.cleanup() }
})
