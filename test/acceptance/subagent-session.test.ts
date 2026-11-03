/**
 * 子会话（subagent）会话机制：从 `.rivet/scratch/probe-subagent-session.mjs` 固化而来。
 *
 * 为什么搬进测试目录：探针在 scratch 里 CI 不跑，「机制可用」这条结论就不可重复验证
 * （议事会 yaoguang 席指出，成立）。
 *
 * 验的是 DSH 的 `ctx.agents.create()` 在 PRTS 运行时里能否承载 Router/Worker 双层：
 *   A. 带 subagent meta 的 create 不抛错
 *   B. root 与 sub 两个 agent 同时存在
 *   C. session 头真记住血缘（origin / parentSession / delegationDepth / agentPreset）
 *   D. dispose 子会话不影响父会话
 *
 * 边界：本文件**不验**子会话能否完成实际任务并把结果带回父会话——那是 W2 的 `prts_subtask`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { startRuntime } from '../../src/runtime/start.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

interface AgentsSvc {
  create(o: unknown): Promise<{
    agent: { status: string; followup(m: unknown): void }
    dispose(): Promise<void>
  }>
}

/** 递归找工作区外的 session.v4.jsonl（DSH 的会话目录带 cwd 前缀，路径不可预测）。 */
function findSessionFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e === 'session.v4.jsonl') out.push(p)
    }
  }
  walk(root)
  return out
}

test('subagent 会话机制：创建 / 并存 / 血缘落盘 / 独立回收', { timeout: 120000 }, async () => {
  const t = makeTmp('prts-subagent-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  scriptedLlmPlugin([{ text: '收到。' }]).apply(app.ctx as Context)

  const agents = (app.ctx as unknown as { get(n: string): AgentsSvc }).get('agents')
  const rootSid = randomUUID()
  const subSid = randomUUID()

  try {
    const root = await agents.create({
      sessionId: rootSid,
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    assert.ok(root.agent, 'A：root agent 必须创建成功')

    const sub = await agents.create({
      sessionId: subSid,
      meta: {
        cwd: ws,
        parentSession: rootSid,
        origin: 'subagent',
        delegationDepth: 1,
        agentPreset: 'worker',
      },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    assert.ok(sub.agent, 'A：带 subagent meta 的 create 不得抛错')

    // B：并存
    assert.equal(root.agent.status, 'idle')
    assert.equal(sub.agent.status, 'idle')

    // 触发子会话持久化：只给 sub 发一条（scripted 脚本只有一条）
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    sub.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '干活' }],
      source: { kind: 'user' },
    }))
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 100))
      if (sub.agent.status === 'idle' && Date.now() - t0 > 300) break
    }

    // C：血缘落盘
    const files = findSessionFiles(join(dataRoot, 'dsh-home', 'sessions'))
    assert.ok(files.length > 0, 'C：至少落一个 session 文件')
    const subFile = files.find((f) => f.includes(subSid))
    assert.ok(subFile !== undefined, 'C：子会话的 session 文件必须存在')
    const header = JSON.parse(readFileSync(subFile!, 'utf8').split('\n')[0]) as Record<string, unknown>
    assert.equal(header.parentSession, rootSid, 'C：父子血缘必须落盘')
    assert.equal(header.origin, 'subagent', 'C：origin 必须落盘')
    assert.equal(header.delegationDepth, 1, 'C：委派深度必须落盘')
    assert.equal(header.agentPreset, 'worker', 'C：agent preset 必须落盘')

    // D：独立回收
    await sub.dispose()
    assert.equal(root.agent.status, 'idle', 'D：回收子会话不得影响父会话')
    await root.dispose()
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
