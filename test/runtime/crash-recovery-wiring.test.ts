/**
 * 崩溃恢复接线：进程被杀留下的 `started` step，必须在下次启动时收口。
 *
 * ## 为什么要这条测试
 *
 * `recoverOnStartup()` 之前**只在测试里被调用**（`grep -rn "recoverOnStartup" src`
 * 除定义外零调用点）。真实中断后的表现（2026-11-09 实测）：
 * 任务停在 `active`、step 1 停在 `started`、重启后仍然 `started`——
 * 「正在执行的步骤」与「进程已死的步骤」在账本里无法区分。
 *
 * ## 断言的是什么
 *
 * 起一次真实 `startRuntime`（同一 dataRoot），启动流程应把 `started` → `unknown`。
 * 这条测试测的是**接线**：把 `start.ts` 里那行调用删掉，它会转红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { Ledger } from '../../src/ledger/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const OWNER = { kind: 'owner' as const }

test('CR1 启动时把中断的 started step 收口为 unknown', async () => {
  const t = makeTmp('prts-crash-recovery-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  try {
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(ws, { recursive: true })
    const dbPath = join(dataRoot, 'core.sqlite')

    // 造出「进程在执行工具中途被杀」的现场：active 任务 + 一个 started step。
    initCoreDb(dbPath)
    const seed = Ledger.open(dbPath)
    let taskId: string
    try {
      const created = seed.create(OWNER, {
        title: '中断恢复接线测试',
        objective: '造一个 started step 然后关库',
        acceptance: { kind: 'owner-confirm' },
      })
      const active = seed.activate(OWNER, { id: created.id, revision: created.revision })
      taskId = active.id
      seed.beginStep(OWNER, active.id, { stepNo: 1, name: 'pwsh', idempotent: false })
    } finally { seed.close() }

    // 起真实运行时：启动流程应把孤儿 step 收口。
    const app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    try {
      const steps = app.ledger.steps(taskId as never)
      assert.equal(steps.length, 1)
      assert.equal(steps[0]?.status, 'unknown', `中断的步骤应收口为 unknown，实际 ${steps[0]?.status}`)
      assert.equal(app.ledger.get(taskId as never)?.phase, 'active', '恢复步骤不改任务相位——任务仍等着被推进')
    } finally { await app.dispose() }
  } finally { t.cleanup() }
})
