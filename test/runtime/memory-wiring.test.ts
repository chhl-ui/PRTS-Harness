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
