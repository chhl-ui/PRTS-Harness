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
