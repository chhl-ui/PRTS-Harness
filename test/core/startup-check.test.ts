import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Ledger } from '../../src/ledger/index.ts'
import { AuditLog } from '../../src/audit/index.ts'
import { startupCheck } from '../../src/core/startup-check.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'

test('U1: 篡改 audit 行 → startupCheck 只读；两表行数不变；写方法 READ_ONLY', () => {
  const t = makeTmp('prts-core-')
  const l = Ledger.open(t.db())
  const a = AuditLog.open(t.db())
  const task = l.create({ kind: 'owner' }, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
  a.append({ kind: 'system', component: 'integrity' }, { kind: 'integrity.checked', ok: true, detail: 'd' })
  l.close(); a.close()

  const r0 = startupCheck(t.db())
  assert.equal(r0.mode, 'normal')
  assert.deepEqual(r0.problems, [])

  const raw = new DatabaseSync(t.db())
  let lr: Ledger | undefined
  let ar: AuditLog | undefined
  try {
    const n1 = (raw.prepare('SELECT COUNT(*) c FROM audit_events').get() as { c: number }).c
    const n2 = (raw.prepare('SELECT COUNT(*) c FROM ledger_events').get() as { c: number }).c
    raw.exec("UPDATE audit_events SET payload_json = '{\"x\":1}' WHERE seq = 1")

    const r1 = startupCheck(t.db())
    assert.equal(r1.mode, 'read-only')
    assert.equal(r1.audit.ok, false)
    if (r1.audit.ok === false && 'brokenAtSeq' in r1.audit) assert.equal(r1.audit.brokenAtSeq, 1)
    assert.equal(r1.ledger.ok, true)
    assert.ok(r1.problems.some(p => p.includes('audit_events')))

    // 只读打开 → 任何写都 READ_ONLY
    lr = Ledger.open(t.db(), { readOnly: true })
    ar = AuditLog.open(t.db(), { readOnly: true })
    try { lr.note({ kind: 'owner' }, { id: task.id, revision: 1 }, 'x'); assert.fail() } catch (e) { assert.equal((e as { code?: string }).code, 'READ_ONLY') }
    try { lr.recoverOnStartup(); assert.fail() } catch (e) { assert.equal((e as { code?: string }).code, 'READ_ONLY') }
    try { lr.rebuildProjections(); assert.fail() } catch (e) { assert.equal((e as { code?: string }).code, 'READ_ONLY') }
    try { ar.append({ kind: 'owner' }, { kind: 'integrity.checked', ok: true, detail: 'x' }); assert.fail() } catch (e) { assert.equal((e as { code?: string }).code, 'READ_ONLY') }
    try { ar.rebuildProjections(); assert.fail() } catch (e) { assert.equal((e as { code?: string }).code, 'READ_ONLY') }

    assert.equal((raw.prepare('SELECT COUNT(*) c FROM audit_events').get() as { c: number }).c, n1)
    assert.equal((raw.prepare('SELECT COUNT(*) c FROM ledger_events').get() as { c: number }).c, n2)

    // 篡改 ledger 行 → 同样只读
    raw.exec("UPDATE ledger_events SET payload_json = '{\"y\":1}' WHERE seq = 1")
    const r2 = startupCheck(t.db())
    assert.equal(r2.mode, 'read-only')
    assert.equal(r2.ledger.ok, false)
    assert.equal(r2.audit.ok, false)
    assert.ok(r2.problems.some(p => p.includes('ledger_events')))
  } finally {
    t.cleanup(raw, ...(lr ? [lr] : []), ...(ar ? [ar] : []))
  }
})

test('正常模式：同文件交替写入，startupCheck normal，两链各自 ok', () => {
  const t = makeTmp('prts-core-')
  const l = Ledger.open(t.db())
  const a = AuditLog.open(t.db())
  try {
    const task = l.create({ kind: 'owner' }, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    a.append({ kind: 'owner' }, { kind: 'grant.issued', grantId: 'g', subject: 's', capability: 'tool:x', expiresAt: null })
    l.activate({ kind: 'owner' }, { id: task.id, revision: 1 })
    a.append({ kind: 'system', component: 'stop' }, { kind: 'stop.requested', level: 'S1' })
    const r = startupCheck(t.db())
    assert.equal(r.mode, 'normal')
    assert.deepEqual(r.problems, [])
    assert.equal(r.ledger.ok, true); if (r.ledger.ok) assert.equal(r.ledger.events, 2)
    assert.equal(r.audit.ok, true); if (r.audit.ok) assert.equal(r.audit.events, 2)
  } finally { t.cleanup(l, a) }
})

test('缺表：只建 ledger 的库 → read-only + audit missing；initCoreDb 后 DROP audit_events → read-only', () => {
  const t = makeTmp('prts-core-')
  const l = Ledger.open(t.db()) // 只建 ledger 一套表
  let raw: DatabaseSync | undefined
  try {
    const r1 = startupCheck(t.db())
    assert.equal(r1.mode, 'read-only')
    assert.deepEqual(r1.audit, { ok: false, missing: true })
    assert.equal(r1.ledger.ok, true)
    assert.ok(r1.problems.some(p => p.includes('audit_events')))

    initCoreDb(t.db()) // 建齐 → normal
    const rOk = startupCheck(t.db())
    assert.equal(rOk.mode, 'normal')

    raw = new DatabaseSync(t.db())
    raw.exec('DROP TABLE audit_events')
    const r2 = startupCheck(t.db())
    assert.equal(r2.mode, 'read-only')
    assert.deepEqual(r2.audit, { ok: false, missing: true })
  } finally { t.cleanup(l, ...(raw ? [raw] : [])) }
})

test('initCoreDb：新库单事务建全表 → startupCheck normal、0/0；可重复调用幂等', () => {
  const t = makeTmp('prts-core-')
  try {
    initCoreDb(t.db())
    initCoreDb(t.db()) // 幂等
    const r = startupCheck(t.db())
    assert.equal(r.mode, 'normal')
    assert.deepEqual(r.problems, [])
    assert.equal(r.ledger.ok, true); if (r.ledger.ok) assert.equal(r.ledger.events, 0)
    assert.equal(r.audit.ok, true); if (r.audit.ok) assert.equal(r.audit.events, 0)
    // init 后两边都能写
    const l = Ledger.open(t.db())
    const a = AuditLog.open(t.db())
    try {
      l.create({ kind: 'owner' }, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
      a.append({ kind: 'owner' }, { kind: 'stop.requested', level: 'S0' })
    } finally {
      l.close(); a.close()
    }
    const r2 = startupCheck(t.db())
    assert.equal(r2.mode, 'normal')
  } finally { t.cleanup() }
})

test('startupCheck 对不存在文件：normal、events=0、不创建文件', () => {
  const t = makeTmp('prts-core-')
  try {
    const db = join(t.dir, 'nonexistent.sqlite')
    const r = startupCheck(db)
    assert.equal(r.mode, 'normal')
    assert.equal(r.ledger.ok, true)
    if (r.ledger.ok) assert.equal(r.ledger.events, 0)
    assert.equal(r.audit.ok, true)
    if (r.audit.ok) assert.equal(r.audit.events, 0)
    assert.equal(existsSync(db), false)
  } finally { t.cleanup() }
})

test('K1 兼容：827091b 导出文档在重构后可导入并校验通过', () => {
  const t = makeTmp('prts-core-')
  let l: Ledger | undefined
  try {
    const doc = JSON.parse(readFileSync(new URL('../audit/fixtures/k1-export-827091b.json', import.meta.url), 'utf8'))
    l = Ledger.importDoc(t.db('k1.sqlite'), doc)
    const chain = l.verifyChain()
    assert.equal(chain.ok, true)
    if (chain.ok) assert.equal(chain.events, doc.events.length)
    assert.equal(l.list().length, 1)
    assert.equal(l.list()[0].usage.rounds, 2)
  } finally { t.cleanup(...(l ? [l] : [])) }
})
