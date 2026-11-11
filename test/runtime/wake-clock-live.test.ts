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
  'PRTS_CLOCK_FACT_MIN_IMPORTANCE',
  'PRTS_CLOCK_FACT_IDLE_DAYS',
  'PRTS_MISS_AFTER_HOURS',
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

test('CL2 第三路：重要性高的旧记忆成为触发理由（不看时间截止）', async () => {
  const tmp = makeTmp('prts-clock-fact-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  process.env.PRTS_CLOCK = 'on'
  process.env.PRTS_CLOCK_INTERVAL_MS = '3600000'
  process.env.PRTS_CLOCK_MIN_GAP_MS = '0'
  // 阈值调到刚好能接住下面这条 0.9 的事实；不设会让默认 0.6 也能过，但显式写出来
  // 才能证明旋钮真的接到代码上。
  process.env.PRTS_CLOCK_FACT_MIN_IMPORTANCE = '0.8'
  process.env.PRTS_CLOCK_FACT_IDLE_DAYS = '1'

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '这件事我一直记着。' }]).apply(app.ctx as Context)
    await new Promise((r) => setTimeout(r, 100))

    const clock = app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')
    const memory = app.memory
    assert.ok(memory !== undefined, '记忆库必须可用')

    // 一条高重要性事实：没有任何任务、没有到期意图 —— 唯一可能的理由就是它。
    const factId = memory.assertFact({
      actor: 'system',
      subject: '博士',
      predicate: '说过',
      object: '想在冬天去看一次极光',
      provenance: 'stated',
      confirmationBasis: 'owner-stated',
      origin: 'live',
      importance: 0.9,
    })

    const streamed: unknown[] = []
    app.ctx.events?.on?.('agent/assistant-stream', (e: unknown) => streamed.push(e))

    const fired = await clock.tick()
    assert.equal(fired.length, 1, '应当投递一条')
    assert.equal(fired[0]?.kind, 'fact', '理由必须是「惦记着的事」，不是到期或停滞')
    assert.equal(fired[0]?.refId, factId)
    assert.ok(streamed.length > 0, '模型必须真的产出内容')

    // 提过一次之后进冷却：下一次 tick 不该再提同一条（否则每 30 分钟念叨同一件事）。
    const again = await clock.tick()
    assert.equal(again.length, 0, '同一条记忆冷却期内不得重复提起')
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

test('CL3 ④ 长时间未见：tick 只写情绪不说话，一次离别一条（真实 runtime）', async () => {
  const tmp = makeTmp('prts-absence-live-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  process.env.PRTS_CLOCK = 'on'
  process.env.PRTS_CLOCK_INTERVAL_MS = '3600000' // 定时器不插手：本测手动 tick
  process.env.PRTS_CLOCK_MIN_GAP_MS = '0'
  process.env.PRTS_MISS_AFTER_HOURS = '1' // 阈值旋钮真的接到装配层

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '本测不该用到模型。' }]).apply(app.ctx as Context)
    await new Promise((r) => setTimeout(r, 100)) // 启动 kick 空转（此时无博士记录，不写）

    const clock = app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')
    const memory = app.memory
    assert.ok(memory !== undefined, '记忆库必须可用')

    // 种一条 2 小时前的博士发言：超过 1 小时阈值。没有任何到期意图/停滞任务/
    // 高重要性事实 → collectDue 为空，说话路径不该被走到。
    const seededAt = Date.now() - 2 * 3_600_000
    memory.recordTurn({
      actor: 'system', sessionId: 'sess-owner', turnIndex: 0, speaker: 'user',
      text: '博士两小时前说的话', occurredAtMs: seededAt,
    })
    assert.equal(memory.lastOwnerTurnAtMs(), seededAt, '数据源必须读到种子')

    const streamed: unknown[] = []
    app.ctx.events?.on?.('agent/assistant-stream', (e: unknown) => streamed.push(e))

    const emotionDb = join(dataRoot, 'emotion.sqlite')
    const missEvents = (): Array<{ actor_json: string; payload_json: string; ts: number }> => {
      const db = new DatabaseSync(emotionDb, { readOnly: true })
      try {
        return db.prepare(
          `SELECT actor_json, payload_json, ts FROM emotion_events
            WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = 'long-absence'
            ORDER BY seq`,
        ).all() as never
      } finally {
        db.close()
      }
    }

    const before = Date.now()
    const fired = await clock.tick()
    assert.deepEqual(fired, [], '没有到期理由：不得投递')
    assert.equal(streamed.length, 0, '④ 只写情绪，不起回合、不调模型')

    const chain = missEvents()
    assert.equal(chain.length, 1, '超阈值必须写一条想念')
    const actor = JSON.parse(chain[0].actor_json) as { kind: string; component: string }
    assert.deepEqual(actor, { kind: 'system', component: 'long-absence' })
    const payload = JSON.parse(chain[0].payload_json) as { valence: number; label: string; reason: string }
    assert.equal(payload.label, '想念')
    assert.equal(payload.valence, -0.15)
    assert.match(payload.reason, /2 小时没出现/)
    assert.ok(chain[0].ts >= before && chain[0].ts <= Date.now(), 'ts 必须是本次 tick 的时刻')

    // 一次离别一条：博士没回来，再 tick 不重复写。
    await clock.tick()
    assert.equal(missEvents().length, 1, '同一次离别不得重复写')
    assert.equal(streamed.length, 0)
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

test('CL4 PRTS_CLOCK=off：④ 随宿主一起不工作（不写情绪）', async () => {
  const tmp = makeTmp('prts-absence-off-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const saved = new Map<string, string | undefined>()
  for (const k of ENV_KEYS) saved.set(k, process.env[k])
  process.env.PRTS_CLOCK = 'off'
  process.env.PRTS_MISS_AFTER_HOURS = '1'

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '本测不该用到模型。' }]).apply(app.ctx as Context)
    await new Promise((r) => setTimeout(r, 100))

    assert.equal(app.clock, undefined, 'PRTS_CLOCK=off 时时钟必须缺席')
    const memory = app.memory
    assert.ok(memory !== undefined, '记忆库必须可用')
    memory.recordTurn({
      actor: 'system', sessionId: 'sess-owner', turnIndex: 0, speaker: 'user',
      text: '博士两小时前说的话', occurredAtMs: Date.now() - 2 * 3_600_000,
    })
    await new Promise((r) => setTimeout(r, 200)) // 没有定时器，等也不会有检查

    const db = new DatabaseSync(join(dataRoot, 'emotion.sqlite'), { readOnly: true })
    try {
      const rows = db.prepare(
        `SELECT count(*) AS c FROM emotion_events
          WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = 'long-absence'`,
      ).get() as { c: number }
      assert.equal(rows.c, 0, '时钟关着时不得写想念')
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
