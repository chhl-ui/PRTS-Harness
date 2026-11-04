/**
 * V1-16 费用计量 —— 运行时接线验收。
 *
 * `cost-store.test.ts` 证明算术与汇总正确；本文件证明 `start.ts` 真的把
 * `agent/assistant-stream` 的 usage chunk 记进了 cost 库。
 *
 * 依据：`StreamChunk` 有 `{ type: 'usage', usage: TokenUsage }` 变体
 * （`dsh-llm/lib/types/types.d.ts:457-458`），`scripted-llm` 每轮都会发一条。
 *
 * 基线（未接线时）：CW1 会红——cost 库存在但 row 数为 0。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { openCostStore } from '../../src/cost/index.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

test('CW1 一轮对话后：cost 库里出现模型调用记录，巩固账户仍为 0', async () => {
  const t = makeTmp('prts-cost-live-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    scriptedLlmPlugin([{ text: '收到。' }]).apply(app.ctx as Context)

    const agents = (app.ctx as unknown as {
      get(n: string): { create(o: unknown): Promise<{ agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }; dispose(): Promise<void> }> }
    }).get('agents')
    const h = await agents.create({
      sessionId: `cost-live-${randomUUID().slice(0, 8)}`,
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    try {
      await h.agent.followup({
        content: [{ type: 'text', text: '你好' }],
        source: { kind: 'user' },
      })
      await h.agent.whenIdle()
    } finally {
      await h.dispose()
    }
  } finally {
    if (app !== undefined) await app.dispose()
  }

  // 关掉 runtime 后再开一次读：证明数据落盘而不是只在内存里。
  const s = openCostStore(join(dataRoot, 'cost.sqlite'))
  try {
    const sum = s.summary()
    assert.ok(sum.model.inputTokens >= 10, `应记录 scripted-llm 的 10 input token：实得 ${sum.model.inputTokens}`)
    assert.ok(sum.model.outputTokens >= 5, `应记录 5 output token：实得 ${sum.model.outputTokens}`)
    assert.equal(sum.consolidation.inputTokens, 0, '巩固账户不该被对话记账污染')
    // 单价未配置 → 金额 0，但 token 照记（不编造金额）
    assert.equal(sum.model.usd, 0)
  } finally {
    s.close()
    t.cleanup()
  }
})
