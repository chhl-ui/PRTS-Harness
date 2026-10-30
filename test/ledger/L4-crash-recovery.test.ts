import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Ledger } from '../../src/ledger/index.ts'
import { makeTmp } from '../support/tmp.ts'
import { owner, model, expectCode } from './helpers.ts'

const fixture = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))

test('L4: 进程被 SIGKILL 后重开——已完成步骤不重跑，进行中步骤 unknown', async () => {
  const t = makeTmp('prts-ledger-l4-')
  const dbPath = t.db('ledger.sqlite')
  let ledger: Ledger | undefined
  try {
    // 1) 子进程：建任务、完成步骤 1、开始步骤 2，打印 READY 后挂起
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, dbPath])
    await new Promise<void>((resolve, reject) => {
      let buf = ''
      child.stdout?.on('data', (chunk: Uint8Array) => {
        buf += String(chunk)
        if (buf.includes('READY')) {
          child.kill('SIGKILL')
        }
      })
      child.once('exit', () => resolve())
      child.on('error', reject)
    })

    // 2) 重开：recoverOnStartup 把 started → unknown
    ledger = Ledger.open(dbPath)
    const task = ledger.list()[0]
    const recovered = ledger.recoverOnStartup()
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].stepNo, 2)
    assert.equal(recovered[0].status, 'unknown')

    // 3) 已完成步骤不重跑
    const r1 = ledger.beginStep(owner, task.id, { stepNo: 1, name: 's1', idempotent: true })
    assert.equal(r1.kind, 'recorded')
    if (r1.kind === 'recorded') assert.equal(r1.step.status, 'succeeded')

    // 4) unknown 步骤交还调用方
    const r2 = ledger.beginStep(model(), task.id, { stepNo: 2, name: 's2', idempotent: false })
    assert.equal(r2.kind, 'unknown')

    // 5) 非幂等 unknown：model 不能重试，owner 可以
    expectCode(() => ledger!.retryUnknownStep(model(), task.id, 2), 'FORBIDDEN')
    ledger.retryUnknownStep(owner, task.id, 2)
    assert.equal(ledger.steps(task.id).find(s => s.stepNo === 2)?.status, 'started')
    ledger.endStep(owner, task.id, 2, { status: 'succeeded' })
    assert.equal(ledger.get(task.id).resume.lastCompletedStep, 2)

    // 6) 幂等 unknown：model 也可以重试（再制造一个 started 并再次恢复）
    ledger.beginStep(owner, task.id, { stepNo: 3, name: 's3', idempotent: true })
    const recovered2 = ledger.recoverOnStartup()
    assert.equal(recovered2.length, 1)
    assert.equal(recovered2[0].stepNo, 3)
    assert.equal(recovered2[0].status, 'unknown')
    ledger.retryUnknownStep(model(), task.id, 3) // idempotent → model 允许
    assert.equal(ledger.steps(task.id).find(s => s.stepNo === 3)?.status, 'started')
    ledger.endStep(model(), task.id, 3, { status: 'succeeded' })

    const chain = ledger.verifyChain()
    assert.equal(chain.ok, true)
  } finally {
    t.cleanup(...(ledger ? [ledger] : []))
  }
})
