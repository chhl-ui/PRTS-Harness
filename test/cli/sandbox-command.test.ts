/**
 * `/sandbox` 三档切换命令的 CLI 级验收。
 *
 * 档位即上游 `dsh-sandbox-policy` 的三个 SandboxMode：
 *   view/read-only、edit/workspace-write、full/danger-full-access。
 * 切换写 `sandbox/mode` 会话事件（setSandboxMode）；有活 PTY 时必须先 kill——
 * 上游 sandboxModeFence 在有持久终端时会拒绝 mode 事件，且旧 shell 本来就
 * 带着旧 confine 在跑，不切 shell 档位不会生效。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface Appended { type: string; data: unknown }

interface FakeAgent {
  status: string
  followup(msg: unknown): void
  session: { id: string; append(type: string, data: unknown): void }
}

function makeAgent(id: string, appended: Appended[], appendThrows?: string): FakeAgent {
  return {
    status: 'idle',
    followup(): void { /* 命令不应触发模型回合 */ },
    session: {
      id,
      append(type: string, data: unknown): void {
        if (appendThrows !== undefined) throw new Error(appendThrows)
        appended.push({ type, data })
      },
    },
  }
}

interface FakeCtxOpts {
  agent: FakeAgent
  /** resolve({session}).mode 的返回值；缺省 workspace-write。 */
  currentMode?: string
  /** 活 PTY 列表；提供时断言 kill 行为。 */
  ptySessions?: string[]
  calls?: string[]
}

function fakeCtx(o: FakeCtxOpts): { ctx: Context; killed: string[]; calls: string[] } {
  const killed: string[] = []
  const calls = o.calls ?? []
  const agents = new Map([[o.agent.session.id, o.agent]])
  return {
    killed,
    calls,
    ctx: {
      get(name: string): unknown {
        if (name === 'agents') {
          return {
            list: () => [...agents.keys()].map((id) => ({ session: { id } })),
            get: (id: string) => agents.get(id),
            async create(): Promise<unknown> {
              return { agent: o.agent, dispose: async (): Promise<void> => {} }
            },
          }
        }
        if (name === 'terminals') {
          const live = (o.ptySessions ?? []).map((sessionId) => ({ sessionId }))
          return {
            list: () => { calls.push('list'); return live.filter((s) => !killed.includes(s.sessionId)) },
            kill: async (_owner: unknown, id: string, _reason: string): Promise<void> => { calls.push(`kill:${id}`); killed.push(id) },
            hasOwnerActivity: () => live.some((s) => !killed.includes(s.sessionId)),
          }
        }
        if (name === 'sandboxPolicy') {
          return { resolve: () => ({ mode: o.currentMode ?? 'workspace-write' }) }
        }
        return undefined
      },
      on(): () => void { return (): void => {} },
    } as unknown as Context,
  }
}

test('SB1 无参 /sandbox：显示当前档位', async () => {
  const t = makeTmp('prts-sb-1-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx } = fakeCtx({ agent })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /workspace-write|工作区内修改/, `应显示当前档，实际：${text}`)
    assert.equal(appended.length, 0, '查看不应写事件')
  } finally { t.cleanup() }
})

test('SB2 /sandbox view：追加 sandbox/mode read-only；活 PTY 先被 kill', async () => {
  const t = makeTmp('prts-sb-2-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx, killed, calls } = fakeCtx({ agent, ptySessions: ['pty-1'] })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox view', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.deepEqual(appended, [{ type: 'sandbox/mode', data: { mode: 'read-only' } }],
      `应追加一条 mode 事件，实际：${JSON.stringify(appended)}`)
    assert.deepEqual(killed, ['pty-1'], '活 PTY 必须先被杀')
    assert.ok(calls.indexOf('kill:pty-1') >= 0, 'kill 必须发生')
    const text = printed.join('')
    assert.match(text, /已切到|仅可查看/, `应有切换确认，实际：${text}`)
  } finally { t.cleanup() }
})

test('SB3 /sandbox full：danger-full-access，输出含全放警示', async () => {
  const t = makeTmp('prts-sb-3-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx } = fakeCtx({ agent })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox full', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.deepEqual(appended, [{ type: 'sandbox/mode', data: { mode: 'danger-full-access' } }])
    assert.match(printed.join(''), /完全权限|不受限|密钥/, '全放必须有警示')
  } finally { t.cleanup() }
})

test('SB4 /sandbox edit：workspace-write', async () => {
  const t = makeTmp('prts-sb-4-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx } = fakeCtx({ agent, currentMode: 'read-only' })
    await runChat({
      ctx,
      lines: lines('/sandbox edit', '/exit'),
      out: () => {},
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.deepEqual(appended, [{ type: 'sandbox/mode', data: { mode: 'workspace-write' } }])
  } finally { t.cleanup() }
})

test('SB5 非法档位：用法提示，不写事件', async () => {
  const t = makeTmp('prts-sb-5-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx } = fakeCtx({ agent })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox bogus', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.match(printed.join(''), /用法：\/sandbox/, '非法档应给用法')
    assert.equal(appended.length, 0)
  } finally { t.cleanup() }
})

test('SB6 切到当前档：幂等提示，不重复写事件', async () => {
  const t = makeTmp('prts-sb-6-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended)
    const { ctx } = fakeCtx({ agent, currentMode: 'read-only' })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox view', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.match(printed.join(''), /已是/, '应幂等提示')
    assert.equal(appended.length, 0, '同档不重复写事件')
  } finally { t.cleanup() }
})

test('SB7 append 抛错（上游 fence 拒绝）：报错且不宣告成功', async () => {
  const t = makeTmp('prts-sb-7-')
  try {
    const appended: Appended[] = []
    const agent = makeAgent('sess-a', appended, 'cannot change sandbox mode while persistent terminal sessions are open')
    const { ctx } = fakeCtx({ agent })
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/sandbox view', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /失败|cannot change/, `应打印失败原因，实际：${text}`)
    assert.equal(text.includes('已切到'), false, '失败不能报成功')
  } finally { t.cleanup() }
})
