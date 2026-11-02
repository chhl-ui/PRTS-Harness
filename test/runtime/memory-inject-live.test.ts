/**
 * 运行时级注入回归：去重键含 turn 后，同一 session 每轮都应新增一条注入；
 * 历史注入以 user/message 持久化回放——第 k 轮请求里恰有 k 条 [记忆检索]。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const INJ = '记忆检索'

test('inject-live: 每轮新增注入、历史回放计数递增、本会话 turn 不进注入、已注入命中不再注入', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-inj-live-')
  const dataRoot = join(t.dir, 'data'); mkdirSync(dataRoot, { recursive: true })
  const ws = join(t.dir, 'ws'); mkdirSync(ws, { recursive: true })
  const mem = MemoryStore.open(join(dataRoot, 'memory.sqlite'))
  const kws = ['Alpha镜头', 'Beta滤镜', 'Gamma脚架']
  kws.forEach((kw, i) => mem.recordTurn({ actor: 'system', sessionId: 'other', turnIndex: i, speaker: 'user', text: `${kw} 的预置记忆`, occurredAtMs: Date.now() - 1e6 }))
  mem.close()

  const captured: string[][] = []
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({ configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }] })
    const ctx = app.ctx as Context
    const llm = (ctx as { get(n: string): { registerAdapter(p: string[], a: unknown): void } }).get('llm')
    const orig = llm.registerAdapter.bind(llm)
    llm.registerAdapter = (providers: string[], adapter: { prepareCall(...a: string[]): Promise<{ model: unknown; stream(o: { messages?: { content?: unknown }[] }): unknown }> }) => {
      const pc = adapter.prepareCall.bind(adapter)
      adapter.prepareCall = async (...args: string[]) => {
        const call = await pc(...args)
        const os = call.stream.bind(call)
        call.stream = (opts: { messages?: { content?: unknown }[] }) => { captured.push((opts.messages ?? []).map(m => JSON.stringify(m.content))); return os(opts) }
        return call
      }
      return orig(providers, adapter)
    }
    scriptedLlmPlugin([{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }, { text: 'r4' }, { text: 'r5' }]).apply(ctx)

    const agents = (ctx as { get(n: string): { create(o: unknown): Promise<{ agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }; dispose(): Promise<void> }> } }).get('agents')
    const sid = `sess-${randomUUID().slice(0, 8)}`
    const h = await agents.create({ sessionId: sid, meta: { cwd: ws }, agentOptions: { provider: 'deepseek-official', model: 'fake-1' } })
    const msg = (text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    for (let i = 0; i < 3; i++) {
      await h.agent.followup(msg(`说说 ${kws[i]} 的事`))
      await h.agent.whenIdle()
      await new Promise(r => setTimeout(r, 300))
      const reqs = captured[captured.length - 1] ?? []
      const inj = reqs.filter(m => m.includes(INJ))
      assert.equal(inj.length, i + 1, `第${i + 1}轮请求应含 ${i + 1} 条注入（历史 ${i} + 新 1）：实得 ${inj.length}`)
      assert.ok(inj[i].includes(kws[i]), `本轮新注入应含关键词 ${kws[i]}：${inj[i].slice(0, 300)}`)
      // 本会话的 user turn 都以「说说」开头，预置的他会话 turn 不含这个词
      for (const m of inj) assert.equal(m.includes('说说'), false, `注入里不得含本会话 turn 原文：${m.slice(0, 300)}`)
    }
    // 第 4 轮重问关键词 A：全部命中已注入过 → 不新增，请求里仍 3 条
    await h.agent.followup(msg(`再说说 ${kws[0]} 的事`))
    await h.agent.whenIdle()
    await new Promise(r => setTimeout(r, 300))
    const inj4 = (captured[captured.length - 1] ?? []).filter(m => m.includes(INJ))
    assert.equal(inj4.length, 3, `第4轮不应新增注入：实得 ${inj4.length}`)
    await h.dispose()
    await app.dispose(); app = undefined

    const sessDir = join(dataRoot, 'dsh-home', 'sessions')
    let jl = ''
    if (existsSync(sessDir)) for (const f of readdirSync(sessDir, { recursive: true }) as string[]) try { jl += readFileSync(join(sessDir, f), 'utf8') } catch { /* dir */ }
    const injLines = jl.split('\n').filter(l => l.includes(INJ))
    assert.equal(injLines.length, 3, `会话日志应有 3 条注入消息：实得 ${injLines.length}`)
  } finally {
    await app?.dispose()
    t.cleanup()
  }
})
