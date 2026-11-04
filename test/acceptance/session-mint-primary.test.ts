/**
 * 主会话注册接线（设计见 `docs/design-session-identity.md` §3.2）。
 *
 * 存在理由：`Authority.registerPrimarySession` 与查询 API 已实现，但终端入口
 * `runChat` 从不调用它——「谁是主会话」在真实会话里永远是空记录。本文件钉住接线：
 * `agents.create` 成功之后、主循环开始之前必须注册；注册抛错则 fail-closed
 * （报错并退出，不进主循环）。
 *
 * 覆盖面：用最小 fake ctx（只实现 `get('agents')`，不挂 events）+ 真实 Authority
 * （临时目录）驱动真正的 `runChat`，因此覆盖的是接线本身，不是被抽出来的替身函数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Authority } from '../../src/authority/authority.ts'
import { runChat } from '../../src/cli/chat.ts'
import type { ChatDeps } from '../../src/cli/chat.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface FakeAgent {
  status: string
  followup(m: unknown): void
}

/** 最小假 ctx：runChat 只经 `ctx.get('agents')` 取 agents，events 缺失时按无订阅处理。 */
function fakeCtx(agent: FakeAgent, seen: { created: unknown[] }): Context {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        async create(o: unknown): Promise<{ agent: FakeAgent }> {
          seen.created.push(o)
          return { agent }
        },
      }
    },
  } as unknown as Context
}

test('主会话注册①：agents.create 成功后即注册，会话有作用域且不是子会话', async () => {
  const t = makeTmp('prts-mint-primary-')
  const dataRoot = join(t.dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const auth = Authority.open(t.db('core.sqlite'), { workspaceRoots: [], protectedRoots: [] })
  const printed: string[] = []
  const seen = { created: [] as unknown[] }
  const followups: unknown[] = []
  try {
    const deps: ChatDeps = {
      ctx: fakeCtx({ status: 'idle', followup: (m) => followups.push(m) }, seen),
      lines: lines('/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'main-mint-1',
      authority: auth,
    }
    // 调用前没有身份记录：证明 later 的 true 来自 runChat 的接线。
    assert.equal(auth.hasSessionScope('main-mint-1'), false)

    const result = await runChat(deps)

    assert.equal(result.turns, 0, '/exit 不产生回合')
    assert.equal(seen.created.length, 1, 'agents.create 应被调用一次')
    assert.equal(
      (seen.created[0] as { sessionId?: string }).sessionId,
      'main-mint-1',
      '创建的会话 id 应与注册的 id 同一个',
    )
    assert.equal(auth.hasSessionScope('main-mint-1'), true, '主会话必须已注册')
    assert.equal(auth.isSubagentSession('main-mint-1'), false, '主会话不是子会话')
    assert.equal(followups.length, 0, '/exit 不应触发模型回合')
    assert.equal(printed.join(''), '', '正常路径不应有报错输出')
  } finally {
    auth.close()
    t.cleanup()
  }
})

test('主会话注册②：注册抛错时 fail-closed——报错并退出，不进入主循环', async () => {
  const t = makeTmp('prts-mint-primary-bad-')
  const dataRoot = join(t.dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const printed: string[] = []
  const seen = { created: [] as unknown[] }
  const followups: unknown[] = []
  try {
    const deps: ChatDeps = {
      ctx: fakeCtx({ status: 'idle', followup: (m) => followups.push(m) }, seen),
      // 即便有一行普通输入，也不能被消费：说明主循环没开始。
      lines: lines('你好', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'main-mint-2',
      // 只读库的真实形态在这里用替身模拟：注册必定抛 READ_ONLY。
      authority: {
        hasSessionScope(): boolean { return false },
        registerPrimarySession(): void {
          throw new Error('READ_ONLY')
        },
      } as unknown as Authority,
    }

    const result = await runChat(deps)

    assert.equal(result.turns, 0, '注册失败不应产生回合')
    assert.deepEqual(result.replies, [])
    assert.equal(seen.created.length, 1, 'agents.create 已成功执行')
    assert.equal(followups.length, 0, '不能进入主循环（否则用户输入会被当成模型回合）')
    const text = printed.join('')
    assert.ok(text.includes('会话身份注册失败'), `应报出注册失败，实际输出：${JSON.stringify(text)}`)
    assert.ok(text.includes('READ_ONLY'), `错误原因要透出，实际输出：${JSON.stringify(text)}`)
  } finally {
    t.cleanup()
  }
})
