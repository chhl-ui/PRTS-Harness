/**
 * `/switch` 命令的 CLI 级验收（设计稿 `docs/design-switch-session.md` §四）。
 *
 * 用 fake agents 驱动真实命令分支：验证切换后新回合进入新 agent、流式/日志
 * 中间态被重置、旧会话 pending 审批不再被本进程应答、未注册目标补注册。
 * 纯函数层没有单独的 switch 模块——状态机就在 `runChat` 里，所以全部是接线测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import type { ChatDeps } from '../../src/cli/chat.ts'
import type { ApprovalBridge, PendingApproval } from '../../src/runtime/start.ts'
import type { Authority } from '../../src/authority/index.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface Followup {
  id: string
  msg: unknown
}

interface FakeAgent {
  status: string
  followup(msg: unknown): void
}

function makeAgent(id: string, record: Followup[]): FakeAgent {
  return {
    status: 'idle',
    followup(msg: unknown): void {
      record.push({ id, msg })
    },
  }
}

interface FakeCtxOpts {
  agents: Map<string, FakeAgent>
  record: Followup[]
  /** 记录 create 调用（`/new` 用）。 */
  creates?: string[]
  /** 捕获 `ctx.on('approval/request', …)`；其余事件忽略。 */
  approval?: { handler?: (req: unknown, next: () => unknown) => unknown }
}

function fakeCtx(opts: FakeCtxOpts): Context {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        list: () => [...opts.agents.keys()].map((id) => ({ session: { id } })),
        get: (id: string) => opts.agents.get(id),
        async create(o: { sessionId?: unknown }): Promise<unknown> {
          const sid = String(o?.sessionId ?? '')
          opts.creates?.push(sid)
          if (!opts.agents.has(sid)) opts.agents.set(sid, makeAgent(sid, opts.record))
          return { agent: opts.agents.get(sid), dispose: async (): Promise<void> => {} }
        },
      }
    },
    on(name: string, fn: (...a: never[]) => unknown): () => void {
      if (name === 'approval/request' && opts.approval !== undefined) {
        opts.approval.handler = fn as unknown as (req: unknown, next: () => unknown) => unknown
      }
      return (): void => {}
    },
  } as unknown as Context
}

/** 造一条磁盘会话日志；records 为空时只写 header（live 会话也可有日志）。 */
function seedSession(
  dataRoot: string,
  sid: string,
  records: Array<{ seq: number; text: string }> = [],
): void {
  const dir = join(dataRoot, 'dsh-home', 'sessions', '--ws--', sid)
  mkdirSync(dir, { recursive: true })
  const body = records
    .map((r) => JSON.stringify({
      type: 'assistant/message',
      seq: r.seq,
      data: { message: { content: [{ type: 'text', text: r.text }] } },
    }))
    .join('\n')
  writeFileSync(join(dir, 'session.v4.jsonl'), body === '' ? '{"type":"header"}\n' : body + '\n')
}

/** 最小 authority：只实现 chat.ts 用到的三个入口。 */
function fakeAuthority(): {
  authority: Authority
  registered: Set<string>
  registerCalls: string[]
} {
  const registered = new Set<string>()
  const registerCalls: string[] = []
  const authority = {
    registerPrimarySession(sessionId: string): void {
      registered.add(sessionId)
      registerCalls.push(sessionId)
    },
    hasSessionScope(sessionId: string): boolean {
      return registered.has(sessionId)
    },
    releaseSession(sessionId: string): void {
      registered.delete(sessionId)
    },
    recordOwnerDecision(): void { /* noop */ },
  } as unknown as Authority
  return { authority, registered, registerCalls }
}

test('SW1 切到存在的会话：后续 followup 进入新 agent', async () => {
  const t = makeTmp('prts-switch-1-')
  try {
    const record: Followup[] = []
    const agents = new Map([
      ['sess-a', makeAgent('sess-a', record)],
      ['sess-b', makeAgent('sess-b', record)],
    ])
    const printed: string[] = []
    const r = await runChat({
      ctx: fakeCtx({ agents, record }),
      lines: lines('/switch sess-b', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /已切到 sess-b/, `应有切换确认，实际：${text}`)
    assert.equal(record.length, 1, `应只有一次 followup，实际：${JSON.stringify(record.map((x) => x.id))}`)
    assert.equal(record[0].id, 'sess-b', 'followup 必须进入新 agent')
    assert.equal(r.turns, 1, '切换本身不产生回合')
  } finally {
    t.cleanup()
  }
})

test('SW2 切到不存在的会话：拒绝且不改变当前 agent', async () => {
  const t = makeTmp('prts-switch-2-')
  try {
    const record: Followup[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ agents, record }),
      lines: lines('/switch sess-nope', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /没有活跃会话 sess-nope/, `应拒绝并指路 /sessions，实际：${text}`)
    assert.equal(record.length, 1)
    assert.equal(record[0].id, 'sess-a', '拒绝后仍应留在原会话')
  } finally {
    t.cleanup()
  }
})

test('SW3 切到相同会话：幂等提示，不发消息', async () => {
  const t = makeTmp('prts-switch-3-')
  try {
    const record: Followup[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const printed: string[] = []
    const r = await runChat({
      ctx: fakeCtx({ agents, record }),
      lines: lines('/switch sess-a', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    assert.match(printed.join(''), /已经在这个会话/, '相同目标应幂等提示')
    assert.equal(record.length, 0, '幂等提示不产生 followup')
    assert.equal(r.turns, 0)
  } finally {
    t.cleanup()
  }
})

test('SW4 切换重置 seenSeq：新会话日志兜底不串旧会话', async () => {
  const t = makeTmp('prts-switch-4-')
  const dataRoot = join(t.dir, 'data')
  try {
    seedSession(dataRoot, 'sess-a', [{ seq: 7, text: '旧会话残留' }])
    seedSession(dataRoot, 'sess-b', [{ seq: 1, text: '新会话的回复' }])
    const record: Followup[] = []
    // 只预置切换目标：sess-a 由 runChat 启动时 create（seenSeq 从 0 起，第一轮才会读旧日志）。
    const agents = new Map([['sess-b', makeAgent('sess-b', record)]])
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ agents, record }),
      // 第一轮先把 seenSeq 推到 7（旧会话最后一条），再切换——不重置就会跳过新会话 seq=1。
      lines: lines('first', '/switch sess-b', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /旧会话残留/, `第一轮应读到旧会话日志，实际：${text}`)
    assert.match(text, /新会话的回复/, `切换后应重置 seenSeq 并读到新会话日志，实际：${text}`)
  } finally {
    t.cleanup()
  }
})

test('SW5 切换丢弃旧会话 pending 审批：旧请求交回下游，其他会话保留', async () => {
  const t = makeTmp('prts-switch-5-')
  try {
    const record: Followup[] = []
    const agents = new Map([
      ['sess-a', makeAgent('sess-a', record)],
      ['sess-b', makeAgent('sess-b', record)],
    ])
    const pending = new Map<string, PendingApproval>([
      ['call-old', { sessionId: 'sess-a', callId: 'call-old', tool: 'fs_write', capabilities: ['fs.write:C:/x'] }],
      ['call-other', { sessionId: 'sess-b', callId: 'call-other', tool: 'fs_write', capabilities: ['fs.write:C:/y'] }],
    ])
    const bridge: ApprovalBridge = {
      take(callId) {
        const p = pending.get(callId)
        if (p !== undefined) pending.delete(callId)
        return p
      },
      dropSession(sessionId) {
        let dropped = 0
        for (const [callId, p] of pending) {
          if (p.sessionId === sessionId) {
            pending.delete(callId)
            dropped += 1
          }
        }
        return dropped
      },
    }
    const approval: { handler?: (req: unknown, next: () => unknown) => unknown } = {}
    const { authority } = fakeAuthority()
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ agents, record, approval }),
      lines: lines('/switch sess-b', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
      authority,
      approvalBridge: bridge,
    })
    assert.notEqual(approval.handler, undefined, '有 authority + bridge 时应注册审批应答')
    let nextCalled = false
    await Promise.resolve(approval.handler!({ callId: 'call-old', reason: 'x' }, () => {
      nextCalled = true
      return 'downstream'
    }))
    assert.equal(nextCalled, true, '旧会话的 pending 应已被丢弃（交回下游）')
    assert.equal(printed.join('').includes('[审批]'), false, '不应再对旧会话发起 [y/N] 询问')
    assert.equal(pending.has('call-other'), true, '其他会话的 pending 不应被误清')
  } finally {
    t.cleanup()
  }
})

test('SW6 切到未注册会话：补注册为主会话', async () => {
  const t = makeTmp('prts-switch-6-')
  try {
    const record: Followup[] = []
    const agents = new Map([
      ['sess-a', makeAgent('sess-a', record)],
      ['sess-b', makeAgent('sess-b', record)],
    ])
    const { authority, registered } = fakeAuthority()
    await runChat({
      ctx: fakeCtx({ agents, record }),
      lines: lines('/switch sess-b', '/exit'),
      out: () => {},
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
      authority,
    })
    assert.equal(registered.has('sess-b'), true, '切换目标未注册时必须补注册')
  } finally {
    t.cleanup()
  }
})

test('SW7 缺参：用法提示，不切换', async () => {
  const t = makeTmp('prts-switch-7-')
  try {
    const record: Followup[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ agents, record }),
      lines: lines('/switch', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /用法：\/switch/, `缺参应给用法，实际：${text}`)
    assert.equal(record[0]?.id, 'sess-a', '缺参不改变当前 agent')
  } finally {
    t.cleanup()
  }
})

/** 类型探针：ChatDeps 的 approvalBridge 字段接受带 dropSession 的实现。 */
const _typeProbe: ChatDeps['approvalBridge'] = {
  take: () => undefined,
  dropSession: () => 0,
}
void _typeProbe

test('SN1 /new 新建会话并切换：后续 followup 进入新 agent', async () => {
  const t = makeTmp('prts-switch-new1-')
  try {
    const record: Followup[] = []
    const creates: string[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const printed: string[] = []
    const r = await runChat({
      ctx: fakeCtx({ agents, record, creates }),
      lines: lines('/new', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /已新建会话 prts-chat-/, `应有新建确认，实际：${text}`)
    assert.equal(creates.length, 1, '应 create 一个新会话')
    const newId = creates[0]!
    assert.equal(record.length, 1)
    assert.equal(record[0]!.id, newId, 'followup 必须进入新会话')
    assert.equal(r.turns, 1, '/new 本身不产生回合')
  } finally {
    t.cleanup()
  }
})

test('SN2 /new 注册新会话身份', async () => {
  const t = makeTmp('prts-switch-new2-')
  try {
    const record: Followup[] = []
    const creates: string[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const { authority, registered } = fakeAuthority()
    await runChat({
      ctx: fakeCtx({ agents, record, creates }),
      lines: lines('/new', '/exit'),
      out: () => {},
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
      authority,
    })
    const newId = creates[0]!
    assert.equal(registered.has(newId), true, '新会话必须注册身份')
  } finally {
    t.cleanup()
  }
})

test('SN3 /new create 失败：释放身份、报错、不切换', async () => {
  const t = makeTmp('prts-switch-new3-')
  try {
    const record: Followup[] = []
    const agents = new Map([['sess-a', makeAgent('sess-a', record)]])
    const { authority, registered } = fakeAuthority()
    const ctx = {
      get(name: string): unknown {
        if (name !== 'agents') return undefined
        return {
          get: (id: string) => agents.get(id),
          list: () => [...agents.keys()].map((id) => ({ session: { id } })),
          async create(): Promise<unknown> {
            throw new Error('create boom')
          },
        }
      },
    } as unknown as Context
    const printed: string[] = []
    await runChat({
      ctx,
      lines: lines('/new', 'hello', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-a',
      authority,
    })
    assert.match(printed.join(''), /新建会话失败：create boom/)
    assert.equal(
      [...registered].some((id) => id.startsWith('prts-chat-')),
      false,
      '失败的新会话身份必须释放，不能留幽灵会话',
    )
    assert.equal(record[0]?.id, 'sess-a', '失败后仍留在原会话')
  } finally {
    t.cleanup()
  }
})
