import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/ledger/index.ts'
import { openTmp, owner, model, expectCode } from './helpers.ts'

test('L5: 导出→导入空白库，投影逐项一致；篡改 payload → CHAIN_BROKEN 且不落行', async () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const artifact = join(c.dir, 'a.bin')
    writeFileSync(artifact, 'abc')
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' }, budget: { maxRounds: 10 } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    l.note(model(), { id: a.id, revision: a.revision }, '进展中')
    const n = l.get(t.id)
    l.setResume(model(), { id: n.id, revision: n.revision }, { next: '写第二节', open: ['等评审'] })
    l.beginStep(owner, t.id, { stepNo: 1, name: 's1', idempotent: true, toolCallRef: 'sess-1/7' })
    l.endStep(owner, t.id, 1, { status: 'succeeded', outputRef: 'o1' })
    l.beginStep(owner, t.id, { stepNo: 2, name: 's2', idempotent: false })
    const v = l.claimDone(model(), { id: t.id, revision: l.get(t.id).revision })
    const rej = l.ownerReject({ id: v.id, revision: v.revision }, '还差一节')
    l.addEvidence(owner, { id: rej.id, revision: rej.revision }, { artifactPath: artifact, producedBy: 'sess-1/12' })
    l.chargeUsage(t.id, { rounds: 3, costUsd: 0.5 })

    const want = {
      tasks: l.list(),
      steps: l.steps(t.id),
      evidence: l.evidence(t.id),
      events: l.exportDoc().events,
    }
    const doc = l.exportDoc()

    // 正常导入
    const dir2 = mkdtempSync(join(tmpdir(), 'prts-ledger-imp-'))
    const db2 = join(dir2, 'ledger.sqlite')
    try {
      const l2 = Ledger.importDoc(db2, doc)
      assert.deepEqual(l2.list(), want.tasks)
      assert.deepEqual(l2.steps(t.id), want.steps)
      assert.deepEqual(l2.evidence(t.id), want.evidence)
      const chain = l2.verifyChain()
      assert.equal(chain.ok, true)
      if (chain.ok) assert.equal(chain.events, want.events.length)
      l2.close()
    } finally {
      rmSync(dir2, { recursive: true, force: true })
    }

    // 篡改事件 payload → CHAIN_BROKEN，目标库无行
    const bad = JSON.parse(JSON.stringify(doc))
    bad.events[3].payload = { tampered: true }
    const dir3 = mkdtempSync(join(tmpdir(), 'prts-ledger-imp2-'))
    const db3 = join(dir3, 'ledger.sqlite')
    try {
      expectCode(() => Ledger.importDoc(db3, bad), 'CHAIN_BROKEN')
      const l3 = Ledger.open(db3)
      assert.equal(l3.exportDoc().events.length, 0)
      l3.close()
    } finally {
      rmSync(dir3, { recursive: true, force: true })
    }

    // 非空目标库拒绝
    expectCode(() => Ledger.importDoc(c.ledger ? join(c.dir, 'ledger.sqlite') : db3, doc), 'INVALID_INPUT')
  } finally {
    c.cleanup()
  }
})
