/**
 * E8 端到端回归：模型推进任务 + 博士裁决的完整闭环。
 *
 * 覆盖 D4：
 *  - 主链：create → /task-approve（bind→activate）→ note/step/evidence → claim_done →
 *    /accept。绑定由批准动作建立，链上没有任何一步依赖「未绑定却能工作」。
 *  - 断链：会话已绑 A 时再批准 draft B，B 必须仍是 draft（无半途状态）。
 *  - 负向：工具面与 owner 通道零交集、model 不能 activate、未 claim 不能 accept、
 *    addEvidence 四条路径域、stepNo 交错。
 *
 * 不修改 test/runtime/task-tool.test.ts:70 的既有断言（draft 不绑定会话）。
 *
 * 前置依赖（本文件不实现，属同波次的 D1–D3）：
 *  - prts_task_* 工具集（D2）与 stepNo 分配器 / prts_task_ 排除名单 / active 相位门（D1）
 *  - 无参 /task-approve（bind→activate）与 /accept（D3）
 *  - startRuntime 暴露已注册工具名列表（A6）与 draft 指针 getter
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const SESSION = 'sess-loop'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

type App = Awaited<ReturnType<typeof startRuntime>>

/** 启动一个运行时；script 只挂一次，cursor 跨多次 runChat 连续消费。 */
async function startWith(t: ReturnType<typeof makeTmp>, opts: {
  dataRoot: string
  ws: string
  script: ScriptedStep[]
}): Promise<App> {
  mkdirSync(opts.dataRoot, { recursive: true })
  mkdirSync(opts.ws, { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot: opts.dataRoot,
    workspace: opts.ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  scriptedLlmPlugin(opts.script).apply(app.ctx as Context)
  void t
  return app
}

/**
 * 把 startRuntime 暴露的 draft 指针 getter 透传给 runChat。
 * 字段名在 D2 里只规定为「与 approvalBridge 同模式」，未写死；这里按候选名探测，
 * 探测不到就传空——此时无参 /task-approve 的用例会以可读断言失败。
 */
function pointerDeps(app: App): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ['draftTaskForSession', 'draftForSession', 'draftPointer', 'draftTaskOfSession']) {
    const fn = (app as unknown as Record<string, unknown>)[k]
    if (typeof fn === 'function') out[k] = fn
  }
  return out
}

async function chat(app: App, ws: string, dataRoot: string, printed: string[], sessionId: string, ...input: string[]): Promise<void> {
  await runChat({
    ctx: app.ctx as Context,
    lines: lines(...input),
    out: (s) => printed.push(s),
    cwd: ws,
    dataRoot,
    sessionId,
    ledger: app.ledger,
    ...pointerDeps(app),
  })
}

/** 读已注册工具名：优先 startRuntime 暴露的只读列表（A6）。 */
function registeredToolNames(app: App): readonly string[] | undefined {
  const rec = app as unknown as Record<string, unknown>
  for (const k of ['toolNames', 'registeredTools', 'registeredToolNames', 'tools']) {
    const v = rec[k]
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 主链前提：draft 阶段的两条不变量（create 不绑定 / 指针可寻址）
// ---------------------------------------------------------------------------

test('E8 不变量：模型 create 停在 draft、会话未绑定，且 draft 指针记下该任务', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-draft-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const script: ScriptedStep[] = [
    { toolCalls: [{ name: 'prts_task_create', arguments: { title: '草案', objective: '草案' } }] },
    { text: '草案已提交。' },
  ]
  const app = await startWith(t, { dataRoot, ws, script })
  const printed: string[] = []
  try {
    await chat(app, ws, dataRoot, printed, SESSION, '帮我做这个', '/exit')

    const tasks = app.ledger.list()
    assert.equal(tasks.length, 1, `模型 create 应建出 1 个任务，实际 ${tasks.length}`)
    const task = tasks[0]
    assert.equal(task.phase, 'draft', '模型建的任务必须停在 draft')
    assert.equal(app.ledger.taskForSession(SESSION), undefined,
      '不变量被破坏：draft 阶段会话就已经绑定任务')

    // 无参 /task-approve 依赖「本会话刚提的草案」这条进程内指针。指针缺失时批准
    // 只能退化成「请博士手打 taskId」——那不是 E8 要验的路径，所以在这里显式断言，
    // 让探测失败变成红灯而不是静默传空对象。
    const ptr = pointerDeps(app)
    const names = Object.keys(ptr)
    assert.ok(names.length > 0,
      'startRuntime 未暴露 draft 指针 getter（候选名 draftTaskForSession/draftForSession/draftPointer/draftTaskOfSession），无参 /task-approve 无从取指')
    const got = (ptr[names[0]] as (s: string) => unknown)(SESSION)
    const id = typeof got === 'string' ? got : (got as { id?: string } | undefined)?.id
    assert.equal(id, task.id, `draft 指针应指向 ${task.id}，实际 ${String(id)}`)
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 负向⑥：归属校验
// ---------------------------------------------------------------------------

test('负向⑥：模型传不属于本会话的 taskId 被拒；同一工具的合法调用仍生效', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-owner-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  // script 是延迟消费的（scripted-llm 在 prepareCall 时才读 script[cursor]），
  // 所以可以先建任务拿到真实 id，再往同一数组里 push 回合脚本。
  const script: ScriptedStep[] = []
  const app = await startWith(t, { dataRoot, ws, script })
  const printed: string[] = []
  try {
    const owner = { kind: 'owner' } as const
    const mine = app.ledger.create(owner, { title: '我的', objective: 'mine', acceptance: { kind: 'owner-confirm' } })
    const mineActive = app.ledger.activate(owner, { id: mine.id, revision: mine.revision })
    const mineBound = app.ledger.bindSession(owner, { id: mine.id, revision: mineActive.revision }, SESSION)

    const other = app.ledger.create(owner, { title: '别人的', objective: 'other', acceptance: { kind: 'owner-confirm' } })
    const otherActive = app.ledger.activate(owner, { id: other.id, revision: other.revision })
    app.ledger.bindSession(owner, { id: other.id, revision: otherActive.revision }, 'sess-other')

    const mineBefore = app.ledger.get(mine.id).revision
    const otherBefore = app.ledger.get(other.id).revision

    script.push(
      // 越权：模型拿着别的会话的 taskId 调本会话可用的账本工具
      { toolCalls: [{ name: 'prts_task_note', arguments: { taskId: other.id, text: '越权写别人的任务' } }] },
      // 合法对照：同工具、本会话任务。没有这一条，工具缺失时「越权被拒」会假绿。
      { toolCalls: [{ name: 'prts_task_note', arguments: { taskId: mine.id, text: '本会话任务' } }] },
      { text: '两次都试过了。' },
    )
    await chat(app, ws, dataRoot, printed, SESSION, '试试越权', '/exit')

    assert.equal(app.ledger.get(other.id).revision, otherBefore,
      `越权 note 改动了别人的任务（revision ${otherBefore} → ${app.ledger.get(other.id).revision}），归属校验缺失`)
    assert.equal(app.ledger.get(mine.id).revision, mineBound.revision + 1,
      `同工具的合法调用没有生效（期望 revision ${mineBound.revision + 1}，实际 ${app.ledger.get(mine.id).revision}）——`
      + '多半是 prts_task_note 没注册，属 D2 未落地，不是归属校验生效')
    assert.ok(mineBefore > 0, '前置：本会话任务应处于已绑定状态')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 负向⑦：零证据的 /accept 是显式取舍（成功 + 知情提示），不是静默放行
// ---------------------------------------------------------------------------

test('负向⑦：claim_done 后零 evidence 的 /accept 仍成功，并给出无证据提示', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-noevidence-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const app = await startWith(t, { dataRoot, ws, script: [{ text: 'idle' }] })
  const printed: string[] = []
  try {
    const owner = { kind: 'owner' } as const
    const model = { kind: 'model', sessionId: SESSION } as const
    const created = app.ledger.create(owner, { title: '无证据', objective: 'no evidence', acceptance: { kind: 'owner-confirm' } })
    const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
    const bound = app.ledger.bindSession(owner, { id: created.id, revision: active.revision }, SESSION)
    app.ledger.claimDone(model, { id: created.id, revision: bound.revision })

    assert.equal(app.ledger.get(created.id).phase, 'verifying', '前置：claim_done 后应为 verifying')
    assert.equal(app.ledger.evidence(created.id).length, 0, '前置：本用例必须一条证据都没有')

    await chat(app, ws, dataRoot, printed, SESSION, '/accept', '/exit')

    // ① 成功：无证据不是硬门槛——验收依据是博士的判断，账本只负责让判断知情。
    //    这条断言防的是「后续有人把无证据也能 accept 当 bug，默默加上硬门槛」。
    assert.equal(app.ledger.get(created.id).phase, 'done',
      '零证据时 /accept 仍应成功（显式取舍：门在博士，不在账本）')
    // ② 知情：输出里必须有无证据提示文本——防它从「人知情判断」退化成「静默放行」。
    const seen = printed.join('')
    assert.ok(/无证据|没有证据|未登记证据|证据[^。]*?(0|零)/.test(seen),
      `/accept 的输出必须提示本次裁决没有证据支撑，实际输出 ${JSON.stringify(printed)}`)
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

const OWNER_ONLY_OPS = [
  'activate', 'cancel', 'setBudget', 'resumeFromStop', 'verify', 'ownerAccept', 'ownerReject',
]

// ---------------------------------------------------------------------------
// 主链 + 断链
// ---------------------------------------------------------------------------

test('E8 主链：create draft → approve 绑定激活 → 记笔记/步骤/证据 → claim → accept', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-main-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const evidenceFile = join(ws, 'build.log')

  const script: ScriptedStep[] = [
    // 回合 1：模型提草案
    { toolCalls: [{ name: 'prts_task_create', arguments: { title: '端到端', objective: '跑通 E8 闭环' } }] },
    { text: '草案已提交，等博士批准。' },
    // 回合 2：批准后模型推进
    { toolCalls: [{ name: 'prts_task_note', arguments: { text: '开始执行' } }] },
    { toolCalls: [{ name: 'prts_task_step_begin', arguments: { name: 'build', idempotent: false } }] },
    { toolCalls: [{ name: 'prts_task_step_end', arguments: { stepNo: 1, status: 'succeeded' } }] },
    { toolCalls: [{ name: 'prts_task_add_evidence', arguments: { artifactPath: evidenceFile, producedBy: 'build' } }] },
    { toolCalls: [{ name: 'prts_task_claim_done', arguments: {} }] },
    { text: '已完成，请博士验收。' },
  ]

  const app = await startWith(t, { dataRoot, ws, script })
  const printed: string[] = []
  try {
    writeFileSync(evidenceFile, 'ok\n')

    // 一次 runChat 跑完整条链。宿主命令（/task-approve、/accept）不触发模型回合，
    // 可以和模型输入混在同一批 lines 里——这正是产品路径的形态（chat-main 是单会话
    // 长循环）。反过来，同一 sessionId 分多次 runChat 会在 agents.create 处直接抛
    // `session "..." already exists`：那是测试写法问题，不是被测行为，不该由它判红。
    await chat(app, ws, dataRoot, printed, SESSION,
      '帮我做这个', '/task-approve', '开始干活', '/accept', '/exit')

    const tasks = app.ledger.list()
    assert.equal(tasks.length, 1, `模型 create 应建出 1 个任务，实际 ${tasks.length}`)
    const task = tasks[0]
    assert.equal(task.phase, 'done',
      `approve→note/step/evidence→claim_done→accept 走完应为 done，实际 ${task.phase}`)
    // 绑定事实查事件、不查 taskForSession：后者对终态任务不再返回
    // （ledger.ts:478-484 明写「任务终结后不再返回」），在 done 之后断言它必然为
    // undefined——那是库的既有语义，不是「绑定没建立」。事件是事实源，投影不是。
    const boundEvents = app.ledger.exportDoc().events.filter((e) => e.kind === 'task.session-bound')
    assert.equal(boundEvents.length, 1, `approve 应产生 1 条 task.session-bound 事件，实际 ${boundEvents.length}`)
    assert.equal(
      (boundEvents[0].payload as { sessionId?: string }).sessionId, SESSION,
      '绑定事件记录的会话不是本会话',
    )

    const steps = app.ledger.steps(task.id)
    const manual = steps.filter((s) => s.name === 'build')
    assert.equal(manual.length, 1, `显式 step_begin 应记下 1 个 build step，实际 ${manual.length}（steps=${JSON.stringify(steps)}）`)
    assert.equal(manual[0].status, 'succeeded', 'step_end 没把 build 收尾成 succeeded')
    assert.equal(steps.filter((s) => s.name.startsWith('prts_task_')).length, 0,
      `账本工具自己的调用不该产生 step：${JSON.stringify(steps.map((s) => s.name))}`)

    const evidence = app.ledger.evidence(task.id) as unknown as { artifactPath: string; producedBy?: string }[]
    assert.equal(evidence.length, 1, `应登记 1 条证据，实际 ${evidence.length}`)
    assert.ok(evidence[0].artifactPath.startsWith(ws),
      `登记的证据路径应为工作区绝对路径，实际 ${evidence[0].artifactPath}`)

    // /accept 已在同一次 runChat 内执行：ownerAccept 只接受 verifying
    // （src/ledger/ledger.ts:592-600），它成功即证明 claim_done 把任务推进到了
    // verifying——这条相位门的证据就是「不抛 INVALID_TRANSITION」。
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('E8 断链：会话已绑 A 时批准 draft B → 报错且 B 仍为 draft', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-broken-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')

  const script: ScriptedStep[] = [
    { toolCalls: [{ name: 'prts_task_create', arguments: { title: 'B', objective: '第二个草案' } }] },
    { text: '草案 B 已提交。' },
  ]
  const app = await startWith(t, { dataRoot, ws, script })
  const printed: string[] = []
  try {
    // 任务 A 走 owner 通道：激活并绑到本会话
    const owner = { kind: 'owner' } as const
    const a = app.ledger.create(owner, { title: 'A', objective: 'A', acceptance: { kind: 'owner-confirm' } })
    const aActive = app.ledger.activate(owner, { id: a.id, revision: a.revision })
    app.ledger.bindSession(owner, { id: a.id, revision: aActive.revision }, SESSION)

    // 同一会话内先 create draft B、再无条件批准——两条宿主命令与模型回合都在一次
    // runChat 里（理由同主链：同 sessionId 多次 runChat 会在 agents.create 处抛错）。
    await chat(app, ws, dataRoot, printed, SESSION, '再提一个', '/task-approve', '/exit')
    const b = app.ledger.list({ phase: 'draft' })[0]
    assert.ok(b, '模型 create 的 draft B 不存在')
    assert.equal(app.ledger.get(b.id).phase, 'draft',
      `绑定失败后 B 必须仍是 draft，实际 ${app.ledger.get(b.id).phase}`)
    assert.equal(app.ledger.get(a.id).phase, 'active', 'A 的状态不应被这次失败改动')
    assert.equal(app.ledger.taskForSession(SESSION)?.id, a.id, '会话绑定被错误改写')
    const seen = printed.join('')
    assert.ok(seen.length > 0, '批准失败没有任何可读输出')
    assert.ok(/批准失败|already bound|INVALID_TRANSITION|失败/i.test(seen),
      `批准失败应给出可读错误，实际输出 ${JSON.stringify(printed)}`)
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 负向断言
// ---------------------------------------------------------------------------

test('负向①：工具面与 owner 通道禁止名单零交集，且不含 bind_session 语义', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-tools-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const app = await startWith(t, { dataRoot, ws, script: [{ text: 'idle' }] })
  try {
    const names: readonly string[] | undefined = registeredToolNames(app)
    assert.ok(names !== undefined,
      'startRuntime 未暴露已注册工具名列表（计划 A6）——静态断言无法执行')
    for (const op of OWNER_ONLY_OPS) {
      // 允许 prts_task_ 前缀：只要不是「同名 owner 通道」
      const hits: string[] = names.filter((n) => n === op || n.endsWith(`_${op}`) || n.includes(op))
      assert.deepEqual(hits, [], `工具面暴露了 owner 通道操作 ${op}：${JSON.stringify(hits)}`)
    }
    const bind: string[] = names.filter((n) => /bind/i.test(n))
    assert.deepEqual(bind, [], `工具面暴露了会话绑定：${JSON.stringify(bind)}`)
    // 主链所需工具必须都在
    for (const need of ['prts_task_create', 'prts_task_note', 'prts_task_step_begin',
      'prts_task_step_end', 'prts_task_add_evidence', 'prts_task_claim_done']) {
      assert.ok(names.includes(need), `缺少主链工具 ${need}（已注册：${JSON.stringify(names)}）`)
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('负向②③：model 直接 activate 抛 FORBIDDEN；未 claim 就 ownerAccept 抛 INVALID_TRANSITION', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-actor-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const app = await startWith(t, { dataRoot, ws, script: [{ text: 'idle' }] })
  try {
    const owner = { kind: 'owner' } as const
    const model = { kind: 'model', sessionId: SESSION } as const
    const draft = app.ledger.create(model, { title: 'm', objective: 'm', acceptance: { kind: 'owner-confirm' } })
    assert.throws(
      () => app.ledger.activate(model, { id: draft.id, revision: draft.revision }),
      (e: { code?: string }) => e.code === 'FORBIDDEN',
      'model 直接调 activate 必须抛 FORBIDDEN',
    )

    const active = app.ledger.activate(owner, { id: draft.id, revision: draft.revision })
    assert.throws(
      () => app.ledger.ownerAccept({ id: active.id, revision: active.revision }),
      (e: { code?: string }) => e.code === 'INVALID_TRANSITION',
      'active（未 claim）时 ownerAccept 必须抛 INVALID_TRANSITION',
    )
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('负向④：addEvidence 路径域——dataRoot 内 / 工作区外 / 指向区外的链接 / 不存在的文件', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-evidence-')
  // dataRoot 放进工作区，专门验证「protectedRoots 排除」而不是靠「本来就在区外」的巧合
  const ws = join(t.dir, 'ws')
  const dataRoot = join(ws, '.prts-data')
  const secret = join(dataRoot, 'secrets', 'x.key')
  const outside = join(tmpdir(), `prts-loop-outside-${process.pid}-${Date.now()}.txt`)
  const link = join(ws, 'link-outside.txt')
  const missing = join(ws, 'missing.txt')

  const script: ScriptedStep[] = [
    { toolCalls: [{ name: 'prts_task_add_evidence', arguments: { artifactPath: secret, producedBy: 'x' } }] },
    { toolCalls: [{ name: 'prts_task_add_evidence', arguments: { artifactPath: outside, producedBy: 'x' } }] },
    { toolCalls: [{ name: 'prts_task_add_evidence', arguments: { artifactPath: link, producedBy: 'x' } }] },
    { toolCalls: [{ name: 'prts_task_add_evidence', arguments: { artifactPath: missing, producedBy: 'x' } }] },
    { text: '四次都该被拒。' },
  ]
  const app = await startWith(t, { dataRoot, ws, script })
  try {
    mkdirSync(join(dataRoot, 'secrets'), { recursive: true })
    writeFileSync(secret, 'SECRET')
    writeFileSync(outside, 'outside')
    writeFileSync(missing, 'x')
    unlinkSync(missing) // 存在性用例要求「工作区内不存在的文件」
    let linkOk = true
    try {
      symlinkSync(outside, link, 'file')
    } catch {
      linkOk = false // Windows 无符号链接特权时跳过 (c)，不伪造证据
    }

    const owner = { kind: 'owner' } as const
    const task = app.ledger.create(owner, { title: 'ev', objective: 'ev', acceptance: { kind: 'owner-confirm' } })
    const active = app.ledger.activate(owner, { id: task.id, revision: task.revision })
    app.ledger.bindSession(owner, { id: task.id, revision: active.revision }, SESSION)

    const printed: string[] = []
    await chat(app, ws, dataRoot, printed, SESSION, '登记证据', '/exit')

    const count = app.ledger.evidence(task.id).length
    assert.equal(count, linkOk ? 0 : 0, '被拒的证据不该落账')
    assert.equal(count, 0, `四种越界证据均不得落账，实际 ${count} 条`)
    assert.equal(app.ledger.get(task.id).phase, 'active', '拒绝证据不应改变任务相位')
    if (!linkOk) {
      console.log('[loop] 本机无符号链接权限，④c（链接指向区外）未实测')
    }
  } finally {
    await app.dispose()
    try { unlinkSync(outside) } catch { /* 已删 */ }
    t.cleanup()
  }
})

test('负向⑤：手动 step_begin 与自动记账交错无 UNEXPECTED_STEP，账本工具自身不产生 step', { timeout: 180000 }, async () => {
  const t = makeTmp('loop-steps-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  const script: ScriptedStep[] = [
    { toolCalls: [{ name: 'prts_task_step_begin', arguments: { name: 'manual-1', idempotent: false } }] },
    { toolCalls: [{ name: 'write', arguments: { file_path: join(ws, 'a.txt'), content: 'a' } }] },
    { toolCalls: [{ name: 'prts_task_step_end', arguments: { stepNo: 1, status: 'succeeded' } }] },
    { toolCalls: [{ name: 'write', arguments: { file_path: join(ws, 'b.txt'), content: 'b' } }] },
    { text: '交错完成' },
  ]
  const app = await startWith(t, { dataRoot, ws, script })
  try {
    const owner = { kind: 'owner' } as const
    const task = app.ledger.create(owner, { title: 'steps', objective: 'steps', acceptance: { kind: 'owner-confirm' } })
    const active = app.ledger.activate(owner, { id: task.id, revision: task.revision })
    app.ledger.bindSession(owner, { id: task.id, revision: active.revision }, SESSION)

    const printed: string[] = []
    await chat(app, ws, dataRoot, printed, SESSION, '交错执行', '/exit')

    const steps = app.ledger.steps(task.id)
    const nos = steps.map((s) => s.stepNo).sort((x, y) => x - y)
    assert.deepEqual(nos, [1, 2, 3],
      `交错后 stepNo 应为 1,2,3（无重号/跳号），实际 ${JSON.stringify(steps)}`)
    assert.deepEqual(steps.map((s) => s.name), ['manual-1', 'write', 'write'],
      `step 名称序列不符（账本工具不该入账）：${JSON.stringify(steps)}`)
    assert.equal(steps.filter((s) => s.name.startsWith('prts_task_')).length, 0,
      '账本工具调用产生了 step')
    assert.equal(existsSync(join(ws, 'a.txt')) && existsSync(join(ws, 'b.txt')), true,
      '自动记账期间的真实写工具没有执行')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
