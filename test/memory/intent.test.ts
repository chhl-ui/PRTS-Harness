/**
 * V1-14 前瞻记忆 · W1：意图的持久化与状态机。
 *
 * 验收原文：「10 条带时间或事件条件的意图，到期后全部按时触发；重启不丢失；
 * 取消的意图不再触发。」本文件覆盖后两条的存储层，触发由 W3 的调度器负责。
 *
 * 设计依据（`docs/design-intent-memory-v1-14.md`）：意图是事件、状态是投影，
 * 与记忆模块同构——重启不丢失因此是免费的（事件已在链上）。
 *
 * 时间语义已定案为**方案 B**（进程内定时 + 启动补触发）：`fire_at_ms` 是「应该触发」的
 * 时刻，实际触发时刻记在 `fired_at_ms`，两者分开存，补发时能如实告知延迟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const intent = (fireAtMs: number, over: { action?: string; conditionRaw?: string } = {}): {
  actor: 'owner'
  conditionRaw: string
  fireAtMs: number
  action: string
} => ({
  actor: 'owner',
  conditionRaw: over.conditionRaw ?? '三天后',
  fireAtMs,
  action: over.action ?? '提醒我交报告',
})

test('N1 createIntent 写事件并投影为 pending', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const id = store.createIntent(intent(now + 3 * HOUR))
    const list = store.listIntents()
    assert.equal(list.length, 1)
    assert.equal(list[0].intentId, id)
    assert.equal(list[0].status, 'pending')
    assert.equal(list[0].fireAtMs, now + 3 * HOUR)
    assert.equal(list[0].conditionRaw, '三天后', '原话必须原样保留——模型解析错时用户要能看出来')
    assert.equal(list[0].firedAtMs, null)
  } finally { t.cleanup(store) }
})

test('N2 时间校验：过近 / 过远 / 非有限数一律拒绝', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    assert.throws(() => store.createIntent(intent(now - HOUR)), /过去|已过|必须/, '过去的时间必须拒绝')
    assert.throws(() => store.createIntent(intent(now + 1000)), /过近|太近|至少/, '太近的时间会与当前会话撞车')
    assert.throws(() => store.createIntent(intent(now + 3 * 365 * DAY)), /过远|太远|最多/, '过远的意图没有意义')
    assert.throws(() => store.createIntent(intent(Number.NaN)), /非法|无效|NaN/)
    assert.equal(store.listIntents().length, 0, '被拒绝的意图不能留下痕迹')
  } finally { t.cleanup(store) }
})

test('N3 cancelIntent 后状态变 cancelled，且不再进 due', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const id = store.createIntent(intent(now + MIN * 10))
    store.cancelIntent({ actor: 'owner', intentId: id })
    const row = store.listIntents()[0]
    assert.equal(row.status, 'cancelled')
    assert.equal(store.dueIntents(now + DAY).length, 0, '取消的意图永远不进 due')
  } finally { t.cleanup(store) }
})

test('N4 dueIntents 只返回 pending 且已到点的，按时间升序', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const soon = store.createIntent(intent(now + MIN * 5, { action: '早' }))
    const later = store.createIntent(intent(now + MIN * 30, { action: '晚' }))
    const far = store.createIntent(intent(now + DAY * 3, { action: '很远' }))

    const due = store.dueIntents(now + MIN * 20)
    assert.deepEqual(due.map((d) => d.intentId), [soon], '只该有已到点的那条')
    const all = store.dueIntents(now + DAY * 4)
    assert.deepEqual(all.map((d) => d.intentId), [soon, later, far], '按 fire_at 升序，别让晚的插队')
  } finally { t.cleanup(store) }
})

test('N5 markFired 记实际触发时刻，之后不再进 due', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const fireAt = now + MIN * 5
    const id = store.createIntent(intent(fireAt))
    const actual = fireAt + MIN * 3 // 进程不在，补触发晚 3 分钟
    store.markFired({ actor: 'system', intentId: id, firedAtMs: actual })
    const row = store.listIntents()[0]
    assert.equal(row.status, 'fired')
    assert.equal(row.firedAtMs, actual, '实际触发时刻与计划时刻分开存，补发时才说得清延迟')
    assert.equal(store.dueIntents(now + DAY).length, 0)
  } finally { t.cleanup(store) }
})

test('N6 重开 store 后意图仍在（事件链 + 投影，重启不丢失）', () => {
  const t = makeTmp('prts-intent-')
  const path = t.db()
  const now = Date.now()
  const first = MemoryStore.open(path)
  let id = ''
  try {
    id = first.createIntent(intent(now + HOUR))
  } finally { first.close() }

  const second = MemoryStore.open(path)
  try {
    const list = second.listIntents()
    assert.equal(list.length, 1)
    assert.equal(list[0].intentId, id)
    assert.equal(list[0].status, 'pending')
    // 事件链没断：重开时 verifyChain 也要通过
    assert.equal(second.verifyChain().ok, true)
  } finally { second.close(); t.cleanup() }
})

test('N7 取消已 fired 的意图必须拒绝（状态机不允许倒退）', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const id = store.createIntent(intent(now + MIN * 5))
    store.markFired({ actor: 'system', intentId: id, firedAtMs: now + MIN * 6 })
    assert.throws(() => store.cancelIntent({ actor: 'owner', intentId: id }), /已触发|状态/, '触发过的不能再取消')
  } finally { t.cleanup(store) }
})

test('N8 重复取消幂等或明确报错，不能产生第二个 cancelled 事件', () => {
  const t = makeTmp('prts-intent-')
  const store = MemoryStore.open(t.db())
  try {
    const now = Date.now()
    const id = store.createIntent(intent(now + HOUR))
    store.cancelIntent({ actor: 'owner', intentId: id })
    const before = store.listIntents()[0]
    // 第二次取消：允许幂等成功，或抛错；但状态与时间戳不能被改写
    try { store.cancelIntent({ actor: 'owner', intentId: id }) } catch { /* 明确报错也可接受 */ }
    const after = store.listIntents()[0]
    assert.equal(after.status, 'cancelled')
    assert.equal(after.cancelledAtMs, before.cancelledAtMs, '重复取消不能改写已记录的时刻')
  } finally { t.cleanup(store) }
})
