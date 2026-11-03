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
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      // 会话目录在首条 session 事件落盘前不存在；遍历间隙也可能被原子替换。
      return
    }
    for (const e of entries) {
      const p = join(d, e)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (e === 'session.v4.jsonl') out.push(p)
      } catch { /* 条目在遍历间隙被移走 */ }
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
    // C：血缘落盘。
    // 等的是断言对象本身——含 subSid 的 session 文件出现且 header 可解析——不是固定时长。
    // 两个原因：turn 结束后 DSH 还有 200ms 的批量写 debounce
    // （dsh-session-persistence-jsonl/lib/index.js:190）；且 `agent.status` 在任务结算前
    // 就可能停在 idle（dsh-agent runtime-types.d.ts:168「public status stays idle」），
    // 拿它当完成信号等于「固定等 300ms」，与落盘延迟贴线。
    // 2026-11-03 全量跑实测：本测试在 300ms 检查点竞速失败（628/629），同场景探针 252ms 才落盘。
    const sessionsRoot = join(dataRoot, 'dsh-home', 'sessions')
    const deadline = Date.now() + 20000
    let files: string[] = []
    let subFile: string | undefined
    let header: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      files = findSessionFiles(sessionsRoot)
      subFile = files.find((f) => f.includes(subSid))
      if (subFile !== undefined) {
        try {
          header = JSON.parse(readFileSync(subFile, 'utf8').split('\n')[0]) as Record<string, unknown>
          break
        } catch { header = undefined /* 文件正在写，下一轮再读 */ }
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(files.length > 0, 'C：至少落一个 session 文件')
    assert.ok(subFile !== undefined, 'C：子会话的 session 文件必须存在')
    assert.ok(header !== undefined, 'C：子会话的 session 头必须可解析')
    assert.equal(header!.parentSession, rootSid, 'C：父子血缘必须落盘')
    assert.equal(header!.origin, 'subagent', 'C：origin 必须落盘')
    assert.equal(header!.delegationDepth, 1, 'C：委派深度必须落盘')
    assert.equal(header!.agentPreset, 'worker', 'C：agent preset 必须落盘')

    // D：独立回收
    await sub.dispose()
    assert.equal(root.agent.status, 'idle', 'D：回收子会话不得影响父会话')
    await root.dispose()
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
