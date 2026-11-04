/**
 * W3 任务提醒 —— 存储层验收（设计见 `docs/design-superagent-fusion.md` §三 ③）。
 *
 * 要解决的是：任务 `blocked` 或交上来等验收（`verifying`）停太久，没人记得。
 * 「提醒一次」的语义要求**跨进程只一次**——进程内集合不够，重启就忘。
 * 所以留痕必须落库，这一层测的就是它。
 *
 * 基线预期：`src/reminders/` 尚不存在，本文件 import 失败 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openReminderStore } from '../../src/reminders/index.ts'
import { makeTmp } from '../support/tmp.ts'

function fresh() {
  const t = makeTmp('prts-reminder-s-')
  const store = openReminderStore(t.db('reminders.sqlite'))
  return { t, store }
}

test('RS1 空库：没有任何留痕', () => {
  const { t, store } = fresh()
  try {
    assert.deepEqual(store.list(), [])
    assert.equal(store.wasNotified('task-1', 'blocked'), false)
  } finally { store.close(); t.cleanup() }
})

test('RS2 记录一次提醒：字段完整可查', () => {
  const { t, store } = fresh()
  try {
    const now = 1_700_000_000_000
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: now })
    const rows = store.list()
    assert.equal(rows.length, 1)
    const r = rows[0]!
    assert.equal(r.taskId, 'task-1')
    assert.equal(r.kind, 'blocked')
    assert.equal(r.notifiedAtMs, now)
    assert.equal(typeof r.id, 'number')
  } finally { store.close(); t.cleanup() }
})

test('RS3 wasNotified 按 taskId + kind 隔离', () => {
  const { t, store } = fresh()
  try {
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: 1 })
    assert.equal(store.wasNotified('task-1', 'blocked'), true)
    assert.equal(store.wasNotified('task-2', 'blocked'), false, '别的任务不算')
    assert.equal(store.wasNotified('task-1', 'verifying'), false, '同一任务另一种提醒不算')
  } finally { store.close(); t.cleanup() }
})

test('RS4 只追加：同一提醒记录两次保留两条（轨迹不被覆盖）', () => {
  const { t, store } = fresh()
  try {
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: 1 })
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: 2 })
    assert.equal(store.list().length, 2)
  } finally { store.close(); t.cleanup() }
})

test('RS5 lastNotifiedAt：返回最近一次，没提醒过返回 undefined', () => {
  const { t, store } = fresh()
  try {
    assert.equal(store.lastNotifiedAt('task-1', 'blocked'), undefined)
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: 100 })
    store.record({ taskId: 'task-1', kind: 'blocked', notifiedAtMs: 200 })
    assert.equal(store.lastNotifiedAt('task-1', 'blocked'), 200, '取最近一条')
    assert.equal(store.lastNotifiedAt('task-1', 'verifying'), undefined, '另一种 kind 不算')
    assert.equal(store.lastNotifiedAt('task-2', 'blocked'), undefined, '别的任务不算')
  } finally { store.close(); t.cleanup() }
})
