/**
 * V1-05 系统侧生产者 —— 运行时接线验收。
 *
 * `test/emotion/emotion-trigger.test.ts` 证明回调本身正确（直接调用）；
 * 本文件证明 `start.ts:1139-1142` 真的把 `createEmotionOnError` 接进了
 * `attachErrorReporter`，且 `agent/error` 能从**真实 runtime** 流到 EmotionStore。
 *
 * 依据（2026-11-06 实读）：
 * - `src/runtime/error-report.ts:119-127`：`ctx.events.on('agent/error', …)` → `onReport?.(entry)`
 * - `@deepseek-ai/dsh-agent-loop` 的 `throwError()` 先 emit `agent/error` 再 throw（`:877-884`）
 * - 同文件 `:1026`：`turn()` 的 catch 在 turn 内任何失败后调用 `throwError`
 *
 * 失败构造：`scriptedLlmPlugin([])` 的 stream 在脚本耗尽时 throw
 * （`test/support/scripted-llm.ts:41`），第一次模型调用即失败 → 进 turn catch。
 *
 * 基线（摘掉 `start.ts:1142` 的 `onReport` 时）：E2 红——emotion 库文件存在但状态为空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { EmotionStore } from '../../src/emotion/index.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

interface Harness {
  app: Awaited<ReturnType<typeof startRuntime>>
  emotionDb: string
  /** 跑一轮必然失败的对话：空脚本 LLM 在第一次模型调用时抛错。 */
  runFailingTurn(): Promise<void>
}

/**
 * 起一个真实 runtime。`PRTS_EMOTION_DB` 显式指向临时目录——环境变量是进程级共享，
 * 不显式设置会被其它测试文件的残留值污染。
 */
async function boot(t: { dir: string }): Promise<{ harness: Harness; restoreEnv: () => void }> {
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const emotionDb = join(dataRoot, 'emotion.sqlite')
  const previous = process.env.PRTS_EMOTION_DB
  process.env.PRTS_EMOTION_DB = emotionDb

  let app: Harness['app'] | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
  } catch (error) {
    if (previous === undefined) delete process.env.PRTS_EMOTION_DB
    else process.env.PRTS_EMOTION_DB = previous
    throw error
  }
  scriptedLlmPlugin([]).apply(app.ctx as Context)

  const running = app
  return {
    harness: {
      app: running,
      emotionDb,
      async runFailingTurn() {
        const agents = (running.ctx as unknown as {
          get(n: string): { create(o: unknown): Promise<{ agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }; dispose(): Promise<void> }> }
        }).get('agents')
        const h = await agents.create({
          sessionId: `emo-live-${randomUUID().slice(0, 8)}`,
          meta: { cwd: ws },
          agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
        })
        try {
          // 失败是预期的：agent-loop 的 kick() 吞异常；followup/whenIdle 仍可能抛。
          try {
            await h.agent.followup({
              content: [{ type: 'text', text: '你好' }],
              source: { kind: 'user' },
            })
            await h.agent.whenIdle()
          } catch { /* 该轮必然失败，断言看的是 EmotionStore 而不是这里 */ }
        } finally {
          await h.dispose()
        }
      },
    },
    restoreEnv: () => {
      if (previous === undefined) delete process.env.PRTS_EMOTION_DB
      else process.env.PRTS_EMOTION_DB = previous
    },
  }
}

/** 关掉 runtime 后再开一次读：证明状态真的落盘，不是只在内存里。 */
function readState(emotionDb: string): { valence: number; arousal: number; label: string; revision: number } | undefined {
  const s = EmotionStore.open(emotionDb)
  try {
    return s.get()
  } finally {
    s.close()
  }
}

test('E2 真实 turn 失败 → EmotionStore 写入「受挫」（startRuntime 接线生效）', async () => {
  const t = makeTmp('prts-emo-wiring-')
  const { harness, restoreEnv } = await boot(t)
  let state: ReturnType<typeof readState>
  try {
    try {
      await harness.runFailingTurn()
    } finally {
      await harness.app.dispose()
      restoreEnv()
    }
    state = readState(harness.emotionDb)
  } catch (error) {
    t.cleanup()
    throw error
  }

  assert.ok(state !== undefined, 'turn 失败后应有情绪状态；为空说明 agent/error 没流到 onReport')
  assert.ok(state.valence < 0, `受挫应为负效价，实际 ${state.valence}`)
  assert.equal(state.label, '受挫')
  assert.equal(state.revision, 1)
  t.cleanup()
})

test('E3 同一 runtime 内连续两轮失败只写一次（节流接线为单实例）', async () => {
  const t = makeTmp('prts-emo-wiring-')
  const { harness, restoreEnv } = await boot(t)
  let state: ReturnType<typeof readState>
  try {
    try {
      await harness.runFailingTurn()
      await harness.runFailingTurn()
    } finally {
      await harness.app.dispose()
      restoreEnv()
    }
    state = readState(harness.emotionDb)
  } catch (error) {
    t.cleanup()
    throw error
  }

  assert.ok(state !== undefined, '两轮失败后应有情绪状态')
  // 若每轮都新建回调（节流失效），revision 会是 2。
  assert.equal(state.revision, 1, `10 分钟窗口内第二次失败不该再写，revision 应为 1；实际 ${state.revision}`)
  t.cleanup()
})
