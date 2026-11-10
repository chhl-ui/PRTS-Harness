/**
 * §G2 ① 时钟 —— 真实投递验收（方案 B：离屏自主）。
 *
 * `wake-clock.test.ts` 证明调度策略（注入 fake deliver）；本文件证明**真起了一个回合**：
 * 时钟自己 `agents.create` → `followup` → `whenIdle` → `dispose`，模型真的被调用，
 * 结果真的进 K4 审计链。两层假度不同，不能互相替代——「消息进了队列」不等于
 * 「模型被唤醒」（`inbox.append` 就是这样：入队不唤醒）。
 *
 * 时钟在测试上下文默认关闭（`start.ts` 的 `NODE_TEST_CONTEXT` 判定），
 * 本文件用 `PRTS_CLOCK=on` 显式打开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
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
  'PRTS_CLOCK_STALE_HOURS',
  'PRTS_CLOCK_INTERVAL_MS',
  'PRTS_CLOCK_MIN_GAP_MS',
  'PRTS_CLOCK_DAILY_CAP',
] as const

test('CL1 时钟起离屏回合：模型真被调用，clock.fired 进审计，任务被记成已提醒', async () => {
  const tmp = makeTmp('prts-clock-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  process.env.PRTS_CLOCK = 'on'
  process.env.PRTS_CLOCK_STALE_HOURS = '0.0001' // 0.36 秒后就算停滞（envNum 拒绝 0，见下方注释）
  process.env.PRTS_CLOCK_INTERVAL_MS = '3600000' // 定时器别插手中断：本测手动 tick
  process.env.PRTS_CLOCK_MIN_GAP_MS = '0'
  process.env.PRTS_CLOCK_DAILY_CAP = '5'

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '这件事该处理了。' }]).apply(app.ctx as Context)

    // 启动 kick 是 setTimeout(0)：先让它空转一次，免得和下面的断言抢时序。
    await new Promise((r) => setTimeout(r, 100))

    const clock = app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')

    // 造一个停滞任务：blocked 且阈值极小 → 短暂等一下就满足条件。
    //
    // 为什么用 0.0001 而不是 0：`start.ts:921` 的 `envNum` 要求 `raw > 0`，
    // 传 '0' 会被静默回落成默认 2 小时（本轮实测踩到）。「0 = 立刻提醒」
    // 在这套解析里表达不出来——那是既有的配置约定，本测不去改它。
    const owner = { kind: 'owner' } as const
    const created = app.ledger.create(owner, {
      title: '被阻塞的验收',
      objective: '验证时钟能发现停滞任务',
      acceptance: { kind: 'owner-confirm' },
    })
    const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
    app.ledger.block(owner, { id: created.id, revision: active.revision }, { code: 'hold', message: '等博士' })
    await new Promise((r) => setTimeout(r, 500))

    // 观测模型输出：没有这个断言，`fired===1` 也可能只是「消息入队了」。
    const streamed: unknown[] = []
    app.ctx.events?.on?.('agent/assistant-stream', (e: unknown) => streamed.push(e))

    const fired = await clock.tick()
    assert.equal(fired.length, 1, '应当投递一条')
    assert.equal(fired[0]?.kind, 'stale-task')
    assert.equal(fired[0]?.refId, created.id)
    assert.equal(clock.stats().fired, 1)

    // 真正起回合的证据：模型有产出。只入队不唤醒时这里会是空数组。
    assert.ok(streamed.length > 0, '模型必须真的产出内容——只有队列写入不算回合')

    // K4 留痕：审计链上能查到这一次主动开口。
    const db = new DatabaseSync(join(dataRoot, 'core.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare(
        "SELECT actor_json, payload_json FROM audit_events WHERE kind = 'clock.fired'",
      ).all() as Array<{ actor_json: string; payload_json: string }>
      assert.equal(rows.length, 1, 'clock.fired 必须恰好一条')
      assert.match(String(rows[0]?.actor_json), /clock/)
      const payload = JSON.parse(String(rows[0]?.payload_json)) as { refId?: string; reasonKind?: string; sessionId?: string }
      assert.equal(payload.refId, created.id)
      assert.equal(payload.reasonKind, 'stale-task')
      assert.match(String(payload.sessionId), /^prts-clock-/, '审计里要能指到那次离屏会话')
    } finally {
      db.close()
    }
  } finally {
    await app?.dispose()
    for (const k of ENV_KEYS) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    tmp.cleanup()
  }
})
