import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/ledger/index.ts'
import { openTmp, owner, model, expectCode } from './helpers.ts'

test('预算门禁：model 不能 unblock budget-exceeded / owner 阻塞；可以解自己 block', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' }, budget: { maxRounds: 1 } })
    l.activate(owner, { id: t.id, revision: t.revision })
    const b = l.chargeUsage(t.id, { rounds: 2 }) // active → blocked(by=system, budget-exceeded)
    assert.equal(b.phase, 'blocked')
    assert.equal(b.blockedReason?.code, 'budget-exceeded')

    // by='system' 的阻塞 model 不能解
    expectCode(() => l.unblock(model(), { id: t.id, revision: b.revision }), 'FORBIDDEN')
    // owner 可以解（owner 不受 BUDGET_EXCEEDED 门约束）
    const u = l.unblock(owner, { id: t.id, revision: b.revision })
    assert.equal(u.phase, 'active')

    // owner 造成的阻塞 model 不能解
    const b2 = l.block(owner, { id: t.id, revision: u.revision }, { code: 'hold', message: '等指示' })
    expectCode(() => l.unblock(model(), { id: t.id, revision: b2.revision }), 'FORBIDDEN')
    const u2 = l.unblock(owner, { id: t.id, revision: b2.revision })

    // model 自己 block 的可以自己 unblock——但此时 usage 已超预算 → BUDGET_EXCEEDED
    const b3 = l.block(model(), { id: t.id, revision: u2.revision }, { code: 'w', message: 'm' })
    expectCode(() => l.unblock(model(), { id: t.id, revision: b3.revision }), 'BUDGET_EXCEEDED')
    // owner setBudget 提高上限后 model 可解
    l.setBudget({ id: t.id, revision: b3.revision }, { maxRounds: 100 })
    const u3 = l.unblock(model(), { id: t.id, revision: l.get(t.id).revision })
    assert.equal(u3.phase, 'active')
  } finally { c.cleanup() }
})

test('paused 中超预算：chargeUsage 不改 phase；model resume → BUDGET_EXCEEDED；owner 提额后可 resume', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' }, budget: { maxRounds: 1 } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    const p = l.pause(owner, { id: t.id, revision: a.revision })
    const s = l.chargeUsage(t.id, { rounds: 5 }) // paused 不转 blocked，只累计
    assert.equal(s.phase, 'paused')
    assert.equal(s.usage.rounds, 5)

    expectCode(() => l.resume(model(), { id: t.id, revision: l.get(t.id).revision }), 'BUDGET_EXCEEDED')
    // owner resume 不受限
    const r = l.resume(owner, { id: t.id, revision: l.get(t.id).revision })
    assert.equal(r.phase, 'active')
    // active 下 model unblock 仍先过 BUDGET_EXCEEDED 需要 blocked 态，改为先 block 再验证
    const b = l.block(model(), { id: t.id, revision: r.revision }, { code: 'x', message: 'y' })
    expectCode(() => l.unblock(model(), { id: t.id, revision: b.revision }), 'BUDGET_EXCEEDED')
    l.setBudget({ id: t.id, revision: b.revision }, { maxRounds: 10 })
    const u = l.unblock(model(), { id: t.id, revision: l.get(t.id).revision })
    assert.equal(u.phase, 'active')
  } finally { c.cleanup() }
})

test('路径校验：check.path 与 artifactPath 必须绝对；sha256 必须 64 位小写 hex；未知 check kind 在 create 即拒', () => {
  const c = openTmp()
  try {
    const l = c.ledger
    const mk = (checks: unknown[]) => l.create(owner, {
      title: 'T', objective: 'O',
      acceptance: { kind: 'checks', checks: checks as never },
    })
    expectCode(() => mk([{ kind: 'file-exists', path: 'relative/out.txt' }]), 'INVALID_INPUT')
    expectCode(() => mk([{ kind: 'file-sha256', path: 'C:/x', sha256: 'ABC' }]), 'INVALID_INPUT')
    expectCode(() => mk([{ kind: 'file-sha256', path: 'C:/x', sha256: '0'.repeat(63) }]), 'INVALID_INPUT')
    expectCode(() => mk([{ kind: 'file-sha256', path: 'C:/x', sha256: 'A'.repeat(64) }]), 'INVALID_INPUT') // 大写不行
    expectCode(() => mk([{ kind: 'wat', path: 'C:/x' }]), 'INVALID_INPUT')

    const t = l.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = l.activate(owner, { id: t.id, revision: t.revision })
    expectCode(() => l.addEvidence(owner, { id: a.id, revision: a.revision }, { artifactPath: 'rel/e.bin', producedBy: 's/1' }), 'INVALID_INPUT')
    assert.equal(l.exportDoc().events.length, 2) // create+activate，无额外事件
  } finally { c.cleanup() }
})

test('多进程：两个 Ledger 实例交替写同一文件，链完整、seq 连续无重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prts-ledger-mp-'))
  const db = join(dir, 'ledger.sqlite')
  try {
    const l1 = Ledger.open(db)
    const l2 = Ledger.open(db)
    try {
      const t = l1.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
      l1.activate(owner, { id: t.id, revision: 1 })
      // l2 写同一任务：先 get 拿新 revision
      const fresh = l2.get(t.id)
      l2.note(model('s-2'), { id: t.id, revision: fresh.revision }, 'l2 note')
      // l1 在另一个任务上写
      const u = l1.create(owner, { title: 'U', objective: 'O', acceptance: { kind: 'owner-confirm' } })
      l1.activate(owner, { id: u.id, revision: 1 })
      // l2 再写同一任务
      const f2 = l2.get(t.id)
      l2.pause(owner, { id: t.id, revision: f2.revision })

      const c1 = l1.verifyChain()
      const c2 = l2.verifyChain()
      assert.equal(c1.ok, true)
      assert.equal(c2.ok, true)
      const seqs = l1.exportDoc().events.map(e => e.seq)
      assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b))
      assert.equal(new Set(seqs).size, seqs.length)
      assert.equal(seqs[seqs.length - 1], seqs.length) // 1..N 连续
      if (c1.ok && c2.ok) assert.equal(c1.events, c2.events)
      // 两个实例投影一致
      assert.deepEqual(l1.get(t.id), l2.get(t.id))
    } finally {
      l1.close()
      l2.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
