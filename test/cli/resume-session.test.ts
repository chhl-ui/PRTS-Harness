/**
 * 续接同一会话（服务端重连 / `/switch` 之后回到同一目标）的 runChat 行为。
 *
 * 改造点：`agents.get(sessionId)` 优先于 `create`；身份未注册才注册；
 * 续接时 `seenSeq` 从日志当前最大 seq 起（不把历史回复当新回复重打）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
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
    followup(msg: unknown): void { record.push({ id, msg }) },
  }
}

function fakeCtx(opts: {
  agents: Map<string, FakeAgent>
  record: Followup[]
  creates: string[]
}): Context {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        get: (id: string) => opts.agents.get(id),
        list: () => [...opts.agents.keys()].map((id) => ({ session: { id } })),
        async create(o: { sessionId?: unknown }): Promise<unknown> {
          const sid = String(o.sessionId ?? '')
          opts.creates.push(sid)
          const agent = makeAgent(sid, opts.record)
          opts.agents.set(sid, agent)
          return { agent, dispose: async (): Promise<void> => {} }
        },
      }
    },
  } as unknown as Context
}

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
    recordOwnerDecision(): void { /* noop */ },
  } as unknown as Authority
  return { authority, registered, registerCalls }
}

function seedLog(dataRoot: string, sid: string, records: Array<{ seq: number; text: string }>): void {
  const dir = join(dataRoot, 'dsh-home', 'sessions', '--ws--', sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), records.map((r) => JSON.stringify({
    type: 'assistant/message',
    seq: r.seq,
    data: { message: { content: [{ type: 'text', text: r.text }] } },
  })).join('\n') + '\n')
}

test('RS1 同一 sessionId 第二次 runChat：复用已有 agent，不重复 create', async () => {
  const t = makeTmp('prts-resume-1-')
  try {
    const record: Followup[] = []
    const agents = new Map<string, FakeAgent>()
    const creates: string[] = []
    const ctx = fakeCtx({ agents, record, creates })
    const { authority } = fakeAuthority()
    const base = {
      ctx,
      out: () => {},
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-r1',
      authority,
    }
    await runChat({ ...base, lines: lines('hi', '/exit') })
    await runChat({ ...base, lines: lines('again', '/exit') })
    assert.deepEqual(creates, ['sess-r1'], '第二次必须复用，不能再 create')
    assert.equal(record.length, 2, '两次 followup 都应进入同一 agent')
    assert.ok(record.every((r) => r.id === 'sess-r1'))
  } finally { t.cleanup() }
})

test('RS2 续接不重复注册会话身份', async () => {
  const t = makeTmp('prts-resume-2-')
  try {
    const record: Followup[] = []
    const agents = new Map<string, FakeAgent>()
    const creates: string[] = []
    const ctx = fakeCtx({ agents, record, creates })
    const { authority, registerCalls } = fakeAuthority()
    const base = {
      ctx,
      out: () => {},
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'sess-r2',
      authority,
    }
    await runChat({ ...base, lines: lines('/exit') })
    await runChat({ ...base, lines: lines('/exit') })
    assert.deepEqual(registerCalls, ['sess-r2'], '未注册才注册：第二次不得重复写事件')
  } finally { t.cleanup() }
})

test('RS3 续接时 seenSeq 对齐日志最大 seq：历史回复不重打', async () => {
  const t = makeTmp('prts-resume-3-')
  const dataRoot = join(t.dir, 'data')
  try {
    seedLog(dataRoot, 'sess-r3', [{ seq: 5, text: '历史回复' }])
    const record: Followup[] = []
    // agent 已存在（模拟上一代会话留下的 live agent）。
    const agents = new Map([['sess-r3', makeAgent('sess-r3', record)]])
    const creates: string[] = []
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ agents, record, creates }),
      lines: lines('continue', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'sess-r3',
    })
    assert.deepEqual(creates, [], '已有 agent 不应再 create')
    assert.equal(printed.join('').includes('历史回复'), false, '历史回复被当成新回复重打了')
  } finally { t.cleanup() }
})
