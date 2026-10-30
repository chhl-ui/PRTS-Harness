import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StopController } from '../../src/stop/index.ts'
import type { StopHooks } from '../../src/stop/index.ts'
import { Ledger } from '../../src/ledger/index.ts'
import { AuditLog } from '../../src/audit/index.ts'
import { makeTmp } from '../support/tmp.ts'
import { owner } from '../ledger/helpers.ts'

const hooks = (called: string[], fail = ''): StopHooks => ({
  stopSpeech: async () => { called.push('stopSpeech'); if (fail === 'stopSpeech') throw new Error('boom-s') },
  cancelAllTurns: async () => { called.push('cancelAllTurns'); if (fail === 'cancelAllTurns') throw new Error('boom-c') },
  killAllJobs: async () => { called.push('killAllJobs'); if (fail === 'killAllJobs') throw new Error('boom-k') },
})

test('S1: hook 调用 + 抛错不阻断后续 + 审计序列', async () => {
  const t = makeTmp('prts-stop-')
  const ledger = Ledger.open(t.db('core.sqlite'))
  const audit = AuditLog.open(t.db('core.sqlite'))
  try {
    const called: string[] = []
    const sc = new StopController({ hooks: hooks(called, 'cancelAllTurns'), ledger, audit })
    const r = await sc.stop('S1')
    assert.deepEqual(called, ['cancelAllTurns'])
    assert.equal(r.level, 'S1')
    assert.equal(r.failures.length, 1)
    assert.equal(r.failures[0].step, 'cancelAllTurns')
    const evs = audit.query({ kinds: ['stop.requested', 'stop.completed'] })
    assert.deepEqual(evs.map(e => e.event.kind), ['stop.requested', 'stop.completed'])

    const called2: string[] = []
    const s0 = await new StopController({ hooks: hooks(called2), ledger, audit }).stop('S0')
    assert.deepEqual(called2, ['stopSpeech'])
    assert.equal(s0.stoppedTasks.length, 0)
  } finally { t.cleanup(ledger, audit) }
})

test('S2: 非终态任务全转 stopped-by-owner，done/cancelled 不变；hook 失败不阻断', async () => {
  const t = makeTmp('prts-stop-')
  const ledger = Ledger.open(t.db('core.sqlite'))
  const audit = AuditLog.open(t.db('core.sqlite'))
  try {
    const mk = async (phase: 'active' | 'paused' | 'blocked' | 'done' | 'cancelled') => {
      const x = ledger.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
      ledger.activate(owner, { id: x.id, revision: 1 })
      if (phase === 'paused') ledger.pause(owner, { id: x.id, revision: ledger.get(x.id).revision })
      if (phase === 'blocked') ledger.block(owner, { id: x.id, revision: ledger.get(x.id).revision }, { code: 'x', message: 'm' })
      if (phase === 'done') {
        const v = ledger.claimDone(owner, { id: x.id, revision: ledger.get(x.id).revision })
        ledger.ownerAccept({ id: v.id, revision: v.revision })
      }
      if (phase === 'cancelled') ledger.cancel(owner, { id: x.id, revision: ledger.get(x.id).revision })
      return x.id
    }
    const ids = {
      active: await mk('active'), paused: await mk('paused'), blocked: await mk('blocked'),
      done: await mk('done'), cancelled: await mk('cancelled'),
    }
    const called: string[] = []
    const sc = new StopController({ hooks: hooks(called, 'killAllJobs'), ledger, audit })
    const r = await sc.stop('S2')
    assert.equal(ledger.get(ids.active).phase, 'stopped-by-owner')
    assert.equal(ledger.get(ids.paused).phase, 'stopped-by-owner')
    assert.equal(ledger.get(ids.blocked).phase, 'stopped-by-owner')
    assert.equal(ledger.get(ids.done).phase, 'done')
    assert.equal(ledger.get(ids.cancelled).phase, 'cancelled')
    assert.deepEqual(r.stoppedTasks.sort(), [ids.active, ids.paused, ids.blocked].map(String).sort())
    assert.ok(r.failures.some(f => f.step === 'killAllJobs'))
  } finally { t.cleanup(ledger, audit) }
})
