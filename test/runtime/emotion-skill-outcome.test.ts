/**
 * DESIGN-05 S1：selectOutcomeMood 纯函数对照。
 *
 * 不碰数据库——offers 都是手写序列，期望值手算。
 * 内部自检不算验证：每条用例的期望先于实现写定，对照不过即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectOutcomeMood } from '../../src/runtime/emotion-skill-outcome.ts'
import type { OfferRecord, SkillId } from '../../src/skills/index.ts'

const sk = (n: string) => `sk-${n}` as SkillId
const offer = (skillId: SkillId, taskId?: string): OfferRecord => ({
  skillId,
  sessionId: 'sess-1',
  ...(taskId === undefined ? {} : { taskId }),
  ts: 1000,
})

test('SE1 在场 + 成功 → 欣慰，技能列全', () => {
  const r = selectOutcomeMood([offer(sk('a'), 'task-1')], 'task-1', 'success')
  assert.ok(r !== null)
  assert.deepEqual(r.mood, { valence: 0.5, arousal: 0.35, label: '欣慰' })
  assert.deepEqual(r.skillIds, [sk('a')])
})

test('SE2 在场 + 失败 → 失落（低唤醒，区别于受挫）', () => {
  const r = selectOutcomeMood([offer(sk('a'), 'task-1')], 'task-1', 'failure')
  assert.ok(r !== null)
  assert.deepEqual(r.mood, { valence: -0.35, arousal: 0.3, label: '失落' })
})

test('SE3 无 offer → null（回退既有 owner-feedback）', () => {
  assert.equal(selectOutcomeMood([], 'task-1', 'success'), null)
})

test('SE4 无 taskId 的 offer 不算在场', () => {
  assert.equal(selectOutcomeMood([offer(sk('a'))], 'task-1', 'success'), null)
})

test('SE5 他任务的 offer 不算在场', () => {
  assert.equal(selectOutcomeMood([offer(sk('a'), 'task-2')], 'task-1', 'success'), null)
})

test('SE6 同技能同任务多条 offer 去重', () => {
  const r = selectOutcomeMood(
    [offer(sk('a'), 'task-1'), offer(sk('a'), 'task-1')],
    'task-1', 'success',
  )
  assert.ok(r !== null)
  assert.deepEqual(r.skillIds, [sk('a')])
})

test('SE7 两技能同任务：都列出，按首次提供顺序', () => {
  const r = selectOutcomeMood(
    [offer(sk('b'), 'task-1'), offer(sk('a'), 'task-1'), offer(sk('b'), 'task-1')],
    'task-1', 'failure',
  )
  assert.ok(r !== null)
  assert.deepEqual(r.skillIds, [sk('b'), sk('a')])
})

test('SE8 混合序列：只算带本任务 taskId 的 offer', () => {
  const r = selectOutcomeMood(
    [offer(sk('a')), offer(sk('b'), 'task-2'), offer(sk('c'), 'task-1')],
    'task-1', 'success',
  )
  assert.ok(r !== null)
  assert.deepEqual(r.skillIds, [sk('c')])
})