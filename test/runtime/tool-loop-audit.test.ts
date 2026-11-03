/**
 * 循环检测落审计：把 suspect 从「一行 stderr」变成可查询的事实。
 *
 * ## 为什么要有
 *
 * `tool-loop-guard.ts` 现在只在 `start.ts` 里 `console.error` 一行。日志会滚掉、
 * 不能事后统计误报率——而「误报率是多少」正是决定要不要把它接进 `StopController`
 * 的唯一依据（`docs/design-superagent-fusion.md` 三-①）。所以先把判定落成审计事件。
 *
 * ## 两层分离
 *
 * - `ToolLoopGuard` 只负责判定（纯计数），通过 `onSuspect` 往外抛；
 * - `attachToolLoopAudit` 负责把判定写成审计事件，**审计 sink 用最小接口**
 *   （只要求 `append(actor, event)`），不把 `AuditLog` 拖进 guard 的依赖。
 *
 * 这样 guard 仍然可以在没有审计的场景下单独用，测试也不用起数据库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolLoopGuard, type LoopObservation } from '../../src/runtime/tool-loop-guard.ts'
import { attachToolLoopAudit } from '../../src/runtime/tool-loop-audit.ts'

const obs = (sessionId: string, toolName: string, args: unknown): LoopObservation => ({ sessionId, toolName, args })

/** 最小审计 sink：只记录收到的事件。真实实现是 `AuditLog.append(actor, event)`。 */
function fakeSink(): { append(actor: unknown, event: unknown): void; events: unknown[] } {
  const events: unknown[] = []
  return { events, append(_actor, event) { events.push(event) } }
}

test('LA1 达到阈值时写一条审计事件，含会话、工具与次数', () => {
  const sink = fakeSink()
  const guard = new ToolLoopGuard({ threshold: 3 })
  attachToolLoopAudit(guard, sink)
  const args = { path: 'a.ts' }
  for (let i = 0; i < 3; i++) guard.observe(obs('s1', 'read', args))

  assert.equal(sink.events.length, 1, '只写一条，不是每次观察都写')
  const event = sink.events[0] as { kind: string; sessionId: string; tool: string; count: number }
  assert.equal(event.kind, 'tool.loop.suspected')
  assert.equal(event.sessionId, 's1')
  assert.equal(event.tool, 'read')
  assert.equal(event.count, 3, '阈值那次的计数，事后能看出是第几次开始可疑')
})

test('LA2 未达阈值不写审计（1-2 次是正常重试）', () => {
  const sink = fakeSink()
  const guard = new ToolLoopGuard({ threshold: 3 })
  attachToolLoopAudit(guard, sink)
  const args = { path: 'a.ts' }
  guard.observe(obs('s1', 'read', args))
  guard.observe(obs('s1', 'read', args))
  assert.equal(sink.events.length, 0)
})

test('LA3 审计写失败不影响判定（观测不得成为新的失败面）', () => {
  const guard = new ToolLoopGuard({ threshold: 2 })
  attachToolLoopAudit(guard, {
    append() { throw new Error('audit chain broken') },
  })
  const args = { path: 'a.ts' }
  guard.observe(obs('s1', 'read', args))
  const verdict = guard.observe(obs('s1', 'read', args))
  assert.equal(verdict.kind, 'suspect', '判定照常返回，不因审计失败改变')
})

test('LA4 不同会话各自独立触发（计数按 sessionId 分桶）', () => {
  const sink = fakeSink()
  const guard = new ToolLoopGuard({ threshold: 3 })
  attachToolLoopAudit(guard, sink)
  const args = { path: 'a.ts' }
  guard.observe(obs('s1', 'read', args))
  guard.observe(obs('s2', 'read', args))
  guard.observe(obs('s1', 'read', args))
  guard.observe(obs('s2', 'read', args))
  assert.equal(sink.events.length, 0, '两个会话各 2 次，谁都没到 3')
  guard.observe(obs('s1', 'read', args))
  assert.equal(sink.events.length, 1)
  assert.equal((sink.events[0] as { sessionId: string }).sessionId, 's1')
})

test('LA5 解除订阅后不再写（dispose 幂等）', () => {
  const sink = fakeSink()
  const guard = new ToolLoopGuard({ threshold: 2 })
  const detach = attachToolLoopAudit(guard, sink)
  detach()
  detach() // 幂等
  const args = { path: 'a.ts' }
  for (let i = 0; i < 4; i++) guard.observe(obs('s1', 'read', args))
  assert.equal(sink.events.length, 0)
})
