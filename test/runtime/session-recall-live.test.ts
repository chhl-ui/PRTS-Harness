/**
 * 运行时级回归：⑦ 跨会话连续在**真实组合**里生效。
 *
 * 单测（`session-recall.test.ts`）证明模块行为，证明不了「接线生效」——
 * `attachSessionRecall` 注册进 `start.ts` 的 pre-step 链之前，模块再对也不会有一行
 * 进模型上下文。这个文件用真实 runtime（scripted LLM，不 mock 中间层）跑两次启动，
 * 直接对验收原文取证：**跨两次启动后，新会话能看到上个会话说过的话**。
 *
 * 与 `memory-inject-live.test.ts` 同一取证手法：拦 `llm.registerAdapter`，
 * 在 `prepareCall` 返回的 `stream(opts)` 上抓 `opts.messages`——那是模型真正收到的请求。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const HEAD = '上次聊到哪里'

interface Captured { messages: string[] }

/** 拦 adapter：每条请求的 messages 压成可搜索的字符串。 */
function captureRequests(ctx: Context): Captured[] {
  const captured: Captured[] = []
  const llm = (ctx as unknown as { get(n: string): { registerAdapter(p: string[], a: unknown): void } }).get('llm')
  const orig = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (
    providers: string[],
    adapter: {
      prepareCall(...a: string[]): Promise<{ model: unknown; stream(o: { messages?: { content?: unknown }[] }): unknown }>
    },
  ) => {
    const pc = adapter.prepareCall.bind(adapter)
    adapter.prepareCall = async (...args: string[]) => {
      const call = await pc(...args)
      const os = call.stream.bind(call)
      call.stream = (opts: { messages?: { content?: unknown }[] }) => {
        captured.push({ messages: (opts.messages ?? []).map((m) => JSON.stringify(m.content)) })
        return os(opts)
      }
      return call
    }
    return orig(providers, adapter)
  }
  return captured
}

interface AgentHandle {
  agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }
  dispose(): Promise<void>
}

async function say(ctx: Context, sessionId: string, cwd: string, text: string): Promise<void> {
  const agents = (ctx as unknown as {
    get(n: string): { create(o: unknown): Promise<AgentHandle> }
  }).get('agents')
  const h = await agents.create({
    sessionId,
    meta: { cwd },
    agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
  })
  try {
    await h.agent.followup({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    await h.agent.whenIdle()
    await new Promise((r) => setTimeout(r, 300))
  } finally {
    await h.dispose()
  }
}

test('recall-live: 跨两次启动后，新会话开场带上个会话说过的话', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-recall-live-')
  const dataRoot = join(t.dir, 'data'); mkdirSync(dataRoot, { recursive: true })
  const ws = join(t.dir, 'ws'); mkdirSync(ws, { recursive: true })
  const marker = '我把镜头换成 85mm 了'
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    // ---- 第一次启动：真实跑一轮，让它落成「上个会话」的历史 ----
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    const firstCaptured = captureRequests(app.ctx as Context)
    scriptedLlmPlugin([{ text: '收到。' }]).apply(app.ctx as Context)
    await say(app.ctx as Context, `sess-${randomUUID().slice(0, 8)}`, ws, marker)
    // 首次启动时库是空的：开场没有可交代的东西，不该注入
    assert.equal(
      firstCaptured.some((c) => c.messages.some((m) => m.includes(HEAD))), false,
      '空库不该注入开场（SR1 的运行时侧对应）',
    )
    await app.dispose(); app = undefined

    // ---- 第二次启动：同一 dataRoot，新会话 ----
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    const secondCaptured = captureRequests(app.ctx as Context)
    scriptedLlmPlugin([{ text: '早上好。' }]).apply(app.ctx as Context)
    await say(app.ctx as Context, `sess-${randomUUID().slice(0, 8)}`, ws, '早上好')

    const first = secondCaptured[0]
    assert.ok(first !== undefined, '第二次启动应至少发出一次请求')
    const joined = first.messages.join('\n')
    assert.ok(joined.includes(HEAD), `新会话的第一条请求里应含开场正文：\n${joined.slice(0, 1200)}`)
    assert.ok(joined.includes(marker), `开场应带出上个会话说过的话：\n${joined.slice(0, 1200)}`)
    assert.ok(joined.includes('不是用户本轮发言'), '开场必须自报来源')
  } finally {
    await app?.dispose()
  }
})
