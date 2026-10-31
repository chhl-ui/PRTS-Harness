/**
 * W0：runtime 必须自己持有 Ledger 句柄。
 *
 * 现状是 `grep Ledger src/runtime/start.ts` = 0——没有句柄，后面的
 * tools/execute 记账、任务入口、启动线索全部无处安放。
 *
 * 两条断言：
 *  (a) startRuntime 返回的对象暴露 ledger，且能读（open 用的是与 supervisor 同一个 core.sqlite）
 *  (b) dispose 之后 sqlite 连接已关闭——Windows 上不关会锁文件，临时目录清理报 EPERM
 *      （Authority 已经踩过这个坑，见 start.ts 的 authority.close()）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { makeTmp } from '../support/tmp.ts'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

test('W0: startRuntime 暴露 ledger，dispose 后连接已关闭', { timeout: 120000 }, async () => {
  const t = makeTmp('ledger-wire-')
  const dataRoot = join(t.dir, 'data')
  const ws = join(t.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })

  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
  let opened = false
  try {
    assert.ok('ledger' in app, 'startRuntime 的返回值里没有 ledger')
    assert.ok(app.ledger !== undefined, 'ledger 是 undefined')
    // 句柄可用：空账本应当能读，且库文件落在 <dataRoot>/core.sqlite（与 supervisor.ts:62 一致）
    assert.deepEqual(app.ledger.list(), [], '新库应当是空任务列表')
    assert.ok(existsSync(join(dataRoot, 'core.sqlite')), 'core.sqlite 未在 dataRoot 下创建')
    opened = true
  } finally {
    await app.dispose()
    // 连接没关时 rmSync 会 EPERM，cleanup 抛出即说明 (b) 不成立
    t.cleanup()
  }
  assert.equal(opened, true)
})
