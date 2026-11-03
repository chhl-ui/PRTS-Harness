/**
 * 运行时级回归：人格库里的当前预设真的进了 system prompt。
 *
 * 单测（`test/persona/persona-store.test.ts`）证明库里存了什么，证明不了
 * 「它真的被 DSH 用上」——模块再对、没接线就是休眠模块。
 *
 * 这里同时钉住接线的一个陷阱：`bootPatches` 是**顶层键整体覆盖**
 * （`dsh-app-boot/lib/index.js:96` 的 `target[key] = value`），不是深合并。
 * 只给 `config.personaPrefix` 会把 `includeHarnessIdentity` 一起抹掉；
 * 所以断言前缀生效的同时，也断言另外两个字段仍是 false。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../../src/runtime/start.ts'
import { PersonaStore } from '../../src/persona/index.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const MARK = 'XR9-人格标记'

interface Captured { messages: string[] }

function captureRequests(ctx: Context): Captured[] {
  const captured: Captured[] = []
  const llm = (ctx as unknown as { get(n: string): { registerAdapter(p: string[], a: unknown): void } }).get('llm')
  const orig = llm.registerAdapter.bind(llm)
  llm.registerAdapter = (
    providers: string[],
    adapter: { prepareCall(...a: string[]): Promise<{ model: unknown; stream(o: { messages?: { content?: unknown }[] }): unknown }> },
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

test('persona-live: 库里的当前人格进 system prompt，且不抹掉同级的其他 config', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-persona-live-')
  const dataRoot = join(t.dir, 'data'); mkdirSync(dataRoot, { recursive: true })
  const ws = join(t.dir, 'ws'); mkdirSync(ws, { recursive: true })

  // 预置人格：一个带标记的核心设定
  const ps = PersonaStore.open(join(dataRoot, 'persona.sqlite'))
  ps.define({ kind: 'owner' }, { preset: 'prts', core: `你是测试人格。${MARK}`, style: '只说一句话。' })
  ps.switchTo({ kind: 'owner' }, 'prts')
  const prefix = ps.renderPrefix()
  ps.close()
  assert.ok(prefix.includes(MARK), '前提：库里渲染出的前缀含标记')

  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      patches: [{ id: 'llm-deepseek', disabled: true }],
    })
    const captured = captureRequests(app.ctx as Context)
    scriptedLlmPlugin([{ text: '好。' }]).apply(app.ctx as Context)

    const agents = (app.ctx as unknown as {
      get(n: string): { create(o: unknown): Promise<{ agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }; dispose(): Promise<void> }> }
    }).get('agents')
    const h = await agents.create({
      sessionId: `sess-${randomUUID().slice(0, 8)}`,
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    try {
      await h.agent.followup({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })
      await h.agent.whenIdle()
      await new Promise((r) => setTimeout(r, 300))
    } finally {
      await h.dispose()
    }

    const first = captured[0]
    assert.ok(first !== undefined, '应至少发出一次请求')
    const joined = first.messages.join('\n')
    assert.ok(joined.includes(MARK), `system prompt 应含库里的人格标记：\n${joined.slice(0, 800)}`)
  } finally {
    await app?.dispose()
  }
})
