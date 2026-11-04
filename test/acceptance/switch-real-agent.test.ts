/**
 * `/switch` 的真机端到端验收（设计 R 波：「两会话并存不串话」「/switch 后消息进对的 agent」）。
 *
 * 与 `test/cli/switch-command.test.ts` 的分工：那边用 fake agents 验命令分支与状态复位，
 * 这里用真实 `startRuntime` + scripted LLM 验**消息真的进了目标会话的 agent**。
 *
 * 判据是 **assistant/message 的归属**，不是「日志里出现某文本」：
 * `session-recall` 会把更早会话的近期对话作为 user 消息注入新会话（设计内的跨会话召回），
 * 用 includes 会把召回内容误判成串话。model 产出只应出现在自己 sessionId 的日志里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

/** 递归找所有 session.v4.jsonl（DSH 的会话目录带 cwd 前缀，路径不可预测）。 */
function findSessionFiles(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (e === 'session.v4.jsonl') out.push(p)
      } catch { /* 遍历间隙被原子替换 */ }
    }
  }
  walk(root)
  return out
}

/** 某个会话的完整日志文本（按路径包含 sessionId 归属）。 */
function transcriptFor(dataRoot: string, sessionId: string): string {
  let text = ''
  for (const f of findSessionFiles(join(dataRoot, 'dsh-home', 'sessions'))) {
    if (!f.includes(sessionId)) continue
    try { text += readFileSync(f, 'utf8') } catch { /* 正在写 */ }
  }
  return text
}

/** 提取日志里所有 assistant/message 的文本（model 产出，不含召回注入的 user 消息）。 */
function assistantTexts(log: string): string[] {
  const out: string[] = []
  for (const line of log.split('\n')) {
    if (!line.trim()) continue
    let rec: {
      type?: string
      data?: { message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }
    }
    try { rec = JSON.parse(line) } catch { continue }
    if (rec.type !== 'assistant/message') continue
    const text = (rec.data?.message?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    if (text !== '') out.push(text)
  }
  return out
}

/** 会话日志落盘晚于回合结束：轮询到 model 产出条数达到期望为止。 */
async function transcriptAfterTurns(
  dataRoot: string,
  sessionId: string,
  turns: number,
  ms = 8000,
): Promise<string> {
  const t0 = Date.now()
  let out = transcriptFor(dataRoot, sessionId)
  while (Date.now() - t0 < ms && assistantTexts(out).length < turns) {
    await new Promise((r) => setTimeout(r, 50))
    out = transcriptFor(dataRoot, sessionId)
  }
  return out
}

interface CreatedAgent {
  agent: { status: string; followup(m: unknown): void }
  dispose(): Promise<void>
}

function agentsOf(ctx: Context): { create(o: unknown): Promise<CreatedAgent> } {
  return ctx.get('agents') as unknown as { create(o: unknown): Promise<CreatedAgent> }
}

function makeWorkspace(t: ReturnType<typeof makeTmp>): { dataRoot: string; ws: string } {
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  return { dataRoot, ws }
}

test('真机①：/switch 后消息进入目标会话（model 产出归属）', { timeout: 180000 }, async () => {
  const t = makeTmp('switch-real-1-')
  const { dataRoot, ws } = makeWorkspace(t)
  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: PATCHES,
  })
  try {
    scriptedLlmPlugin([{ text: 'B-回复' }]).apply(app.ctx as Context)
    const handle = await agentsOf(app.ctx).create({
      sessionId: 'sess-b',
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
    try {
      await runChat({
        ctx: app.ctx as Context,
        lines: lines('/switch sess-b', 'hello-b', '/exit'),
        out: () => {},
        cwd: ws,
        dataRoot,
        sessionId: 'sess-a',
        authority: app.authority,
      })
      const bLog = await transcriptAfterTurns(dataRoot, 'sess-b', 1)
      assert.deepEqual(assistantTexts(bLog), ['B-回复'], '切换后 model 产出应落在 sess-b')
      const aLog = transcriptFor(dataRoot, 'sess-a')
      assert.deepEqual(assistantTexts(aLog), [], 'sess-a 不应产生 model 产出')
    } finally {
      await handle.dispose()
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

test('真机②：两会话并存不串话——两轮 model 产出各落自己的日志', { timeout: 180000 }, async () => {
  const t = makeTmp('switch-real-2-')
  const { dataRoot, ws } = makeWorkspace(t)
  const app = await startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: PATCHES,
  })
  try {
    scriptedLlmPlugin([{ text: 'A-回复' }, { text: 'B-回复' }]).apply(app.ctx as Context)
    const handle = await agentsOf(app.ctx).create({
      sessionId: 'sess-b',
      meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
    try {
      const r = await runChat({
        ctx: app.ctx as Context,
        lines: lines('hello-a', '/switch sess-b', 'hello-b', '/exit'),
        out: () => {},
        cwd: ws,
        dataRoot,
        sessionId: 'sess-a',
        authority: app.authority,
      })
      assert.deepEqual(r.replies, ['A-回复', 'B-回复'], '两轮回复应分别来自两个会话')

      const aLog = await transcriptAfterTurns(dataRoot, 'sess-a', 1)
      const bLog = await transcriptAfterTurns(dataRoot, 'sess-b', 1)
      assert.deepEqual(assistantTexts(aLog), ['A-回复'], 'sess-a 的 model 产出归属错误（串话）')
      assert.deepEqual(assistantTexts(bLog), ['B-回复'], 'sess-b 的 model 产出归属错误（串话）')
    } finally {
      await handle.dispose()
    }
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
