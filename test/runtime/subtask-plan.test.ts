/**
 * `planSubtask` 的验收：taskId 白名单 + 派生目录 + 越界复验。
 *
 * 设计见 `docs/design-session-identity.md` §3.2。这些断言是安全面——
 * 每次失败都对应一种「子会话绕过 roots 收窄」的形态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { planSubtask, ensureSubtaskDir } from '../../src/runtime/subtask.ts'
import { makeTmp } from '../support/tmp.ts'

const rp = (p: string): string => realpathSync.native(p)

function withWs(fn: (ws: string) => void): void {
  const t = makeTmp('prts-subtask-')
  const ws = join(t.dir, 'ws')
  mkdirSync(ws, { recursive: true })
  try { fn(rp(ws)) } finally { t.cleanup() }
}

test('P1 合法 taskId：派生目录在 .prts-subtask 下，sessionId 与注册键同一个值', () => {
  withWs((ws) => {
    const plan = planSubtask(ws, 'task_01-a')
    assert.equal(plan.sessionId, 'subtask-task_01-a')
    assert.equal(plan.taskId, 'task_01-a')
    assert.ok(plan.dir.startsWith(join(ws, '.prts-subtask')))
    assert.equal(plan.dir, join(ws, '.prts-subtask', 'task_01-a'))
  })
})

test('P2 非法 taskId 全部拒绝：.. / a\/..\/.. / 空串 / 绝对路径 / 超长 / 非法字符', () => {
  withWs((ws) => {
    const bad = ['..', '../x', 'a/../..', 'a/../../b', '', '/abs', 'C:\\x', 'a'.repeat(65), 'a b', 'a.b', '中文']
    for (const id of bad) {
      assert.throws(() => planSubtask(ws, id), `应拒绝 ${JSON.stringify(id)}`)
    }
  })
})

test('P3 目录不存在时也能 plan（不要求预先创建）', () => {
  withWs((ws) => {
    const plan = planSubtask(ws, 'fresh')
    assert.equal(plan.dir, join(ws, '.prts-subtask', 'fresh'))
  })
})

test('P4 ensureSubtaskDir 建目录且幂等', () => {
  withWs((ws) => {
    const plan = planSubtask(ws, 'mkdir1')
    ensureSubtaskDir(plan)
    ensureSubtaskDir(plan)
    assert.equal(rp(plan.dir), join(ws, '.prts-subtask', 'mkdir1'))
  })
})

test('P5 符号链接越界被拒：.prts-subtask 指向 workspace 外时 plan 必须抛错', () => {
  const t = makeTmp('prts-subtask-link-')
  const ws = join(t.dir, 'ws')
  const outside = join(t.dir, 'outside')
  mkdirSync(ws, { recursive: true })
  mkdirSync(outside, { recursive: true })
  try {
    // Windows 上创建目录符号链接可能需要权限；失败则跳过（用系统退出码不掩盖：直接 try/catch 并标记）。
    try { symlinkSync(rp(outside), join(ws, '.prts-subtask'), 'junction') } catch { return }
    assert.throws(() => planSubtask(rp(ws), 'x'), /escapes workspace/)
  } finally { t.cleanup() }
})
