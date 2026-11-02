/**
 * 记忆接线（V1-06 的前置）。
 *
 * 议事会核实过的事实：在本次接线之前，`src` 下没有任何文件 import `src/memory`，
 * `recordTurn` 只被 `test/` 调用——记忆模块是死代码，运行时从不产生 turn。
 * 所以「写时抽取」「检索优化」全都跑在测试数据上，真机一句话也记不住。
 *
 * 这个文件用**真实 runtime**（scripted LLM，不 mock 中间层）验证接线：
 * 跑一个 turn 之后，dataRoot 下的记忆库里必须有一条 speaker=user 的 turn，
 * 且文本与会话里发出去的一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { runTurn } from '../support/drive.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const disableLlm = [{ id: 'llm-deepseek', disabled: true }]

async function boot(t: ReturnType<typeof makeTmp>, script: ScriptedStep[], memoryDbPath?: string) {
  const dataRoot = join(t.dir, 'data')
  const workspace = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const app = await startRuntime({ configPath: prtsYml, dataRoot, workspace, mode: 'normal', patches: disableLlm, ...(memoryDbPath === undefined ? {} : { memoryDbPath }) })
  scriptedLlmPlugin(script).apply(app.ctx as Context)
  return { ...app, dataRoot, workspace }
}

test('MW1: 一个真实 turn 之后，记忆库里有对应的 user turn', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-memory-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    app = await boot(t, [{ type: 'text', text: '收到。' } as ScriptedStep])
    await runTurn(app.ctx as Context, '我的镜头偏好是 50mm 定焦', { cwd: app.workspace })

    const dbPath = join(app.dataRoot, 'memory.sqlite')
    assert.ok(existsSync(dbPath), '记忆库必须被创建在 dataRoot 下')

    const raw = new DatabaseSync(dbPath, { readOnly: true })
    const rows = raw.prepare(
      `SELECT t.speaker, t.origin, b.body FROM mem_turns t
         LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref`,
    ).all() as Array<{ speaker: string; origin: string; body: string | null }>
    raw.close()

    assert.ok(rows.length >= 1, '至少要落一条 turn')
    const mine = rows.find((r) => (r.body ?? '').includes('50mm 定焦'))
    assert.ok(mine, `发出的用户消息必须落进记忆库，实际落的是：${JSON.stringify(rows.map((r) => r.body))}`)
    assert.equal(mine.speaker, 'user')
    assert.equal(mine.origin, 'live', '真实对话必须是 live，不能标成 benchmark')
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})

test('MW3: 助手回复也要落盘——只记一半的记忆答不上「上次聊了什么」', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-memory-assistant-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    app = await boot(t, [{ type: 'text', text: '你的镜头偏好已记下，是 50mm 定焦。' } as ScriptedStep])
    await runTurn(app.ctx as Context, '帮我记一下镜头偏好', { cwd: app.workspace })

    const raw = new DatabaseSync(join(app.dataRoot, 'memory.sqlite'), { readOnly: true })
    const rows = raw.prepare(
      `SELECT t.speaker, t.origin, b.body FROM mem_turns t
         LEFT JOIN mem_bodies b ON b.body_ref = t.body_ref`,
    ).all() as Array<{ speaker: string; origin: string; body: string | null }>
    raw.close()

    const assistant = rows.find((r) => r.speaker === 'assistant')
    assert.ok(
      assistant,
      `助手回复必须落盘，实际 speaker 只有：${JSON.stringify([...new Set(rows.map((r) => r.speaker))])}`,
    )
    assert.match(assistant.body ?? '', /50mm 定焦/, '落盘的必须是助手的实际回复内容')
    assert.equal(assistant.origin, 'live')
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})

test('MW2: 记忆库不可用时不影响对话', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-memory-degraded-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  try {
    // 指向一个不可能创建的路径（父路径是文件而非目录）。
    // 用参数注入而不是 process.env——同进程并行跑用例时改环境变量会污染别人。
    const blocker = join(t.dir, 'blocker')
    mkdirSync(blocker, { recursive: true })

    app = await boot(t, [{ type: 'text', text: '收到。' } as ScriptedStep], join(blocker, 'not-a-dir', 'memory.sqlite'))
    // 记忆坏掉不影响回合：这里能跑完就说明没把异常抛穿
    await runTurn(app.ctx as Context, 'hello', { cwd: app.workspace })
    assert.ok(app.ctx, '运行时仍然可用')
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})

test('MW4: live turn 写入时间落在 [before, after]，renderInjection 显示 ISO 而非「时间未知」', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-rt-memory-time-')
  let app: Awaited<ReturnType<typeof boot>> | undefined
  const before = Date.now()
  try {
    app = await boot(t, [{ type: 'text', text: '记住了。' } as ScriptedStep])
    await runTurn(app.ctx as Context, '时间断言探针消息', { cwd: app.workspace })
    const after = Date.now()

    const raw = new DatabaseSync(join(app.dataRoot, 'memory.sqlite'), { readOnly: true })
    const rows = raw.prepare(
      `SELECT t.speaker, t.occurred_at_ms, t.occurred_raw FROM mem_turns t WHERE t.origin = 'live'`,
    ).all() as Array<{ speaker: string; occurred_at_ms: number | null; occurred_raw: string | null }>
    raw.close()
    const user = rows.find(r => r.speaker === 'user')
    const assistant = rows.find(r => r.speaker === 'assistant')
    assert.ok(user && assistant, `应有 user+assistant 两条 live turn：${JSON.stringify(rows)}`)
    for (const r of [user, assistant]) {
      assert.ok(r.occurred_at_ms !== null, `${r.speaker} 的 occurred_at_ms 不应为 NULL`)
      assert.ok(r.occurred_at_ms! >= before && r.occurred_at_ms! <= after, `${r.speaker} 时间 ${r.occurred_at_ms} 不在 [${before},${after}]`)
      assert.match(r.occurred_raw ?? '', /^\d{4}-\d{2}-\d{2}T/, 'occurred_raw 应为 ISO')
    }

    const { renderInjection } = await import('../../src/runtime/memory-inject.ts')
    const ms = user.occurred_at_ms!
    const rendered = renderInjection([{ kind: 'turn', id: 'x', score: 1, text: '旧文本', occurredAtMs: ms, occurredRaw: null, sessionId: 's', turnIndex: 0, source: 'exact' } as never])
    assert.match(rendered, /^\[记忆检索\]/, '前缀正确')
    assert.equal(rendered.includes('时间未知'), false, `不应出现时间未知：${rendered}`)
    assert.ok(rendered.includes(new Date(ms).toISOString()), `应含 ISO 时间：${rendered}`)
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})
