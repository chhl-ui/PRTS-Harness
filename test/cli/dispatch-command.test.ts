/**
 * `/dispatch` 命令的 CLI 级验收（Wave 3 分派器宿主入口）。
 *
 * 分派编排由 `test/runtime/dispatcher.test.ts` 钉住；这里只验接线：
 * 命令把任务交给 `dispatchTasks`，把 worker 摘要打到宿主输出，失败与未配置都明确报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import type { ChatDeps } from '../../src/cli/chat.ts'
import { Authority } from '../../src/authority/authority.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** fake agents：create 时把「子会话日志」写到磁盘（spawnSubtask 的摘要来源）。 */
function fakeCtx(opts: { dataRoot: string; fail?: boolean }): Context {
  return {
    get(name: string): unknown {
      if (name !== 'agents') return undefined
      return {
        async create(o: { sessionId?: unknown }): Promise<unknown> {
          const sid = String(o.sessionId ?? '')
          // 只有子会话（subtask-*）失败才模拟 worker 创建失败；主会话启动必须成功。
          if (opts.fail === true && sid.startsWith('subtask-')) throw new Error('create boom')
          const dir = join(opts.dataRoot, 'dsh-home', 'sessions', '--ws--', sid)
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'session.v4.jsonl'), JSON.stringify({
            type: 'assistant/message',
            seq: 1,
            data: { message: { content: [{ type: 'text', text: `摘要 ${sid}` }] } },
          }) + '\n')
          return {
            agent: { status: 'idle', followup(): void { /* noop */ } },
            dispose: async (): Promise<void> => { /* noop */ },
          }
        },
      }
    },
  } as unknown as Context
}

function env(opts: { fail?: boolean } = {}) {
  const t = makeTmp('prts-dispatch-cmd-')
  const ws = join(t.dir, 'ws')
  const data = join(t.dir, 'data')
  mkdirSync(ws, { recursive: true })
  mkdirSync(data, { recursive: true })
  const auth = Authority.open(t.db('core.sqlite'), { workspaceRoots: [ws], protectedRoots: [] })
  return {
    t, ws, data, auth,
    cleanup() { auth.close(); t.cleanup() },
  }
}

test('DC1 未配置 dispatch：明确报不可用，不静默忽略', async () => {
  const t = makeTmp('prts-dispatch-cmd1-')
  try {
    const printed: string[] = []
    const r = await runChat({
      ctx: fakeCtx({ dataRoot: join(t.dir, 'data') }),
      lines: lines('/dispatch 读十个文件', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'main-dc1',
    })
    assert.match(printed.join(''), /未配置分派器/)
    assert.equal(r.turns, 0, '命令不产生模型回合')
  } finally { t.cleanup() }
})

test('DC2 缺参：用法提示', async () => {
  const t = makeTmp('prts-dispatch-cmd2-')
  try {
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ dataRoot: join(t.dir, 'data') }),
      lines: lines('/dispatch', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'main-dc2',
    })
    assert.match(printed.join(''), /用法：\/dispatch/)
  } finally { t.cleanup() }
})

test('DC3 有 dispatch 但缺 authority：明确报不可用', async () => {
  const t = makeTmp('prts-dispatch-cmd3-')
  try {
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ dataRoot: join(t.dir, 'data') }),
      lines: lines('/dispatch 做事', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot: join(t.dir, 'data'),
      sessionId: 'main-dc3',
      dispatch: { workspace: t.dir, provider: 'p', model: 'm' },
    })
    assert.match(printed.join(''), /未配置分派器/)
  } finally { t.cleanup() }
})

test('DC4 成功：worker 摘要打到宿主输出，中间过程不回传', async () => {
  const e = env()
  try {
    const printed: string[] = []
    const r = await runChat({
      ctx: fakeCtx({ dataRoot: e.data }),
      lines: lines('/dispatch 读十个文件并汇总', '/exit'),
      out: (s) => printed.push(s),
      cwd: e.ws,
      dataRoot: e.data,
      sessionId: 'main-dc4',
      authority: e.auth,
      dispatch: { workspace: e.ws, provider: 'p', model: 'm' },
    })
    const text = printed.join('')
    assert.match(text, /分派完成（subtask-[A-Za-z0-9]+）/, `应报出 worker 会话，实际：${text}`)
    assert.match(text, /摘要 subtask-/, '应带 worker 摘要')
    assert.equal(r.turns, 0, '分派本身不产生主会话回合')
    assert.equal(e.auth.hasSessionScope('main-dc4'), true, '主会话身份不受影响')
  } finally { e.cleanup() }
})

test('DC5 失败：worker 创建失败时明确报错，不假装成功', async () => {
  const e = env({ fail: true })
  try {
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx({ dataRoot: e.data, fail: true }),
      lines: lines('/dispatch 做事', '/exit'),
      out: (s) => printed.push(s),
      cwd: e.ws,
      dataRoot: e.data,
      sessionId: 'main-dc5',
      authority: e.auth,
      dispatch: { workspace: e.ws, provider: 'p', model: 'm' },
    })
    assert.match(printed.join(''), /分派失败：create boom/)
  } finally { e.cleanup() }
})
