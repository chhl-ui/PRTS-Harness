/**
 * W4b：模型侧任务入口 prts_task_create。
 *
 * 三条不变量：
 *  - 只产出 draft，不会自动 active
 *  - acceptance 强制 owner-confirm（模型不能自带 checks 自证完成）
 *  - draft 不绑定会话（绑定是 owner 批准之后的事）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

test('W4b: 模型调用 prts_task_create 只产出 draft，不绑定、不自证', { timeout: 180000 }, async () => {
  const t = makeTmp('w4b-')
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
  try {
    const script: ScriptedStep[] = [
      {
        toolCalls: [{
          name: 'prts_task_create',
          arguments: { title: '模型提的任务', objective: '把 X 做完' },
        }],
      },
      { text: '已提交草案' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('帮我提个任务', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
      sessionId: 'sess-tool',
      ledger: app.ledger,
    })

    const tasks = app.ledger.list()
    console.log('[w4b] tasks =', JSON.stringify(tasks.map((x) => ({ id: x.id, phase: x.phase, acceptance: x.acceptance }))))
    assert.equal(tasks.length, 1, `应建出一个任务，实际 ${tasks.length}`)
    const task = tasks[0]
    assert.equal(task.phase, 'draft', '模型建的任务必须停在 draft')
    assert.equal(task.acceptance.kind, 'owner-confirm', '模型建的任务必须强制 owner-confirm')
    assert.equal(task.objective, '把 X 做完')
    // draft 不绑定会话
    assert.equal(app.ledger.taskForSession('sess-tool'), undefined, 'draft 不该绑定会话')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
