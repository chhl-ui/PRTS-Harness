/** P0-2a 入口层：/memory /forget /correct 斜杠命令 + 工具面负向断言。 */
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

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

async function* lines(...xs: string[]): AsyncIterable<string> { for (const x of xs) yield x }

test('chat: /memory /forget /correct 走所有者通道，不发模型不落记忆', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-memcmd-')
  mkdirSync(join(t.dir, 'data'), { recursive: true })
  mkdirSync(join(t.dir, 'ws'), { recursive: true })
  const app = await startRuntime({
    configPath: prtsYml, dataRoot: join(t.dir, 'data'), workspace: join(t.dir, 'ws'),
    mode: 'normal', patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  try {
    // 工具面负向：不含 forget/correct 语义的工具名
    assert.equal(app.toolNames.filter(n => /forget|correct|delete/i.test(n)).length, 0,
      `工具面不得出现删除/纠正语义：${JSON.stringify(app.toolNames)}`)

    const store = app.memory!
    const factId = store.assertFact({ actor: 'owner', subject: '博士', predicate: '偏好', object: '猫头鹰5567 器材', provenance: 'stated', confirmationBasis: 'owner-stated' })
    scriptedLlmPlugin([{ text: 'unused' }]).apply(app.ctx as Context)

    const printed: string[] = []
    const r = await runChat({
      ctx: app.ctx as Context,
      lines: lines(
        '/memory 猫头鹰5567',
        `/forget ${factId}`,
        `/forget ${factId} --yes`,
        `/correct ${factId} 会报错因为已删`,
        '/exit',
      ),
      out: (s) => printed.push(s),
      cwd: join(t.dir, 'ws'),
      dataRoot: join(t.dir, 'data'),
      memory: store,
      dbPath: app.dbPath,
    })
    const text = printed.join('')
    assert.equal(r.turns, 0, `斜杠命令不得触发模型回合：${r.turns}`)
    assert.ok(text.includes(factId), `/memory 应列出命中：${text.slice(0, 300)}`)
    assert.ok(text.includes('删除计划') || text.includes('未执行'), `/forget 计划态：${text.slice(0, 300)}`)
    assert.ok(text.includes('已删除'), `/forget --yes 执行态：${text.slice(0, 300)}`)
    assert.ok(text.includes('不存在或已删除'), `/correct 已删 id 报错：${text.slice(0, 300)}`)
    // 不落记忆：斜杠行不产生 user turn
    const leftover = store.search({ text: '/memory', limit: 5 })
    assert.equal(leftover.length, 0, '斜杠行不得落记忆 turn')
    assert.equal(store.search({ text: '猫头鹰5567', limit: 5 }).length, 0, 'fact 已删')
    // dbPath 缺失时 /forget --yes 拒绝执行且目标不丢
    const fact2 = store.assertFact({ actor: 'owner', subject: '博士', predicate: '偏好', object: '丹顶鹤9902 器材', provenance: 'stated', confirmationBasis: 'owner-stated' })
    const printed2: string[] = []
    await runChat({
      ctx: app.ctx as Context,
      lines: lines(`/forget ${fact2} --yes`, '/exit'),
      out: (s) => printed2.push(s),
      cwd: join(t.dir, 'ws'),
      dataRoot: join(t.dir, 'data'),
      memory: store,
      // dbPath 故意不传
    })
    assert.ok(printed2.join('').includes('拒绝') || printed2.join('').includes('dbPath'),
      `缺 dbPath 时应打印拒绝：${printed2.join('').slice(0, 200)}`)
    assert.ok(store.search({ text: '丹顶鹤9902', limit: 5 }).length > 0, '目标不得被删')
  } finally {
    await app.dispose()
    t.cleanup()
  }
})
