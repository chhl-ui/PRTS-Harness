import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Authority, cap, classify, isWithin, normalizePath, realpathBestEffort } from '../../src/authority/index.ts'
import { AuditLog } from '../../src/audit/index.ts'
import { makeTmp } from '../support/tmp.ts'

const AUTH_CFG = (ws: string[], prot: string[]) => ({ workspaceRoots: ws, protectedRoots: prot })

function openAuth(db: string, cfg: { workspaceRoots: string[]; protectedRoots: string[] }, now?: () => number) {
  return Authority.open(db, cfg, now ? { now } : undefined)
}

const call = (over: Partial<{ sessionId: string; callId: string; tool: string; capabilities: string[] }>) => ({
  sessionId: 's1', callId: 'c1', tool: 'pwsh', capabilities: ['exec:shell'], ...over,
})

test('A1: exec:shell 授予 allow(grant)；另一实例撤销后 decide→ask、guard 拒绝并记 tool.denied', () => {
  const t = makeTmp('prts-auth-')
  const a1 = openAuth(t.db(), AUTH_CFG([t.dir], []))
  const a2 = openAuth(t.db(), AUTH_CFG([t.dir], [])) // 另一进程视角
  try {
    const gid = a1.issueGrant({ subject: 'model', capability: cap.execShell(), expiresAt: null })
    let d = a2.decide(call({}))
    assert.equal(d.kind, 'allow')
    if (d.kind === 'allow') { assert.equal(d.via, 'grant'); assert.equal(d.grantId, gid) }

    a1.revokeGrant(gid, '撤销测试')
    d = a2.decide(call({}))
    assert.equal(d.kind, 'ask')

    const reason = a2.guard(call({}))
    assert.equal(typeof reason, 'string')
    const log = AuditLog.open(t.db())
    try {
      const evs = log.query({ kinds: ['tool.denied'] })
      assert.equal(evs.length, 1)
      assert.equal((evs[0].event as { reason: string }).reason, (d as { reason: string }).reason)
    } finally { log.close() }
  } finally { t.cleanup(a1, a2) }
})

test('A2: protectedRoots 内写入，授予+一次性批准都不能放行', () => {
  const t = makeTmp('prts-auth-')
  const prot = join(t.dir, 'protected')
  mkdirSync(prot)
  const target = join(prot, 'x.txt')
  const a = openAuth(t.db(), AUTH_CFG([t.dir], [prot]))
  try {
    const c = call({ capabilities: [cap.fsWrite(target)] })
    // 授予整个 protectedRoot 也不行
    a.issueGrant({ subject: 'model', capability: cap.fsWrite(prot), expiresAt: null })
    // 一次性批准也不行
    a.recordOwnerDecision({ sessionId: 's1', callId: 'c1', tool: 'write', capabilities: [cap.fsWrite(target)], outcome: 'allowed-once' })
    const d = a.decide(c)
    assert.equal(d.kind, 'deny')
    assert.equal(a.guard(c), (d as { reason: string }).reason)
    // protectedRoot 本身写入也 deny
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(prot)] })).kind, 'deny')
  } finally { t.cleanup(a) }
})

test('A3: 一次性批准只生效一次；callId 不同或能力不覆盖 → ask', () => {
  const t = makeTmp('prts-auth-')
  const a = openAuth(t.db(), AUTH_CFG([], []))
  try {
    const caps = [cap.execShell()]
    assert.equal(a.decide(call({ capabilities: caps })).kind, 'ask')
    a.recordOwnerDecision({ sessionId: 's1', callId: 'c1', tool: 'pwsh', capabilities: caps, outcome: 'allowed-once' })
    assert.equal(a.decide(call({ capabilities: caps })).kind, 'allow')
    assert.equal(a.guard(call({ capabilities: caps })), undefined) // 消费
    assert.equal(a.decide(call({ capabilities: caps })).kind, 'ask') // 第二次 → ask

    // 不同 callId → ask（c2 无 once 记录）
    assert.equal(a.decide(call({ callId: 'c2', capabilities: caps })).kind, 'ask')
    // 部分覆盖 → ask
    a.recordOwnerDecision({ sessionId: 's1', callId: 'c3', tool: 'pwsh', capabilities: caps, outcome: 'allowed-once' })
    const mixed = [cap.execShell(), cap.net('example.com')]
    assert.equal(a.decide(call({ callId: 'c3', capabilities: mixed })).kind, 'ask')
  } finally { t.cleanup(a) }
})

test('A4: allowed-always 对 fs.delete 不生授予；fs.write 授予范围为父目录', () => {
  const t = makeTmp('prts-auth-')
  const dir = join(t.dir, 'x')
  mkdirSync(dir)
  const a = openAuth(t.db(), AUTH_CFG([], []))
  try {
    const r = a.recordOwnerDecision({
      sessionId: 's1', callId: 'c1', tool: 'x',
      capabilities: [cap.fsDelete(join(dir, 'y.txt')), cap.fsWrite(join(dir, 'y.txt'))],
      outcome: 'allowed-always',
    })
    assert.equal(r.grantIds.length, 1) // 只有 fs.write 生授予
    const grants = a.activeGrants()
    assert.equal(grants.length, 1)
    assert.equal(grants[0].capability, cap.fsWrite(dir))

    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(join(dir, 'z.txt'))] })).kind, 'allow')
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(join(t.dir, 'xy', 'a.txt'))] })).kind, 'ask')
    // fs.delete 仍 ask
    assert.equal(a.decide(call({ capabilities: [cap.fsDelete(join(dir, 'z.txt'))] })).kind, 'ask')
  } finally { t.cleanup(a) }
})

test('路径：normalizePath / isWithin / realpathBestEffort / junction 逃逸', () => {
  const t = makeTmp('prts-auth-')
  try {
    // .. 穿越归一
    assert.ok(!isWithin(join(t.dir, 'work', '..', 'secret'), join(t.dir, 'work')))
    // 相似前缀不属于
    assert.equal(isWithin('C:\\workspace', 'C:\\work'), false)
    assert.equal(isWithin('C:\\work\\a', 'C:\\work'), true)
    assert.equal(isWithin('C:\\work', 'C:\\work'), true)
    // 末尾分隔符
    assert.equal(isWithin('C:\\work\\', 'C:\\work'), true)
    // 盘符根目录包含一切
    assert.equal(isWithin('C:\\work', 'C:\\'), true)
    // 相对路径被拒
    assert.throws(() => normalizePath('rel/path.txt'), (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT')
    // 大小写差异（Windows）
    if (process.platform === 'win32') {
      assert.equal(isWithin('c:\\WORK\\a', 'C:\\work'), true)
    }
    // realpathBestEffort 对不存在路径拼回
    const real = realpathBestEffort(join(t.dir, 'sub', 'deep', 'f.txt'))
    assert.ok(real.toLowerCase().includes('deep'))

    // junction 逃逸：link → protectedRoot，经 link 写 = deny
    const prot = join(t.dir, 'prot')
    const link = join(t.dir, 'link')
    mkdirSync(prot)
    symlinkSync(prot, link, process.platform === 'win32' ? 'junction' : 'dir')
    const a = openAuth(t.db('a.sqlite'), AUTH_CFG([t.dir], [prot]))
    try {
      const via = cap.fsWrite(join(link, 'evil.txt'))
      const d = a.decide(call({ capabilities: [via] }))
      assert.equal(d.kind, 'deny', 'junction 逃逸未被拦截')
    } finally { a.close() }
  } finally { t.cleanup() }
})

test('过期：now 注入，到期前 allow，到期后 ask', () => {
  const t = makeTmp('prts-auth-')
  let now = 1000
  const a = openAuth(t.db(), AUTH_CFG([], []), () => now)
  try {
    a.issueGrant({ subject: 'model', capability: cap.execShell(), expiresAt: 2000 })
    assert.equal(a.decide(call({})).kind, 'allow')
    now = 2000 // now >= expiresAt → 无效
    assert.equal(a.decide(call({})).kind, 'ask')
    now = 3000
    assert.equal(a.decide(call({})).kind, 'ask')
    assert.equal(a.activeGrants().length, 0)
  } finally { t.cleanup(a) }
})

test('混合能力：allow+ask→ask；ask+deny→deny；空能力→allow(policy)', () => {
  const t = makeTmp('prts-auth-')
  const prot = join(t.dir, 'prot')
  mkdirSync(prot)
  const a = openAuth(t.db(), AUTH_CFG([t.dir], [prot]))
  try {
    const mixed1 = [cap.fsRead(join(t.dir, 'f')), cap.execShell()]
    assert.equal(a.decide(call({ capabilities: mixed1 })).kind, 'ask')
    const mixed2 = [cap.execShell(), cap.fsWrite(join(prot, 'x'))]
    assert.equal(a.decide(call({ capabilities: mixed2 })).kind, 'deny')
    assert.equal(a.decide(call({ capabilities: [] })).kind, 'allow')
  } finally { t.cleanup(a) }
})

test('classify：已知工具、未知工具、非法参数', () => {
  const tmp = process.env.TEMP ?? '/tmp'
  assert.deepEqual(classify('read', { file_path: join(tmp, 'f.txt') }), [cap.fsRead(normalizePath(join(tmp, 'f.txt')))])
  assert.deepEqual(classify('read_image', { file_path: join(tmp, 'f.png') }), [cap.fsRead(normalizePath(join(tmp, 'f.png')))])
  assert.deepEqual(classify('write', { file_path: join(tmp, 'f.txt') }), [cap.fsWrite(normalizePath(join(tmp, 'f.txt')))])
  assert.deepEqual(classify('edit', { file_path: join(tmp, 'f.txt') }), [cap.fsWrite(normalizePath(join(tmp, 'f.txt')))])
  assert.deepEqual(classify('pwsh', { command: 'Get-Date' }), [cap.execShell()])
  assert.deepEqual(classify('working_directory', { cd: 'C:/' }), [])
  assert.deepEqual(classify('some_other_tool', {}), [cap.tool('some_other_tool')])
  assert.throws(() => classify('read', { file_path: 'rel/x' }), (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT')
  assert.throws(() => classify('read', {}), (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT')
  assert.throws(() => classify('pwsh', { command: '  ' }), (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT')
})

test('K4 新投影：grants/once 重建与导出导入一致；转移错误码', () => {
  const t = makeTmp('prts-auth-')
  const log = AuditLog.open(t.db())
  const a = openAuth(t.db(), AUTH_CFG([t.dir], []))
  try {
    const gid = a.issueGrant({ subject: 'model', capability: cap.net('example.com'), expiresAt: null })
    a.revokeGrant(gid, 'done')
    const err = (fn: () => unknown): string | undefined => {
      try { fn() } catch (e) { return (e as { code?: string }).code }
      assert.fail('expected throw')
    }
    // 重复授予 → INVALID_TRANSITION
    assert.equal(err(() => log.append({ kind: 'owner' }, {
      kind: 'grant.issued', grantId: gid, subject: 'model', capability: 'net:x', expiresAt: null,
    })), 'INVALID_TRANSITION')
    // 撤销不存在 → NOT_FOUND
    assert.equal(err(() => a.revokeGrant('grant-nope', 'r')), 'NOT_FOUND')
    // 重复撤销 → INVALID_TRANSITION
    assert.equal(err(() => a.revokeGrant(gid, 'r2')), 'INVALID_TRANSITION')
    // 一次性批准重复 / 消费错误
    a.recordOwnerDecision({ sessionId: 's', callId: 'k1', tool: 't', capabilities: [cap.execShell()], outcome: 'allowed-once' })
    assert.equal(err(() => a.recordOwnerDecision({ sessionId: 's', callId: 'k1', tool: 't', capabilities: [cap.execShell()], outcome: 'allowed-once' })), 'INVALID_TRANSITION')
    assert.equal(err(() => log.append({ kind: 'system', component: 'authority' }, { kind: 'approval.consumed', callId: 'nope' })), 'NOT_FOUND')
    log.append({ kind: 'system', component: 'authority' }, { kind: 'approval.consumed', callId: 'k1' })
    assert.equal(err(() => log.append({ kind: 'system', component: 'authority' }, { kind: 'approval.consumed', callId: 'k1' })), 'INVALID_TRANSITION')

    const want = { grants: log.listGrants(), once: log.getOnce('k1') }
    log.rebuildProjections()
    assert.deepEqual(log.listGrants(), want.grants)
    assert.deepEqual(log.getOnce('k1'), want.once)

    // 导出 → 导入一致
    const doc = log.exportDoc()
    const t2 = makeTmp('prts-auth-imp-')
    const log2 = AuditLog.importDoc(t2.db('a.sqlite'), doc)
    try {
      assert.deepEqual(log2.listGrants(), want.grants)
      assert.deepEqual(log2.getOnce('k1'), want.once)
    } finally { t2.cleanup(log2) }
  } finally { t.cleanup(log, a) }
})

test('consumeOnce 原子竞争：两实例同 callId，A 放行后 B 拒绝且仅一条 consumed', () => {
  const t = makeTmp('prts-auth-')
  const a = openAuth(t.db(), AUTH_CFG([], []))
  const b = openAuth(t.db(), AUTH_CFG([], []))
  try {
    const caps = [cap.execShell()]
    a.recordOwnerDecision({ sessionId: 's1', callId: 'cc', tool: 'pwsh', capabilities: caps, outcome: 'allowed-once' })
    const c = call({ callId: 'cc', capabilities: caps })
    assert.equal(a.guard(c), undefined) // A 消费
    const r = b.guard(c)
    assert.equal(typeof r, 'string') // B 被拒绝（decide 已见 consumed → ask 理由）
    const log = AuditLog.open(t.db())
    try {
      assert.equal(log.query({ kinds: ['approval.consumed'] }).length, 1)
      assert.ok(log.query({ kinds: ['tool.denied'] }).length >= 1)
    } finally { log.close() }
    // decide→consume 竞态窗口：decide 已取 allow(once)、消费被抢 → 固定理由串
    a.recordOwnerDecision({ sessionId: 's1', callId: 'dd', tool: 'pwsh', capabilities: caps, outcome: 'allowed-once' })
    const audit = (b as unknown as { audit: { consumeOnce(a: unknown, id: string): boolean } }).audit
    const orig = audit.consumeOnce.bind(audit)
    audit.consumeOnce = () => false // 模拟竞态抢输
    try {
      assert.equal(b.guard(call({ callId: 'dd', capabilities: caps })), 'one-time approval already consumed')
    } finally {
      audit.consumeOnce = orig
    }
  } finally { t.cleanup(a, b) }
})

test('guard 绝不抛：连接已关闭也返回字符串', () => {
  const t = makeTmp('prts-auth-')
  const a = openAuth(t.db(), AUTH_CFG([t.dir], []))
  try {
    a.close() // 底层连接先关 → decide/append 全抛
    const r = a.guard(call({ capabilities: [cap.execShell()] }))
    assert.equal(typeof r, 'string')
    assert.ok(r!.length > 0)
  } finally { t.cleanup(a) }
})

test('Windows 路径别名：尾点/尾空格/\\?\\ 前缀/ADS/8.3 短名', () => {
  if (process.platform !== 'win32') return
  const t = makeTmp('prts-auth-')
  const prot = join(t.dir, 'prot')
  mkdirSync(prot)
  const a = openAuth(t.db(), AUTH_CFG([t.dir], [prot]))
  try {
    // 尾点与尾空格段是同一目录的别名
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(prot + '.\\a')] })).kind, 'deny')
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(prot + ' \\a')] })).kind, 'deny')
    // \\?\ 前缀别名
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite('\\\\?\\' + prot + '\\a')] })).kind, 'deny')
    // ADS
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(join(prot, 'f.txt') + ':stream')] })).kind, 'deny')
    // 8.3 短名：t.dir 本身是 ADMINI~1 短名形式；长名路径写入同一工作区仍须 allow
    const longProt = realpathBestEffort(prot)
    const longWs = realpathBestEffort(t.dir)
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(join(longWs, 'ok.txt'))] })).kind, 'allow')
    assert.equal(a.decide(call({ capabilities: [cap.fsWrite(join(longProt, 'no.txt'))] })).kind, 'deny')
    // 短名访问已存在目录与长名一致
    assert.equal(
      a.decide(call({ capabilities: [cap.fsWrite(join(prot, 'x.txt'))] })).kind,
      a.decide(call({ capabilities: [cap.fsWrite(join(longProt, 'x.txt'))] })).kind,
    )
  } finally { t.cleanup(a) }
})

test('recordOwnerDecision 输入校验：非法输入全拒且不写入', () => {
  const t = makeTmp('prts-auth-')
  const a = openAuth(t.db(), AUTH_CFG([], []))
  const log = AuditLog.open(t.db())
  try {
    const before = log.exportDoc().events.length
    const bad = [
      () => a.recordOwnerDecision({ sessionId: '', callId: 'c', tool: 't', capabilities: [], outcome: 'denied' }),
      () => a.recordOwnerDecision({ sessionId: 's', callId: '', tool: 't', capabilities: [], outcome: 'denied' }),
      () => a.recordOwnerDecision({ sessionId: 's', callId: 'c', tool: '', capabilities: [], outcome: 'denied' }),
      () => a.recordOwnerDecision({ sessionId: 's', callId: 'c', tool: 't', capabilities: ['bad-cap'], outcome: 'denied' }),
      () => a.recordOwnerDecision({ sessionId: 's', callId: 'c', tool: 't', capabilities: [42 as never], outcome: 'denied' }),
      () => a.recordOwnerDecision({ sessionId: 's', callId: 'c', tool: 't', capabilities: ['bogus:x', 'also-bad'], outcome: 'allowed-once' }),
    ]
    for (const fn of bad) {
      assert.throws(fn, (e: unknown) => (e as { code?: string }).code === 'INVALID_INPUT')
    }
    assert.equal(log.exportDoc().events.length, before)
  } finally { t.cleanup(a, log) }
})

test('decide 不写：多次调用审计事件数不变', () => {
  const t = makeTmp('prts-auth-')
  const a = openAuth(t.db(), AUTH_CFG([t.dir], []))
  try {
    const log = AuditLog.open(t.db())
    try {
      const before = log.exportDoc().events.length
      for (let i = 0; i < 5; i++) a.decide(call({ capabilities: [cap.execShell(), cap.fsDelete(join(t.dir, 'x'))] }))
      assert.equal(log.exportDoc().events.length, before)
    } finally { log.close() }
  } finally { t.cleanup(a) }
})
