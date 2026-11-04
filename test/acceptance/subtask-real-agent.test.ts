/**
 * 分派器的真机端到端：`spawnSubtask` 在真实 DSH agent 上派生、收敛、取摘要、释放身份。
 *
 * 此前 `spawnSubtask` 只在 fake agents 上测过（`test/runtime/spawn-subtask.test.ts`），
 * 真实 agent 的 followup / 摘要提取 / dispose 未被覆盖——这里是那条边界的实测补位。
 * 设计依据：`docs/design-superagent-fusion.md` §四「分派器（create worker，只回摘要）」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime } from '../../src/runtime/start.ts'
import { spawnSubtask } from '../../src/runtime/subtask.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

function findSessionFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      const p = join(d, e)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (e === 'session.v4.jsonl') out.push(p)
      } catch { /* 遍历间隙 */ }
    }
  }
  walk(root)
  return out
}

function transcriptFor(dataRoot: string, sessionId: string): string {
  let text = ''
  for (const f of findSessionFiles(join(dataRoot, 'dsh-home', 'sessions'))) {
    if (!f.includes(sessionId)) continue
    try { text += readFileSync(f, 'utf8') } catch { /* 正在写 */ }
  }
  return text
}

test('真机：spawnSubtask 派生真实 worker，只回摘要并释放身份', { timeout: 180000 }, async () => {
  const t = makeTmp('subtask-real-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: PATCHES,
  })
  try {
    scriptedLlmPlugin([{ text: '子任务完成：读完了十本书' }]).apply(app.ctx as Context)

    const r = await spawnSubtask({
      ctx: app.ctx as Context,
      authority: app.authority,
      workspace: ws,
      dataRoot,
      parentSessionId: 'parent-real-1',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timeoutMs: 60_000,
    }, '读十本书并总结', 'real1')

    assert.equal(r.sessionId, 'subtask-real1')
    assert.match(r.summary, /子任务完成：读完了十本书/, '摘要必须来自 worker 的真实产出')

    // worker 会话身份必须已释放（spawnSubtask 的 finally）。
    assert.equal(app.authority.hasSessionScope('subtask-real1'), false, 'worker 身份必须释放')

    // worker 的会话日志真实存在，且记录了派生血缘。
    const log = transcriptFor(dataRoot, 'subtask-real1')
    assert.match(log, /"parentSession":"parent-real-1"/, '会话 header 必须记住血缘')
    assert.match(log, /"origin":"subagent"/, '会话 header 必须标记 subagent')

    // 父会话没有产生模型回合（分派是子会话的事）。
    const parentLog = transcriptFor(dataRoot, 'parent-real-1')
    assert.equal(parentLog.includes('子任务完成'), false, 'worker 产出不应写进父会话日志')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
