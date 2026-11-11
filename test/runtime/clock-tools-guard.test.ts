/**
 * 时钟工具面的**边界行为**（G1—G7）：白名单落到真实注册集合、fail-closed 的
 * 错误形态、以及提示词与机制不撒谎。
 *
 * 与 `clock-tools.test.ts`（CT1—CT4，只验常量与 env 语义）、
 * `wake-clock-tools-live.test.ts`（CL5/CL6，验真实运行时里工具可见性）互补：
 * 这里钉住的两个失效模式在测试环境里不会自然发生——
 *
 * 1. **条件注册**：`prts_skill_list` 只在技能库打开成功时注册。技能链断裂是
 *    `start.ts` 里既有的 fail-closed 降级（注释明言「对话仍可进行」），但如果静态
 *    名单整个交给 `tools.restrict`，未注册的名字会让 `setup` 抛错 → 每次 tick 记一次
 *    投递失败 → 连续失败后时钟自停。一个模块降级把时钟这个产品能力打死，G1 钉住它。
 * 2. **回退模式的提示词**：`PRTS_CLOCK_TOOLS=off` 时工具面没有收窄，提示词再说
 *    「其他工具这次不可用」就是撒谎。G6 钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import {
  CLOCK_ALLOWED_TOOLS,
  applyClockToolPolicy,
  clockPromptGuidance,
  clockToolPolicy,
  createClockToolState,
} from '../../src/runtime/clock-tools.ts'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'

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
  'PRTS_SKILLS_DB',
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

/** 记录 restrict 收到的 filter；可选地在前 n 次抛错（模拟未注册工具名）。 */
function scopedRecorder(failTimes = 0): {
  filters: Array<{ allow: readonly string[] }>
  service: { restrict(filter: { allow: readonly string[] }): void }
} {
  const filters: Array<{ allow: readonly string[] }> = []
  return {
    filters,
    service: {
      restrict(filter: { allow: readonly string[] }): void {
        filters.push(filter)
        if (filters.length <= failTimes) {
          throw new Error('unknown tool: prts_skill_list (known: prts_memory_recall, …)')
        }
      },
    },
  }
}

function withConsoleError<T>(run: (logs: string[]) => T): T {
  const logs: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => { logs.push(args.map((a) => String(a)).join(' ')) }
  try {
    return run(logs)
  } finally {
    console.error = original
  }
}

test('G1 技能库降级不会打死时钟：名单先与真实注册集合取交集', async () => {
  const saved = saveEnv()
  const tmp = makeTmp('prts-clock-degraded-')
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    const dataRoot = join(tmp.dir, 'data')
    const ws = join(tmp.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(ws, { recursive: true })

    process.env.PRTS_CLOCK = 'on'
    process.env.PRTS_CLOCK_STALE_HOURS = '0.0001'
    process.env.PRTS_CLOCK_INTERVAL_MS = '3600000'
    process.env.PRTS_CLOCK_MIN_GAP_MS = '0'
    process.env.PRTS_CLOCK_DAILY_CAP = '5'
    // 技能库指向一个目录：open 必然失败 → skills = undefined → `prts_skill_list`
    // 根本没注册（start.ts 的 fail-closed 降级）。这正是 A1 的触发条件。
    process.env.PRTS_SKILLS_DB = tmp.dir

    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '技能工具不在也没关系，话照样说得出来。' }]).apply(app.ctx as Context)
    await new Promise((r) => setTimeout(r, 100))

    const owner = { kind: 'owner' } as const
    const created = app.ledger.create(owner, {
      title: '降级下的时钟',
      objective: '验证技能库降级不会让时钟投递失败',
      acceptance: { kind: 'owner-confirm' },
    })
    const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
    app.ledger.block(owner, { id: created.id, revision: active.revision }, { code: 'hold', message: '等博士' })
    await new Promise((r) => setTimeout(r, 500))

    const clock = app.clock
    assert.ok(clock !== undefined, 'PRTS_CLOCK=on 时时钟必须存在')
    const fired = await clock.tick()
    assert.equal(fired.length, 1, '技能工具缺席不该让时钟投递失败——静态名单必须被真实注册集合过滤')
    assert.equal(clock.stats().failures, 0, '这次投递不该被记成失败')
  } finally {
    await app?.dispose()
    restoreEnv(saved)
    tmp.cleanup()
  }
})

test('G2 策略与真实注册集合取交集：缺席的工具不进 allow，其余照旧', () => {
  // 技能链断：skill 工厂没建，registered 里没有 prts_skill_list。
  const withoutSkills = clockToolPolicy({}, [
    'prts_memory_recall', 'prts_session_recall', 'prts_task_list',
    'prts_intent_list', 'prts_intent_create',
  ])
  assert.deepEqual(withoutSkills, {
    allow: [
      'prts_memory_recall', 'prts_session_recall', 'prts_task_list',
      'prts_intent_list', 'prts_intent_create',
    ],
  })

  // 记忆库没打开：recall / intent 两组都不在。
  const withoutMemory = clockToolPolicy({}, new Set(['prts_task_list', 'prts_session_recall']))
  assert.deepEqual(withoutMemory, { allow: ['prts_session_recall', 'prts_task_list'] })

  // 一个都不在：空集（比预期更窄，不是更宽）。
  assert.deepEqual(clockToolPolicy({}, []), { allow: [] })

  // 注册集合里多出来的名字不会漏进 allow（allow-list 是上限）。
  assert.deepEqual(clockToolPolicy({}, [...CLOCK_ALLOWED_TOOLS, 'pwsh', 'write']), {
    allow: [...CLOCK_ALLOWED_TOOLS],
  })

  // 回退优先于交集：off 就是 off。
  assert.equal(clockToolPolicy({ PRTS_CLOCK_TOOLS: 'off' }, ['prts_task_list']), undefined)
})

test('G3 applyClockToolPolicy 拿不到 scoped tools 服务 → 规格指定的错误（含 null）', () => {
  const policy = { allow: ['prts_task_list'] }
  for (const missing of [undefined, null, {}, { restrict: 42 }, { restrict: 'nope' }]) {
    assert.throws(
      () => { applyClockToolPolicy(missing, policy) },
      (error: unknown) => error instanceof Error
        && error.message === 'wake-clock: scoped tools service unavailable',
      `scoped=${JSON.stringify(missing)} 必须报规格指定的错误，而不是 TypeError`,
    )
  }
})

test('G4 restrict 收到的是策略的副本，且收窄失败时退到空集而不是放行全量', () => {
  const policy = { allow: ['prts_memory_recall', 'prts_task_list'] }
  const ok = scopedRecorder()
  applyClockToolPolicy(ok.service, policy)
  assert.deepEqual(ok.filters, [{ allow: ['prts_memory_recall', 'prts_task_list'] }])
  // 调用方事后改策略，不该影响已经交出去的 filter。
  policy.allow.push('pwsh')
  assert.deepEqual(ok.filters[0]?.allow, ['prts_memory_recall', 'prts_task_list'])

  // 名单与真实注册集合仍漂移（点名了未注册工具）：restrict 抛错 → 空集重试。
  // 空集是「更窄」，绝不退回全量——时钟照常说话，只是这次没有工具。
  const drift = scopedRecorder(1)
  const logs = withConsoleError((captured) => {
    applyClockToolPolicy(drift.service, { allow: ['prts_skill_list'] })
    return captured
  })
  assert.equal(drift.filters.length, 2, '失败后必须重试一次')
  assert.deepEqual(drift.filters[1], { allow: [] }, '重试必须是空集——fail-closed 的方向是更窄')
  assert.ok(logs.some((l) => l.includes('降为空集')), '降级必须留下 stderr 痕迹，不静默')
})

test('G5 连空集也失败 → 抛错（投递给调度器记失败，不静默放行）', () => {
  const broken = scopedRecorder(2)
  withConsoleError(() => {
    assert.throws(
      () => { applyClockToolPolicy(broken.service, { allow: [] }) },
      (error: unknown) => error instanceof Error && error.message.includes('unknown tool'),
    )
  })
  assert.equal(broken.filters.length, 2)
})

test('G6 提示词与工具面一致：只提真有的工具，回退模式不谎称不可用', () => {
  const full = clockPromptGuidance(clockToolPolicy({}))
  for (const name of ['prts_memory_recall', 'prts_task_list', 'prts_intent_list',
    'prts_session_recall', 'prts_skill_list', 'prts_intent_create']) {
    assert.ok(full.includes(name), `默认名单下提示词必须提到 ${name}`)
  }
  assert.ok(full.includes('其他工具这次不可用'), '收紧模式下这是机制事实，应当说出来')

  // 技能工具缺席：提示词跟着名单走，不提一个会话里看不见的工具。
  const noSkills = clockPromptGuidance(clockToolPolicy({}, [
    'prts_memory_recall', 'prts_session_recall', 'prts_task_list',
    'prts_intent_list', 'prts_intent_create',
  ]))
  assert.ok(!noSkills.includes('prts_skill_list'), '工具不在名单里时提示词不得提它')
  assert.ok(noSkills.includes('prts_intent_create'))

  // 记忆库没打开：连写工具都没有，只剩任务与上次会话。
  const bare = clockPromptGuidance(clockToolPolicy({}, ['prts_task_list']))
  assert.ok(!bare.includes('prts_intent_create'), '没有写工具时不能说「用 prts_intent_create 记一条」')

  // 回退模式：工具面没有收窄 —— 不能再说「其他工具这次不可用」。
  const fallback = clockPromptGuidance(clockToolPolicy({ PRTS_CLOCK_TOOLS: 'off' }))
  assert.ok(!fallback.includes('其他工具这次不可用'), '回退模式下工具是全量的，提示词不得撒谎')
  assert.ok(fallback.includes('回退'), '回退模式要如实说明')
  assert.ok(!fallback.includes('PRTS_CLOCK_TOOLS'), '运维开关名不得写进给模型的对话正文')
})

test('G7 名单里的每个只读工具都有提示词说法（名单与提示词不漂移）', () => {
  const guidance = clockPromptGuidance(clockToolPolicy({}))
  for (const name of CLOCK_ALLOWED_TOOLS) {
    assert.ok(guidance.includes(name), `${name} 在名单里就必须在提示词里有说法`)
  }
  // 提示词里出现的工具名都必须是白名单成员（不引入名单外的名字）。
  const mentioned = guidance.match(/prts_[a-z_]+/g) ?? []
  for (const name of mentioned) {
    assert.ok((CLOCK_ALLOWED_TOOLS as readonly string[]).includes(name), `${name} 不在白名单里却被提示词提到`)
  }
})

test('G8 降级后同一轮提示词不再宣称工具可用（提示词跟机制一起降）', () => {
  const state = createClockToolState()
  const policy = clockToolPolicy({})
  // 未降级：正常提工具。
  assert.ok(clockPromptGuidance(policy, state).includes('prts_task_list'))

  // restrict 抛错（名单与真实注册集合漂移）→ 退空集 + 标记降级。
  const drift = scopedRecorder(1)
  withConsoleError(() => { applyClockToolPolicy(drift.service, { allow: ['prts_skill_list'] }, state) })
  assert.equal(state.degraded, true, '降级必须被记下来，否则提示词会继续撒谎')
  const degraded = clockPromptGuidance(policy, state)
  assert.ok(!degraded.includes('prts_task_list'), '工具面已降成空集，提示词不得再说可以查工具')
  assert.ok(degraded.includes('没有可用的工具'), '降级要如实告诉模型')

  // 下一次 restrict 成功 → 状态复位，提示词恢复。
  const ok = scopedRecorder()
  applyClockToolPolicy(ok.service, { allow: ['prts_task_list'] }, state)
  assert.equal(state.degraded, false, '成功一次就该复位，降级不是永久的')
  assert.ok(clockPromptGuidance(policy, state).includes('prts_task_list'))
})

test('G9 状态对象属于单次运行：两个 runtime 的降级互不影响', () => {
  const a = createClockToolState()
  const b = createClockToolState()
  withConsoleError(() => {
    applyClockToolPolicy(scopedRecorder(1).service, { allow: ['prts_skill_list'] }, a)
  })
  assert.equal(a.degraded, true)
  assert.equal(b.degraded, false, '降级状态不得跨 runtime 串味')
})
