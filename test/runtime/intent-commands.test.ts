/**
 * V1-14 · `/intent` 所有者命令。
 *
 * 为什么取消必须在所有者通道：删掉一条已承诺的提醒是破坏性动作，模型面不注册
 * （`intent-tools.ts` 只给 create/list）。这条命令是它唯一的入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { startRuntime } from '../../src/runtime/start.ts'
import { runChat } from '../../src/cli/chat.ts'
import { makeTmp } from '../support/tmp.ts'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> { for (const x of xs) yield x }

test('chat: /intent 列出、取消意图，取消后不再出现在 pending', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-intentcmd-')
  mkdirSync(join(t.dir, 'data'), { recursive: true })
  mkdirSync(join(t.dir, 'ws'), { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml, dataRoot: join(t.dir, 'data'), workspace: join(t.dir, 'ws'),
    mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    const store = app.memory!
    const now = Date.now()
    const keep = store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '保留的提醒', fireAtMs: now + 3600_000 })
    const drop = store.createIntent({ actor: 'owner', conditionRaw: '后天', action: '要取消的提醒', fireAtMs: now + 7200_000 })

    const printed: string[] = []
    await runChat({
      ctx: app.ctx as Context,
      lines: lines(
        '/intent',
        `/intent cancel ${drop.slice(0, 10)}`,
        '/intent',
        '/intent --all',
        '/intent bogus',
        '/exit',
      ),
      out: (s) => printed.push(s),
      cwd: join(t.dir, 'ws'),
      dataRoot: join(t.dir, 'data'),
      memory: store,
      dbPath: app.dbPath,
    })
    const text = printed.join('')

    assert.match(text, /保留的提醒/, '第一条必须列出')
    assert.match(text, /要取消的提醒/, '取消前列出两条')
    assert.match(text, /已取消/, '取消要有明确回执')
    assert.match(text, /明天/, '原话回显')

    // 取消后 pending 只剩一条
    const pending = store.listIntents({ status: 'pending' })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].intentId, keep)
    assert.equal(store.listIntents({ status: 'cancelled' })[0].intentId, drop, '前缀匹配要能定位到正确那条')

    // --all 能看到 cancelled 的那条
    assert.match(text, /cancelled/, '--all 应列出已取消的状态')
    // 未知子命令给用法
    assert.match(text, /用法/, '未知子命令必须回用法，不能静默什么都不做')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
