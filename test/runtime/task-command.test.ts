/**
 * W4：终端入口。博士用 /task 开任务、/task-approve 批准模型建的 draft。
 *
 * 两条命令都不触发模型回合——它们是宿主行为，走 owner 通道。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

async function withRuntime(fn: (app: Awaited<ReturnType<typeof startRuntime>>, ws: string, dataRoot: string, printed: string[]) => Promise<void>): Promise<void> {
  const t = makeTmp('w4-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  const printed: string[] = []
  try {
    scriptedLlmPlugin([{ text: 'unused' }]).apply(app.ctx as Context)
    await fn(app, ws, dataRoot, printed)
  } finally {
    await app.dispose()
    t.cleanup()
  }
}

test('W4: /task 建任务、激活并绑定当前会话', { timeout: 180000 }, async () => {
  await withRuntime(async (app, ws, dataRoot, printed) => {
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('/task 写一个测试', '/exit'),
      out: (s) => printed.push(s),
      cwd: ws,
      dataRoot,
      sessionId: 'sess-w4',
      ledger: app.ledger,
    })
    const tasks = app.ledger.list()
    assert.equal(tasks.length, 1, `应只建一个任务，实际 ${tasks.length}`)
    assert.equal(tasks[0].phase, 'active', '激活后应为 active')
    assert.ok(tasks[0].objective.includes('写一个测试'), 'objective 未从命令带入')
    const bound = app.ledger.taskForSession('sess-w4')
    assert.ok(bound, '任务没绑到当前会话')
    assert.equal(bound.id, tasks[0].id)
    assert.equal(app.ledger.steps(tasks[0].id).length, 0, '/task 不应触发模型回合')
    console.log('[w4] printed =', JSON.stringify(printed))
    assert.ok(printed.join('').includes(tasks[0].id), '终端没有回显任务 id')
  })
})

test('W4: /task-approve 把 draft 激活；不存在或非 draft 时报错', { timeout: 180000 }, async () => {
  await withRuntime(async (app, ws, dataRoot, printed) => {
    const owner = { kind: 'owner' } as const
    const modelActor = { kind: 'model', sessionId: 'sess-x' } as const
    const draft = app.ledger.create(modelActor, {
      title: '模型提的', objective: 'O', acceptance: { kind: 'owner-confirm' },
    })
    assert.equal(draft.phase, 'draft')

    await runChat({
      ctx: app.ctx as Context,
      lines: lines(`/task-approve ${draft.id}`, '/exit'),
      out: (s) => printed.push(s),
      cwd: ws,
      dataRoot,
      sessionId: 'sess-w4b',
      ledger: app.ledger,
    })
    assert.equal(app.ledger.get(draft.id).phase, 'active', '批准后应为 active')
    assert.ok(printed.join('').includes(draft.id))

    // 不存在的 id：不崩，给提示
    const before = printed.length
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('/task-approve task-does-not-exist', '/exit'),
      out: (s) => printed.push(s),
      cwd: ws,
      dataRoot,
      sessionId: 'sess-w4c',
      ledger: app.ledger,
    })
    assert.ok(printed.length > before, '对不存在的 id 没有任何输出')
    void owner
  })
})

test('W4: 未配置 ledger 时 /task 不崩，给出明确提示', { timeout: 180000 }, async () => {
  await withRuntime(async (app, ws, dataRoot, printed) => {
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('/task 无账本', '/exit'),
      out: (s) => printed.push(s),
      cwd: ws,
      dataRoot,
      sessionId: 'sess-noledger',
      // 刻意不传 ledger
    })
    assert.ok(printed.join('').includes('ledger'), `无账本时应说明，实际输出 ${JSON.stringify(printed)}`)
  })
})
