import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/ledger/index.ts'
import { openTmp, owner, model } from './helpers.ts'

test('链篡改：直接 UPDATE 事件 payload 后 verifyChain 报断点', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-ledger-tamper-'))
  const dbPath = join(dir, 'ledger.sqlite')
  try {
    const l = Ledger.open(dbPath)
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l.activate(owner, { id: t.id, revision: t.revision })
    l.note(model(), { id: t.id, revision: 2 }, 'n1')
    l.note(model(), { id: t.id, revision: 3 }, 'n2')
    const before = l.verifyChain()
    assert.equal(before.ok, true)

    const raw = new DatabaseSync(dbPath)
    raw.exec("UPDATE ledger_events SET payload_json = '{\"evil\":1}' WHERE seq = 3")
    raw.close()

    const after = l.verifyChain()
    assert.equal(after.ok, false)
    if (!after.ok) assert.equal(after.brokenAtSeq, 3)
    l.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuildProjections：与增量投影逐字段相同', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const artifact = join(c.dir, 'e.txt')
    writeFileSync(artifact, 'data')
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' }, budget: { maxRounds: 5 } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    l.beginStep(owner, t.id, { stepNo: 1, name: 's1', idempotent: true })
    l.endStep(owner, t.id, 1, { status: 'succeeded' })
    l.beginStep(model(), t.id, { stepNo: 2, name: 's2', idempotent: true })
    l.endStep(model(), t.id, 2, { status: 'failed', outputRef: 'err-9' })
    l.note(model(), { id: a.id, revision: l.get(t.id).revision }, 'memo')
    l.setResume(model(), { id: t.id, revision: l.get(t.id).revision }, { next: 'n', open: ['x', 'y'] })
    l.addEvidence(owner, { id: t.id, revision: l.get(t.id).revision }, { artifactPath: artifact, producedBy: 'sess-1/3' })
    l.chargeUsage(t.id, { rounds: 2, ms: 100 })
    l.pause(owner, { id: t.id, revision: l.get(t.id).revision })
    l.resume(owner, { id: t.id, revision: l.get(t.id).revision })
    l.block(model(), { id: t.id, revision: l.get(t.id).revision }, { code: 'need-input', message: '缺参数' })
    l.unblock(owner, { id: t.id, revision: l.get(t.id).revision })

    const want = {
      tasks: l.list(),
      steps: l.steps(t.id),
      evidence: l.evidence(t.id),
      chain: l.verifyChain(),
    }
    l.rebuildProjections()
    const got = {
      tasks: l.list(),
      steps: l.steps(t.id),
      evidence: l.evidence(t.id),
      chain: l.verifyChain(),
    }
    assert.deepEqual(got, want)
  } finally {
    c.cleanup()
  }
})

test('事务回滚：addEvidence 文件缺失不产生事件', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    const before = l.exportDoc().events.length
    const e = (() => { try { l.addEvidence(owner, { id: a.id, revision: a.revision }, { artifactPath: join(c.dir, 'nope.bin'), producedBy: 's/1' }) } catch (x) { return x as { code?: string } } assert.fail('no throw') })()
    assert.equal(e.code, 'EVIDENCE_MISSING')
    assert.equal(l.exportDoc().events.length, before)
    assert.equal(l.evidence(t.id).length, 0)
  } finally {
    c.cleanup()
  }
})
