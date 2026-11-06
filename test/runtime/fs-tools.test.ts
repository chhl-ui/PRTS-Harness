/**
 * DSH 文件工具的两项能力验收。
 *
 * - `dsh-tool-fs-search`（glob / grep）：缺 rg 二进制时**启动不报错、首次调用才失败**
 *   （包内注释明写「keeps a missing or corrupt binary at the first search call … rather than
 *   failing the Loader composition」）。所以「runtime 起来了」不等于「搜索可用」，
 *   必须真调一次——本文件就是那次调用。
 * - `dsh-fs-observation-policy`（写前必读）：新建文件不受限，**覆盖会话没读过的已存在文件**
 *   被拒（`FS_NOT_OBSERVED`），读过之后才能覆盖。
 *
 * 两者都在 `config/prts.yml` 装配；本文件证明它们在真实 runtime 下按文档语义工作。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

interface ToolResult {
  name: string
  isError: boolean
  detail: string
}

interface Boot {
  app: Awaited<ReturnType<typeof startRuntime>>
  results: ToolResult[]
  off: () => void
}

/** 起真实 runtime 并收集 `tools/result`（与 attachToolFeed 同一个上游事件）。 */
async function boot(dataRoot: string, ws: string, script: ScriptedStep[]): Promise<Boot> {
  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  const results: ToolResult[] = []
  const events = (app.ctx as unknown as {
    events: { on(n: string, fn: (...a: unknown[]) => void): () => void }
  }).events
  const off = events.on('tools/result', (execution, result) => {
    const name = (execution as { name?: unknown }).name
    const isError = (result as { isError?: unknown }).isError === true
    results.push({
      name: typeof name === 'string' ? name : '',
      isError,
      // 失败时的 detail 只用于断言诊断，截断避免把整个 result 塞进消息
      detail: isError ? JSON.stringify(result).slice(0, 400) : '',
    })
  })
  scriptedLlmPlugin(script).apply(app.ctx as Context)
  return { app, results, off }
}

/** 跑一轮：脚本会按 toolCalls 顺序驱动多次模型调用。 */
async function runTurn(booted: Boot, ws: string): Promise<void> {
  const agents = (booted.app.ctx as unknown as {
    get(n: string): {
      create(o: unknown): Promise<{
        agent: { followup(m: unknown): Promise<void>; whenIdle(): Promise<void> }
        dispose(): Promise<void>
      }>
    }
  }).get('agents')
  const sessionId = `fs-${randomUUID().slice(0, 8)}`
  // 未注册会话的写权限是 deny（bad1fc1 的翻牌）——这里是真实守卫路径，不是夹具噪声。
  booted.app.authority.registerPrimarySession(sessionId)
  const h = await agents.create({
    sessionId,
    meta: { cwd: ws },
    agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
  })
  try {
    await h.agent.followup({ content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } })
    await h.agent.whenIdle()
  } finally {
    await h.dispose()
  }
}

test('F1 glob / grep 在真实 runtime 下可调用（缺 rg 二进制时这里会红）', { timeout: 180000 }, async () => {
  const t = makeTmp('prts-fs-search-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'alpha.txt'), 'alpha-marker-content\n', 'utf8')
  writeFileSync(join(ws, 'beta.log'), 'beta\n', 'utf8')

  const booted = await boot(dataRoot, ws, [
    { toolCalls: [{ name: 'glob', arguments: { pattern: '**/*.txt' } }] },
    { toolCalls: [{ name: 'grep', arguments: { pattern: 'alpha-marker' } }] },
    { text: 'done' },
  ])
  try {
    await runTurn(booted, ws)
  } finally {
    booted.off()
    await booted.app.dispose()
  }

  const glob = booted.results.find((r) => r.name === 'glob')
  const grep = booted.results.find((r) => r.name === 'grep')
  assert.ok(glob !== undefined, 'glob 没有执行——工具未装配，或 rg 二进制解析失败')
  assert.equal(glob.isError, false, `glob 执行失败：${glob.detail}`)
  assert.ok(grep !== undefined, 'grep 没有执行')
  assert.equal(grep.isError, false, `grep 执行失败：${grep.detail}`)

  t.cleanup()
})

test('F2 写前必读：新建放行、覆盖从未接触的文件被拒、读后放行', { timeout: 180000 }, async () => {
  const t = makeTmp('prts-fs-policy-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  const fresh = join(ws, 'fresh.txt')
  const guarded = join(ws, 'guarded.txt')
  // 预置一个会话「从未接触过」的文件——这才是 policy 要拦的目标。
  // （刚写成功的文件算已观察：tool-fs 每次操作成功都会发 `fs/observed`。）
  writeFileSync(guarded, 'preexisting', 'utf8')

  const booted = await boot(dataRoot, ws, [
    // 1) 新建：目标不存在，明确放行
    { toolCalls: [{ name: 'write', arguments: { file_path: fresh, content: 'v1' } }] },
    // 2) 覆盖从未接触过的已存在文件：应被拒（FS_NOT_OBSERVED）
    { toolCalls: [{ name: 'write', arguments: { file_path: guarded, content: 'v2' } }] },
    // 3) 读一次，记录观察
    { toolCalls: [{ name: 'read', arguments: { file_path: guarded } }] },
    // 4) 再覆盖：已观察，应放行
    { toolCalls: [{ name: 'write', arguments: { file_path: guarded, content: 'v3' } }] },
    { text: 'done' },
  ])
  try {
    await runTurn(booted, ws)
  } finally {
    booted.off()
    await booted.app.dispose()
  }

  const writes = booted.results.filter((r) => r.name === 'write')
  assert.equal(writes.length, 3, `应执行三次 write，实得 ${writes.length}`)
  assert.equal(writes[0].isError, false, `新建文件应放行：${writes[0].detail}`)
  assert.equal(writes[1].isError, true, '覆盖从未读过的已存在文件应被拒——写前必读策略没生效')
  assert.match(
    writes[1].detail,
    /without reading it first|FS_NOT_OBSERVED/,
    `拒绝理由应指向「没读过」：${writes[1].detail}`,
  )
  assert.equal(writes[2].isError, false, `读过之后覆盖应放行：${writes[2].detail}`)

  assert.equal(readFileSync(fresh, 'utf8'), 'v1')
  // 被拒的那次不能落盘；最终内容来自最后一次成功写入。
  assert.equal(readFileSync(guarded, 'utf8'), 'v3', '被拒的覆盖不该改动文件内容')

  t.cleanup()
})
