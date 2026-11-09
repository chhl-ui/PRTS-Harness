/**
 * `/sandbox` 端到端：会话事件 → `sandboxPolicy.resolve` 回读。
 *
 * ## 为什么要这条测试
 *
 * `docs/TODO.md` 的「C. 可自动化，尚未做」第一条：「`/sandbox view` → `sandbox/mode`
 * 事件 → `sandboxPolicy.resolve` 回读这条端到端」未验。命令本身有 fake ctx 单元覆盖，
 * 但那证明的是「命令写了什么」，不是「写下去之后守卫真的按它执行」。
 *
 * ## 架构上它应该是通的
 *
 * `chat.ts:670` 的 `session.append('sandbox/mode', { mode })` 与 DSH 官方写路径
 * （`dsh-sandbox-policy/lib/index.js:40-42` 的 `setSandboxMode`）是同一行代码；
 * 同一个服务把会话日志折叠成投影，由 `ctx.sandboxPolicy.resolve({ session })` 读出
 * （`start.ts:193` 的 `resolveSandboxMode` 就是调它）。**但「应该通」不是证据**——
 * 2026-11-09 探针实测三项全通之后才固化成这里的三条用例。
 *
 * ## 为什么必须有「再切一档」
 *
 * 只测一次切换的话，一个「取第一条 mode 事件」的实现也能通过。第三次切回
 * `workspace-write` 才证明读的是**最近一次**投影。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { makeTmp } from '../support/tmp.ts'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

interface Booted {
  app: Awaited<ReturnType<typeof startRuntime>>
  create(): Promise<{ session: { append(t: string, d: unknown): void }; dispose(): Promise<void> }>
}

async function boot(t: { dir: string }): Promise<Booted> {
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
  const agents = (app.ctx as unknown as {
    get(n: string): {
      create(o: unknown): Promise<{ agent: { session: { append(t: string, d: unknown): void } }; dispose(): Promise<void> }>
    }
  }).get('agents')
  return {
    app,
    create: async () => {
      const h = await agents.create({
        sessionId: `sb-${randomUUID().slice(0, 6)}`,
        meta: { cwd: ws },
        agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
      })
      return { session: h.agent.session, dispose: async () => { await h.dispose() } }
    },
  }
}

test('SM1 部署默认档位可读出（不是 undefined）', async () => {
  const t = makeTmp('prts-sandbox-mode-')
  try {
    const b = await boot(t)
    const s = await b.create()
    try {
      const mode = b.app.sandboxModeFor(s.session)
      assert.equal(typeof mode, 'string', '档位解析不应返回 undefined——那意味着守卫拿不到约束')
      assert.ok(['read-only', 'workspace-write', 'danger-full-access'].includes(String(mode)), `未知档位：${mode}`)
    } finally { await s.dispose(); await b.app.dispose() }
  } finally { t.cleanup() }
})

test('SM2 写 sandbox/mode 事件 → resolve 立即跟上；再切一档也跟上', async () => {
  const t = makeTmp('prts-sandbox-mode-')
  try {
    const b = await boot(t)
    const s = await b.create()
    try {
      // 与 `/sandbox view` 完全相同的写路径（chat.ts:670）。
      s.session.append('sandbox/mode', { mode: 'read-only' })
      assert.equal(b.app.sandboxModeFor(s.session), 'read-only', '写事件后必须立刻按新档执行')

      // 第三次切回：证明读的是最近一次投影，不是「第一条 mode 事件」。
      s.session.append('sandbox/mode', { mode: 'workspace-write' })
      assert.equal(b.app.sandboxModeFor(s.session), 'workspace-write', '第二次切换必须覆盖第一次')
    } finally { await s.dispose(); await b.app.dispose() }
  } finally { t.cleanup() }
})

test('SM3 档位是 per-session：另一个会话不受影响', async () => {
  const t = makeTmp('prts-sandbox-mode-')
  try {
    const b = await boot(t)
    const a = await b.create()
    const c = await b.create()
    try {
      const baseline = b.app.sandboxModeFor(c.session)
      a.session.append('sandbox/mode', { mode: 'read-only' })
      assert.equal(b.app.sandboxModeFor(a.session), 'read-only')
      assert.equal(b.app.sandboxModeFor(c.session), baseline, '一个会话的切换不得泄漏到另一个会话')
    } finally { await a.dispose(); await c.dispose(); await b.app.dispose() }
  } finally { t.cleanup() }
})
