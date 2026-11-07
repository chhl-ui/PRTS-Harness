/**
 * `spawnSubtask` 编排层 + `prts_subtask` 派生闸。
 *
 * 设计见 `docs/design-session-identity.md` §3.2。重点钉住三件事：
 * 1. **先注册后创建**——create 被调用时 `isSubagentSession(sessionId)` 必须已为 true；
 * 2. **失败即释放**——create 抛错或超时不收敛，会话身份不残留；
 * 3. **派生闸**——子会话调用 `prts_subtask` 一律拒（深度上限 1）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Authority } from '../../src/authority/authority.ts'
import { spawnSubtask, createSubtaskTool, planSubtask } from '../../src/runtime/subtask.ts'
import { makeTmp } from '../support/tmp.ts'

interface Seen {
  created: unknown[]
  disposed: number
}

function fakeCtx(seen: Seen, opts: { failCreate?: boolean; stayRunning?: boolean } = {}) {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        async create(o: unknown): Promise<{ agent: { status: string; followup(m: unknown): void }; dispose(): Promise<void> }> {
          seen.created.push(o)
          if (opts.failCreate === true) throw new Error('create boom')
          return {
            agent: {
              status: opts.stayRunning === true ? 'running' : 'idle',
              followup(): void { /* 假 agent：不驱动真实回合 */ },
            },
            dispose: async (): Promise<void> => { seen.disposed += 1 },
          }
        },
      }
    },
  }
}

function env(opts: { failCreate?: boolean; stayRunning?: boolean } = {}) {
  const t = makeTmp('prts-spawn-sub-')
  const ws = join(t.dir, 'ws')
  const data = join(t.dir, 'data')
  mkdirSync(ws, { recursive: true })
  mkdirSync(data, { recursive: true })
  const auth = Authority.open(t.db('core.sqlite'), { workspaceRoots: [ws], protectedRoots: [] })
  const seen: Seen = { created: [], disposed: 0 }
  return {
    t, ws, data, auth, seen,
    deps: {
      ctx: fakeCtx(seen, opts), authority: auth, workspace: ws, dataRoot: data,
      parentSessionId: 'main-1', provider: 'p', model: 'm', timeoutMs: 600,
      // 假 agent 不写日志：缩短摘要轮询，避免每个用例白等默认的 30s。
      summaryWaitMs: 300,
    },
    cleanup() { auth.close(); t.cleanup() },
  }
}

test('SP1 成功：create 时会话已注册为子会话；返回后 dispose 且身份释放', async () => {
  const e = env()
  try {
    let registeredAtCreate = false
    const ctx = {
      get(name: string): unknown {
        if (name !== 'agents') return undefined
        return {
          async create(o: unknown) {
            // 关键断言：注册发生在 create 之前。
            const sid = (o as { sessionId?: string }).sessionId as string
            registeredAtCreate = e.auth.isSubagentSession(sid)
            e.seen.created.push(o)
            return {
              agent: { status: 'idle', followup(): void { /* noop */ } },
              dispose: async (): Promise<void> => { e.seen.disposed += 1 },
            }
          },
        }
      },
    }
    const r = await spawnSubtask({ ...e.deps, ctx }, '读十个文件并汇总', 't1')
    assert.equal(r.sessionId, 'subtask-t1')
    assert.equal(registeredAtCreate, true, '必须先注册后创建')
    assert.equal(e.seen.disposed, 1, 'dispose 必须被调用')
    assert.equal(e.auth.hasSessionScope('subtask-t1'), false, '结束必须释放身份')
  } finally { e.cleanup() }
})

test('SP2 create 失败：已注册的会话被释放，不残留幽灵子会话', async () => {
  const e = env({ failCreate: true })
  try {
    await assert.rejects(spawnSubtask(e.deps, '任务', 't2'), /create boom/)
    assert.equal(e.auth.hasSessionScope('subtask-t2'), false, '失败必须释放')
  } finally { e.cleanup() }
})

test('SP3 超时不收敛：抛错且释放身份、仍 dispose', async () => {
  const e = env({ stayRunning: true })
  try {
    await assert.rejects(spawnSubtask(e.deps, '任务', 't3'), /未在时限内收敛/)
    assert.equal(e.auth.hasSessionScope('subtask-t3'), false)
    assert.equal(e.seen.disposed, 1)
  } finally { e.cleanup() }
})

test('SP4 派生闸：子会话调用 prts_subtask 被拒（深度上限 1）', async () => {
  const e = env()
  try {
    e.auth.registerSessionRoots('sub-1', [])
    const defs: Array<{ name?: string; execute?: (a: unknown, x: unknown) => Promise<unknown> }> = []
    const { parentSessionId: _parent, ...toolDeps } = e.deps
    createSubtaskTool({ register: (d) => { defs.push(d as never); return () => {} } }, toolDeps)
    assert.equal(defs.length, 1)
    assert.equal(defs[0]?.name, 'prts_subtask')
    await assert.rejects(
      defs[0]!.execute!({ task: '再开一个' }, { agent: { session: { id: 'sub-1' } } }),
      /子会话不能再开子会话/,
    )
  } finally { e.cleanup() }
})

test('SP5 planSubtask 与 spawnSubtask 的注册键同一：dir 在 plan 的派生目录下', async () => {
  const e = env()
  try {
    const plan = planSubtask(e.ws, 't5')
    const r = await spawnSubtask(e.deps, '任务', 't5')
    assert.equal(r.sessionId, plan.sessionId)
    const created = e.seen.created[0] as { meta?: { cwd?: string } }
    assert.equal(created.meta?.cwd, plan.dir, '子会话工作目录必须是派生目录')
  } finally { e.cleanup() }
})

test('SP7 render 收到的是 execute 的返回值，不是入参（回归：回执缺正文）', () => {
  const e = env()
  try {
    const defs: Array<{
      name?: string
      output?: { render?: (args: unknown, value: unknown) => Array<{ text?: string }> }
    }> = []
    const { parentSessionId: _parent, ...toolDeps } = e.deps
    createSubtaskTool({ register: (d) => { defs.push(d as never); return () => {} } }, toolDeps)
    const render = defs[0]?.output?.render
    assert.equal(typeof render, 'function', 'prts_subtask 必须有 output.render')
    // DSH 的 render 契约是 (args, value)。只声明一个参数时收到的是 args，
    // summary 永远 undefined，回执会退化成入参 JSON——模型看到的只有 task/taskId。
    const out = render!({ task: '任务', taskId: 't7' }, { sessionId: 'subtask-t7', summary: '子会话回报的正文' })
    assert.equal(out[0]?.text, '子会话回报的正文', '必须渲染 summary，不能回退成入参 JSON')
  } finally { e.cleanup() }
})

/** 按 DSH 的落盘形状往子会话日志里追加一条 assistant 消息。 */
function appendAssistant(dataRoot: string, sessionId: string, text: string, seq: number): void {
  const dir = join(dataRoot, 'dsh-home', 'sessions', '--ws--', sessionId)
  mkdirSync(dir, { recursive: true })
  const rec = {
    type: 'assistant/message',
    seq,
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
  appendFileSync(join(dir, 'session.v4.jsonl'), `${JSON.stringify(rec)}\n`, 'utf8')
}

test('SP6 正文晚于固定窗口落盘：回执仍要拿到正文（回归：3s 轮询窗口读空）', { timeout: 30_000 }, async () => {
  const e = env()
  try {
    const sid = 'subtask-t6'
    const ctx = {
      get(name: string): unknown {
        if (name !== 'agents') return undefined
        return {
          async create(): Promise<unknown> {
            // 先落一条无文本的工具步（真实子会话就是这个形状：step1 只有 tool-call），
            // 正文在 3.6 秒后才到——比旧实现的 30×100ms 固定窗口晚。
            appendAssistant(e.data, sid, '', 13)
            setTimeout(() => appendAssistant(e.data, sid, '迟到的正文', 31), 3600)
            return {
              agent: { status: 'idle', followup(): void { /* noop */ } },
              dispose: async (): Promise<void> => { e.seen.disposed += 1 },
            }
          },
        }
      },
    }
    const r = await spawnSubtask({ ...e.deps, ctx, summaryWaitMs: 10_000 }, '任务', 't6')
    assert.equal(r.summary, '迟到的正文', '正文晚到也必须等到，不能返回空串')
  } finally { e.cleanup() }
})
