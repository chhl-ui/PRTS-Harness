/**
 * Wave 3 分派器：`planDispatch` 纯函数 + `dispatchTasks` 并发编排。
 *
 * 设计依据：`docs/design-superagent-fusion.md` §四「分派器（`create` worker，只回摘要）」，
 * 单任务派生语义复用 `spawnSubtask`（先注册后 create / 失败释放 / 只回摘要）。
 * 本文件钉四件事：
 * 1. **并发上限**——同时存活的 worker 不超过 concurrency；
 * 2. **失败隔离**——一个 worker 失败不拖垮同批其他任务，结果按输入顺序回；
 * 3. **taskId 去重**——同一 taskId 会撞同一 sessionId，必须在分派前拒绝；
 * 4. **摘要归属**——每个结果只带自己会话的摘要，不串其他 worker 的文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Authority } from '../../src/authority/authority.ts'
import { planDispatch, dispatchTasks } from '../../src/runtime/dispatcher.ts'
import { makeTmp } from '../support/tmp.ts'

interface Seen {
  created: unknown[]
  disposed: number
  active: number
  maxActive: number
}

function fakeCtx(
  seen: Seen,
  opts: { holdMs?: number; failTaskIds?: Set<string> } = {},
) {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        async create(o: unknown): Promise<{
          agent: { status: string; followup(m: unknown): void }
          dispose(): Promise<void>
        }> {
          const sid = String((o as { sessionId?: unknown }).sessionId ?? '')
          const taskId = sid.replace(/^subtask-/, '')
          if (opts.failTaskIds?.has(taskId) === true) throw new Error(`create boom ${taskId}`)
          seen.created.push(o)
          seen.active += 1
          seen.maxActive = Math.max(seen.maxActive, seen.active)
          if (opts.holdMs !== undefined) await new Promise((r) => setTimeout(r, opts.holdMs))
          return {
            agent: { status: 'idle', followup(): void { /* 假 agent：不驱动真实回合 */ } },
            dispose: async (): Promise<void> => {
              seen.active -= 1
              seen.disposed += 1
            },
          }
        },
      }
    },
  }
}

/** 写一条子会话日志：`spawnSubtask` 的摘要是从磁盘读的。 */
function seedLog(dataRoot: string, sessionId: string, text: string): void {
  const dir = join(dataRoot, 'dsh-home', 'sessions', '--ws--', sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), JSON.stringify({
    type: 'assistant/message',
    seq: 1,
    data: { message: { content: [{ type: 'text', text }] } },
  }) + '\n')
}

function env(opts: { holdMs?: number; failTaskIds?: Set<string> } = {}) {
  const t = makeTmp('prts-dispatch-')
  const ws = join(t.dir, 'ws')
  const data = join(t.dir, 'data')
  mkdirSync(ws, { recursive: true })
  mkdirSync(data, { recursive: true })
  const auth = Authority.open(t.db('core.sqlite'), { workspaceRoots: [ws], protectedRoots: [] })
  const seen: Seen = { created: [], disposed: 0, active: 0, maxActive: 0 }
  return {
    t, ws, data, auth, seen,
    deps: {
      ctx: fakeCtx(seen, opts),
      authority: auth,
      workspace: ws,
      dataRoot: data,
      parentSessionId: 'main-1',
      provider: 'p',
      model: 'm',
      timeoutMs: 600,
    },
    cleanup() { auth.close(); t.cleanup() },
  }
}

test('DP1 并发上限：3 个任务、上限 2 → 同时存活 worker 不超过 2', async () => {
  const e = env({ holdMs: 80 })
  try {
    const r = await dispatchTasks(e.deps, [
      { task: 'a', taskId: 'd1' },
      { task: 'b', taskId: 'd2' },
      { task: 'c', taskId: 'd3' },
    ], { concurrency: 2 })
    assert.equal(r.length, 3)
    assert.equal(r.every((x) => x.ok), true)
    assert.equal(e.seen.maxActive, 2, `并发必须被限到 2，实际峰值 ${e.seen.maxActive}`)
    assert.equal(e.seen.disposed, 3, '每个 worker 都必须被回收')
  } finally { e.cleanup() }
})

test('DP2 失败隔离：一个 worker 失败，其余照常完成且结果按输入顺序', async () => {
  const e = env({ failTaskIds: new Set(['d2']) })
  try {
    const r = await dispatchTasks(e.deps, [
      { task: 'a', taskId: 'd1' },
      { task: 'b', taskId: 'd2' },
      { task: 'c', taskId: 'd3' },
    ], { concurrency: 3 })
    assert.deepEqual(r.map((x) => x.taskId), ['d1', 'd2', 'd3'], '结果必须按输入顺序')
    assert.equal(r[0]!.ok, true)
    assert.equal(r[1]!.ok, false)
    assert.match(r[1]!.error ?? '', /create boom d2/)
    assert.equal(r[2]!.ok, true)
    assert.equal(e.auth.hasSessionScope('subtask-d2'), false, '失败的 worker 不残留身份')
  } finally { e.cleanup() }
})

test('DP3 taskId 去重：重复 taskId 在分派前拒绝', () => {
  assert.throws(
    () => planDispatch([{ task: 'a', taskId: 'x' }, { task: 'b', taskId: 'x' }]),
    /taskId 重复/,
  )
})

test('DP4 非法输入：空任务 / 非法并发上限被拒', () => {
  assert.throws(() => planDispatch([]), /至少一个任务/)
  assert.throws(() => planDispatch([{ task: '   ' }]), /非空/)
  assert.throws(() => planDispatch([{ task: 'a' }], { concurrency: 0 }), /concurrency/)
  assert.throws(() => planDispatch([{ task: 'a' }], { concurrency: 6 }), /concurrency/)
})

test('DP5 摘要归属：每个结果只带自己会话的摘要', async () => {
  const e = env()
  try {
    seedLog(e.data, 'subtask-d1', '摘要 d1')
    seedLog(e.data, 'subtask-d2', '摘要 d2')
    const r = await dispatchTasks(e.deps, [
      { task: 'a', taskId: 'd1' },
      { task: 'b', taskId: 'd2' },
    ], { concurrency: 2 })
    assert.equal(r[0]!.summary, '摘要 d1')
    assert.equal(r[1]!.summary, '摘要 d2')
  } finally { e.cleanup() }
})

test('DP6 planDispatch 为未给 taskId 的任务分配确定的 id', () => {
  const p = planDispatch([{ task: 'a' }, { task: 'b' }])
  assert.equal(p.tasks.length, 2)
  assert.match(p.tasks[0]!.taskId, /^[A-Za-z0-9_-]{1,64}$/)
  assert.notEqual(p.tasks[0]!.taskId, p.tasks[1]!.taskId, '自动 id 不得重复')
  assert.equal(p.concurrency, 3, '默认并发 3')
})
