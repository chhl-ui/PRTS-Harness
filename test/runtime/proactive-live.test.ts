/**
 * V1-07 主动回忆 —— 运行时接线验收。
 *
 * 单元测试证明 `attachProactiveRecall` 本身正确；本文件证明它**真的接进了
 * 生产链路**（`start.ts` 的 pre-step 链）。没接线的模块是死代码，单测全绿也不代表
 * 用户能用上——这是交接文档记过的教训。
 *
 * 两条：
 *   PL1 默认开启：预置事实 + 相关提问 → 请求消息里出现 `[可以提起的旧事]`
 *   PL2 PRTS_PROACTIVE=off → 同场景下不出现（验收原文「可以关闭」）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const MARK = '[可以提起的旧事]'

/** 跑一次真实 runtime：预置事实 → 一轮提问 → 返回本次请求里所有消息文本。 */
async function runOnce(proactiveOff: boolean): Promise<string[]> {
  const t = makeTmp('prts-proactive-live-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const prior = process.env.PRTS_PROACTIVE
  if (proactiveOff) process.env.PRTS_PROACTIVE = 'off'
  else delete process.env.PRTS_PROACTIVE

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    assert.ok(app.memory !== undefined, '记忆库必须可用（本测试的前提）')
    app.memory.assertFact({
      actor: 'owner', subject: '博士', predicate: '偏好', object: '50mm 定焦镜头',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })

    const captured: string[][] = []
    const ctx = app.ctx as Context
    const llm = (ctx as unknown as { get(n: string): { registerAdapter(p: string[], a: unknown): void } }).get('llm')
    const orig = llm.registerAdapter.bind(llm)
    llm.registerAdapter = (providers: string[], adapter: {
      prepareCall(...a: string[]): Promise<{ model: unknown; stream(o: { messages?: { content?: unknown }[] }): unknown }>
    }) => {
      const pc = adapter.prepareCall.bind(adapter)
      adapter.prepareCall = async (...args: string[]) => {
        const call = await pc(...args)
        const os = call.stream.bind(call)
        call.stream = (opts: { messages?: { content?: unknown }[] }) => {
          captured.push((opts.messages ?? []).map((m) => JSON.stringify(m.content)))
          return os(opts)
        }
        return call
      }
      return orig(providers, adapter)
    }
    scriptedLlmPlugin([{ text: '收到。' }]).apply(ctx)

    const agents = (ctx as unknown as {
      get(n: string): { create(o: unknown): Promise<{ agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }; dispose(): Promise<void> }> }
    }).get('agents')
    const h = await agents.create({
      sessionId: `proactive-live-${randomUUID().slice(0, 8)}`,
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    try {
      await h.agent.followup({
        content: [{ type: 'text', text: '我最近想买镜头，有什么建议' }],
        source: { kind: 'user' },
      })
      await h.agent.whenIdle()
    } finally {
      await h.dispose()
    }
    return captured[captured.length - 1] ?? []
  } finally {
    if (app !== undefined) await app.dispose()
    if (prior === undefined) delete process.env.PRTS_PROACTIVE
    else process.env.PRTS_PROACTIVE = prior
    t.cleanup()
  }
}

test('PL1 默认开启：相关提问后请求里出现「可以提起的旧事」', async () => {
  const msgs = await runOnce(false)
  const hit = msgs.filter((m) => m.includes(MARK))
  assert.equal(hit.length, 1, `接线后应出现一条主动回忆注入：实得 ${hit.length}（共 ${msgs.length} 条消息）`)
  assert.ok(hit[0]!.includes('50mm'), `注入应含命中的事实：${hit[0]!.slice(0, 200)}`)
  assert.ok(hit[0]!.includes('不是用户本轮发言'), '必须自报来源')
})

test('PL2 PRTS_PROACTIVE=off：同场景不出现', async () => {
  const msgs = await runOnce(true)
  const hit = msgs.filter((m) => m.includes(MARK))
  assert.equal(hit.length, 0, `关闭后不得注入：实得 ${hit.length}`)
})
