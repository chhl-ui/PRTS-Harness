/**
 * W3：回合内的工具调用必须落成账本 step。
 *
 * 前提链：任务存在 → 绑定到该 session → 工具执行 → beginStep/endStep。
 * 没有绑定就什么都不记——这是刻意的（纯聊天不产生账本事实）。
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
const SESSION = 'sess-w3'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

test('W3: 绑定会话的任务会把工具调用记成 step', { timeout: 180000 }, async () => {
  const t = makeTmp('w3-')
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
    const owner = { kind: 'owner' } as const
    const task = app.ledger.create(owner, {
      title: 'W3', objective: 'O', acceptance: { kind: 'owner-confirm' },
    })
    const active = app.ledger.activate(owner, { id: task.id, revision: task.revision })
    app.ledger.bindSession(owner, { id: active.id, revision: active.revision }, SESSION)
    assert.equal(app.ledger.steps(task.id).length, 0, '记账前不该有 step')

    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'write', arguments: { file_path: join(ws, 'w3.txt'), content: 'x' } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('write it', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
      sessionId: SESSION,
      // 写权限以已注册身份为前提（2026-11-05 翻牌）：runChat 负责注册主会话。
      authority: app.authority,
    })

    const steps = app.ledger.steps(task.id)
    console.log('[w3] steps =', JSON.stringify(steps))
    assert.equal(steps.length, 1, `应记下 1 个 step，实际 ${steps.length}`)
    assert.equal(steps[0].name, 'write')
    assert.equal(steps[0].status, 'succeeded')
    assert.ok(steps[0].toolCallRef !== undefined && steps[0].toolCallRef !== '', 'toolCallRef 缺失')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('W3: 没绑任务的会话不产生 step（纯聊天不记账）', { timeout: 180000 }, async () => {
  const t = makeTmp('w3-nobind-')
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
    const owner = { kind: 'owner' } as const
    const task = app.ledger.create(owner, {
      title: '未绑定', objective: 'O', acceptance: { kind: 'owner-confirm' },
    })
    app.ledger.activate(owner, { id: task.id, revision: task.revision })
    // 刻意不 bindSession

    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'write', arguments: { file_path: join(ws, 'nb.txt'), content: 'x' } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    await runChat({
      ctx: app.ctx as Context,
      lines: lines('write it', '/exit'),
      out: () => {},
      cwd: ws,
      dataRoot,
      sessionId: 'sess-unbound',
    })

    assert.equal(app.ledger.steps(task.id).length, 0, '未绑定的会话不该往这个任务记 step')
    assert.equal(app.ledger.taskForSession('sess-unbound'), undefined)
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
