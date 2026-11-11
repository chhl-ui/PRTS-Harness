/**
 * 耦合边 ③ 归因纯函数（DESIGN-04 A2）：独立构造的事件序列对照。
 *
 * 不碰数据库——offers / outcomes 都是手写序列，期望值手算。
 * 内部自检不算验证：这里每条用例的期望先于实现写定，对照不过即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attribute } from '../../src/runtime/skill-attribution.ts'
import type { OfferRecord, SkillId } from '../../src/skills/index.ts'
import type { OutcomeRecord } from '../../src/runtime/skill-attribution.ts'

const sk = (n: string) => `sk-${n}` as SkillId
const offer = (skillId: SkillId, taskId?: string, sessionId = 'sess-1'): OfferRecord => ({
  skillId,
  sessionId,
  ...(taskId === undefined ? {} : { taskId }),
  ts: 1000,
})
const outcome = (taskId: string, outcomeKind: 'success' | 'failure', seq: number): OutcomeRecord => ({
  seq, taskId, outcome: outcomeKind, ts: 2000 + seq,
})

test('AT1 成功归因：在场技能 +1，episode 带账本 seq 可追溯', () => {
  const r = attribute([offer(sk('a'), 'task-1')], [outcome('task-1', 'success', 7)])
  const a = r.get(sk('a'))
  assert.ok(a !== undefined)
  assert.equal(a.success, 1)
  assert.equal(a.failure, 0)
  assert.deepEqual(a.episodes, [{ taskId: 'task-1', outcome: 'success', ts: 2007, ledgerSeq: 7 }])
})

test('AT2 失败归因：验收驳回记 failure，不记 success', () => {
  const r = attribute([offer(sk('a'), 'task-1')], [outcome('task-1', 'failure', 3)])
  const a = r.get(sk('a'))
  assert.ok(a !== undefined)
  assert.equal(a.success, 0)
  assert.equal(a.failure, 1)
})

test('AT3 先拒后收：一个任务两个回合，1 失败 + 1 成功', () => {
  const r = attribute(
    [offer(sk('a'), 'task-1')],
    [outcome('task-1', 'failure', 4), outcome('task-1', 'success', 9)],
  )
  const a = r.get(sk('a'))
  assert.ok(a !== undefined)
  assert.equal(a.success, 1)
  assert.equal(a.failure, 1)
  assert.equal(a.episodes.length, 2)
  assert.deepEqual(a.episodes.map((e) => e.ledgerSeq), [4, 9], '回合顺序跟账本 seq 走')
})

test('AT4 两技能同任务：各记一份（相关性，不做因果拆分）', () => {
  const r = attribute(
    [offer(sk('a'), 'task-1'), offer(sk('b'), 'task-1')],
    [outcome('task-1', 'success', 5)],
  )
  assert.equal(r.get(sk('a'))?.success, 1)
  assert.equal(r.get(sk('b'))?.success, 1)
})

test('AT5 无 taskId 的 offer 不归因：没绑任务 / 旧格式都算', () => {
  const r = attribute([offer(sk('a'))], [outcome('task-1', 'success', 5)])
  assert.equal(r.size, 0, '没有连接键就不主张关联')
})

test('AT6 有 offer 无结局：不出现在结果里（没回音 ≠ 回音是零）', () => {
  const r = attribute([offer(sk('a'), 'task-1')], [])
  assert.equal(r.size, 0)
})

test('AT7 同任务多条 offer 不重复计数：计数跟结局回合走', () => {
  const r = attribute(
    [offer(sk('a'), 'task-1'), offer(sk('a'), 'task-1', 'sess-2'), offer(sk('a'), 'task-1')],
    [outcome('task-1', 'success', 5)],
  )
  assert.equal(r.get(sk('a'))?.success, 1, '在场是布尔，不是 offer 条数')
  assert.equal(r.get(sk('a'))?.episodes.length, 1)
})

test('AT8 结局的任务没有任何 offer：不归因到任何技能', () => {
  const r = attribute([offer(sk('a'), 'task-other')], [outcome('task-1', 'success', 5)])
  assert.equal(r.size, 0)
})

test('AT9 多任务混合：各归各的，跨任务累加', () => {
  const r = attribute(
    [offer(sk('a'), 'task-1'), offer(sk('a'), 'task-2'), offer(sk('b'), 'task-2')],
    [outcome('task-1', 'failure', 2), outcome('task-2', 'success', 6), outcome('task-3', 'success', 8)],
  )
  assert.equal(r.get(sk('a'))?.success, 1)
  assert.equal(r.get(sk('a'))?.failure, 1)
  assert.equal(r.get(sk('b'))?.success, 1)
  assert.equal(r.get(sk('b'))?.failure, 0)
  assert.equal(r.has('sk-c' as SkillId), false)
})