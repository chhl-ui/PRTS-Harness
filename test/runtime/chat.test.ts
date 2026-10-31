import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

test('prts chat: 一轮对话把助手文本输出到 out', { timeout: 120000 }, async () => {
  const t = makeTmp('chat-')
  mkdirSync(join(t.dir, 'data'), { recursive: true })
  mkdirSync(join(t.dir, 'ws'), { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot: join(t.dir, 'data'),
    workspace: join(t.dir, 'ws'),
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    scriptedLlmPlugin([{ text: '你好，我是 PRTS。' }]).apply(app.ctx as Context)
    const printed: string[] = []
    const r = await runChat({
      ctx: app.ctx as Context,
      lines: lines('hi', '/exit'),
      out: (s) => printed.push(s),
      cwd: join(t.dir, 'ws'),
      dataRoot: join(t.dir, 'data'),
    })
    console.log('[chat] turns=', r.turns, '| replies=', JSON.stringify(r.replies), '| printed=', JSON.stringify(printed))
    assert.equal(r.turns, 1, '应只跑一轮（/exit 前只有一条输入）')
    assert.ok(printed.length > 0, 'out 未被调用')
    assert.ok(printed.join('').includes('PRTS'), `未打印助手文本: ${JSON.stringify(printed)}`)
  } finally {
    await app.dispose()
    t.cleanup()
  }
})

/** 起一次独立运行时跑一遍对话，返回 out 收到的片段序列。 */
async function runOnce(
  script: Parameters<typeof scriptedLlmPlugin>[0],
  inputs: string[] = ['hi', '/exit'],
): Promise<{ printed: string[]; replies: string[] }> {
  const t = makeTmp('chat-')
  mkdirSync(join(t.dir, 'data'), { recursive: true })
  mkdirSync(join(t.dir, 'ws'), { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot: join(t.dir, 'data'),
    workspace: join(t.dir, 'ws'),
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    scriptedLlmPlugin(script).apply(app.ctx as Context)
    const printed: string[] = []
    const r = await runChat({
      ctx: app.ctx as Context,
      lines: lines(...inputs),
      out: (s) => printed.push(s),
      cwd: join(t.dir, 'ws'),
      dataRoot: join(t.dir, 'data'),
    })
    return { printed, replies: r.replies }
  } finally {
    await app.dispose()
    t.cleanup()
  }
}

test('prts chat: 碎片化文本按 delta 增量输出，out 被调用多次', { timeout: 120000 }, async () => {
  const { printed, replies } = await runOnce([{ textChunks: ['你好，', '我是 PRTS。'] }])
  console.log('[chat-stream] calls=', printed.length, '| printed=', JSON.stringify(printed), '| replies=', JSON.stringify(replies))
  assert.ok(printed.length >= 2, `增量输出未发生：out 只被调用 ${printed.length} 次，内容 ${JSON.stringify(printed)}`)
  assert.equal(printed.join(''), '你好，我是 PRTS。', `拼接结果不等于全文: ${JSON.stringify(printed)}`)
  assert.deepEqual(replies, ['你好，我是 PRTS。'], `replies 应存整段文本: ${JSON.stringify(replies)}`)
})

test('prts chat: 单段文本严格等于全文，不重复输出', { timeout: 120000 }, async () => {
  const { printed } = await runOnce([{ text: '你好，我是 PRTS。' }])
  console.log('[chat-single] printed=', JSON.stringify(printed))
  assert.equal(printed.join(''), '你好，我是 PRTS。', `出现重复或缺失: ${JSON.stringify(printed)}`)
})

test('prts chat: 事件不带 text-delta 时会话日志兜底仍然输出', { timeout: 120000 }, async () => {
  const { printed } = await runOnce([{ blockOnlyText: '你好，我是 PRTS。' }])
  console.log('[chat-fallback] printed=', JSON.stringify(printed))
  assert.equal(printed.join(''), '你好，我是 PRTS。', `兜底未生效或重复: ${JSON.stringify(printed)}`)
})
