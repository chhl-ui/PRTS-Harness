/**
 * `/sessions` 命令的 CLI 级验收：命令真的把会话表打到 `deps.out`。
 *
 * 纯函数层已在 `test/runtime/session-table.test.ts` 钉住；这里只验接线——
 * 去掉 chat.ts 里的命令分支即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import type { ChatDeps } from '../../src/cli/chat.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

function fakeCtx(list: Array<{ session?: { id?: string } }>) {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        list: () => list,
        async create(): Promise<unknown> {
          return {
            agent: { status: 'idle', followup(): void { /* noop */ } },
            dispose: async (): Promise<void> => { /* noop */ },
          }
        },
      }
    },
  } as unknown as Context
}

function seedSession(dataRoot: string, sid: string): void {
  const dir = join(dataRoot, 'dsh-home', 'sessions', '--ws--', sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl'), '{"type":"header"}\n')
}

test('C1 /sessions 打出磁盘会话与 live 会话', async () => {
  const t = makeTmp('prts-sessions-cmd-')
  const dataRoot = join(t.dir, 'data')
  try {
    seedSession(dataRoot, 'sess-disk-1')
    const printed: string[] = []
    const deps: ChatDeps = {
      ctx: fakeCtx([{ session: { id: 'sess-live-1' } }]),
      lines: lines('/sessions', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'main-cmd-1',
    }
    const r = await runChat(deps)
    const text = printed.join('')
    assert.equal(r.turns, 0, '命令不产生模型回合')
    assert.match(text, /sess-disk-1/, `应列出磁盘会话，实际：${text}`)
    assert.match(text, /sess-live-1/, `应列出 live 会话，实际：${text}`)
  } finally { t.cleanup() }
})

test('C2 没有会话时给明确提示，不崩', async () => {
  const t = makeTmp('prts-sessions-cmd2-')
  const dataRoot = join(t.dir, 'data')
  try {
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx([]),
      lines: lines('/sessions', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'main-cmd-2',
    })
    assert.match(printed.join(''), /还没有会话记录/, '空表要有提示')
  } finally { t.cleanup() }
})
