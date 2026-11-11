/**
 * 自主回合的工具面（CL5—CL6）：白名单在**真实运行时**里生效，不是只存在于常量。
 *
 * CL5 证明「允许的工具真的能用」：让模型在自主回合里调 `prts_intent_create`，
 * 断言 `mem_intents` 真的多出一条——工具执行成功才会写库，光有常量不算。
 * CL6 证明「被禁的工具真的看不见」：让模型调 `pwsh` 写文件，断言文件不存在。
 *
 * 反证方式：把 `clock-tools.ts` 的白名单改成空数组 → CL5 红（工具不可用）；
 * 把 `start.ts` 的 setup/restrict 摘掉 → CL6 红（pwsh 真的执行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

const ENV_KEYS = [
  'PRTS_CLOCK',
  'PRTS_CLOCK_TOOLS',
  'PRTS_CLOCK_STALE_HOURS',
  'PRTS_CLOCK_INTERVAL_MS',
  'PRTS_CLOCK_MIN_GAP_MS',
  'PRTS_CLOCK_DAILY_CAP',
  'PRTS_CLOCK_FACT_MIN_IMPORTANCE',
  'PRTS_CLOCK_FACT_IDLE_DAYS',
  'PRTS_MISS_AFTER_HOURS',
] as const

function saveEnv(): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  return saved
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = saved.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

/** 起一个 runtime + 造一个停滞任务，返回 app 与任务 id（CL5/CL6 的共同脚手架）。 */
async function rig(script: Parameters<typeof scriptedLlmPlugin>[0]) {
  const tmp = makeTmp('prts-clock-tools-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  process.env.PRTS_CLOCK = 'on'
  process.env.PRTS_CLOCK_STALE_HOURS = '0.0001'
  process.env.PRTS_CLOCK_INTERVAL_MS = '3600000'
  process.env.PRTS_CLOCK_MIN_GAP_MS = '0'
  process.env.PRTS_CLOCK_DAILY_CAP = '5'

  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  scriptedLlmPlugin(script).apply(app.ctx as Context)
  await new Promise((r) => setTimeout(r, 100))

  const owner = { kind: 'owner' } as const
  const created = app.ledger.create(owner, {
    title: '被阻塞的验收',
    objective: '验证自主回合的工具面',
    acceptance: { kind: 'owner-confirm' },
  })
  const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
  app.ledger.block(owner, { id: created.id, revision: active.revision }, { code: 'hold', message: '等博士' })
  await new Promise((r) => setTimeout(r, 500))

  return { tmp, dataRoot, ws, app, taskId: created.id }
}

test('CL5 白名单里的工具真的能用：自主回合调 prts_intent_create → mem_intents 落库', async () => {
  const saved = saveEnv()
  const fireAt = new Date(Date.now() + 3_600_000).toISOString()
  let ctx: Awaited<ReturnType<typeof rig>> | undefined
  try {
    ctx = await rig([
      {
        toolCalls: [{
          name: 'prts_intent_create',
          arguments: {
            action: '提醒博士处理被阻塞的验收',
            fire_at_iso: fireAt,
            condition_raw: '时钟自主记下',
          },
        }],
      },
      { text: '我记下了，一小时后再提醒博士。' },
    ])
    const clock = ctx.app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')

    const fired = await clock.tick()
    assert.equal(fired.length, 1, '应当投递一条停滞任务提醒')

    // 硬证据：工具真的执行了才会写库。工具不可见时这里会是 0 条。
    const db = new DatabaseSync(join(ctx.dataRoot, 'memory.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare(
        "SELECT action FROM mem_intents WHERE action LIKE '%被阻塞的验收%'",
      ).all() as Array<{ action: string }>
      assert.equal(rows.length, 1, 'prts_intent_create 必须真的落库一条提醒')
    } finally {
      db.close()
    }
  } finally {
    await ctx?.app.dispose()
    restoreEnv(saved)
    ctx?.tmp.cleanup()
  }
})

test('CL6 白名单外的工具不可见：自主回合调 pwsh → 文件不产生', async () => {
  const saved = saveEnv()
  let ctx: Awaited<ReturnType<typeof rig>> | undefined
  try {
    ctx = await rig([
      {
        toolCalls: [{
          name: 'pwsh',
          arguments: { command: 'echo leak > leak.txt' },
        }],
      },
      { text: '收到。' },
    ])
    const clock = ctx.app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')

    // tick 的结果不作断言：工具不可见时 DSH 可能把「unknown tool」当工具结果继续，
    // 也可能让整个回合失败。两种都算 fail-closed——关键是副作用没有发生。
    await clock.tick()

    const leaked = join(ctx.ws, 'leak.txt')
    assert.equal(existsSync(leaked), false, 'pwsh 不得在自主回合里执行——文件不该被创建')
    // 兜底：会话 cwd 可能是 ws 之外，扫 dataRoot 一起确认。
    assert.equal(existsSync(join(ctx.dataRoot, 'leak.txt')), false, 'dataRoot 下也不该有产物')
  } finally {
    await ctx?.app.dispose()
    restoreEnv(saved)
    ctx?.tmp.cleanup()
  }
})
