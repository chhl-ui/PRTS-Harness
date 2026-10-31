/**
 * U4：工具调用必须在 tools/execute 阶段就落 started 态，而不是等 tools/result
 * 才背靠背写 begin+end。
 *
 * 收益：进程在工具执行中途崩溃时，账本里留着 started 的 step，
 * `recoverOnStartup` 才能看到本进程的孤儿 step。背靠背写法下这条永远为空。
 *
 * 两条断言：
 *  1) execute 阶段（工具真正开始前）账本里已有 status==='started' 的记录，结束后转 succeeded
 *  2) 被守卫拒绝的调用不产生 step —— guard 在 execute 之前拒，beginStep 不该发生
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

interface Harness {
  steps: () => { stepNo: number; status: string; name: string }[]
  dispose: () => Promise<void>
}

/** 建任务、绑定 session、注册观察器，返回账本查询句柄。 */
async function setup(
  tag: string,
  sessionId: string,
  onExecute: (statuses: string[]) => void,
): Promise<Harness> {
  const t = makeTmp(`u4-${tag}-`)
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

  const owner = { kind: 'owner' } as const
  const task = app.ledger.create(owner, {
    title: `U4-${tag}`, objective: 'O', acceptance: { kind: 'owner-confirm' },
  })
  const active = app.ledger.activate(owner, { id: task.id, revision: task.revision })
  app.ledger.bindSession(owner, { id: active.id, revision: active.revision }, sessionId)

  // 观察器后注册 → 在 start.ts 的 beginStep 之后执行（cordis waterfall outermost-first），
  // 所以这里读到的已经是「begin 已发生」的账本快照。
  ;(app.ctx as unknown as {
    on(name: string, fn: (exec: unknown, next: () => unknown) => unknown): () => void
  }).on('tools/execute', async (_exec: unknown, next: () => unknown) => {
    onExecute(app.ledger.steps(task.id).map((s) => s.status))
    return next()
  })

  const script: ScriptedStep[] = [
    { toolCalls: [{ name: 'write', arguments: { target: ws, path: join(ws, 'u4.txt'), file_path: join(ws, 'u4.txt'), content: 'x' } }] },
    { text: 'done' },
  ]
  scriptedLlmPlugin(script).apply(app.ctx as Context)

  await runChat({
    ctx: app.ctx as Context,
    lines: lines('write it', '/exit'),
    out: () => {},
    cwd: ws,
    dataRoot,
    sessionId,
    ledger: app.ledger,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
  })

  return {
    steps: () => app.ledger.steps(task.id).map((s) => ({ stepNo: s.stepNo, status: s.status, name: s.name })),
    dispose: async () => { await app.dispose(); t.cleanup() },
  }
}

test('U4: execute 阶段已有 started 态，完成后转 succeeded', { timeout: 180000 }, async () => {
  const observed: string[][] = []
  const h = await setup('ok', 'sess-u4-a', (s) => observed.push(s))
  try {
    console.log('[u4] execute 期间观察到的 status 序列 =', JSON.stringify(observed))
    console.log('[u4] 最终 steps =', JSON.stringify(h.steps()))

    assert.ok(observed.length > 0, 'tools/execute 监听器没有被调用')
    assert.ok(
      observed.some((snap) => snap.includes('started')),
      `execute 阶段没有 started 态，说明 beginStep 还没挪到 execute：${JSON.stringify(observed)}`,
    )
    const final = h.steps()
    assert.equal(final.length, 1, `应恰好 1 条 step，实际 ${JSON.stringify(final)}`)
    assert.equal(final[0].status, 'succeeded', '结束后未转 succeeded')
  } finally {
    await h.dispose()
  }
})
