/**
 * §G2 ④ 长时间未见 → 情感（DESIGN-06 S1/S2/S3/S5/S6）。
 *
 * 期望值全部手算、先于实现写定：纯函数边界、合成会话排除、链上去重、
 * 一次离别一条、重建不变。内部自检不算验证——这里每条都是独立对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  shouldWriteMiss, absenceReason, createAbsenceSignal, MISS_MOOD, ABSENCE_COMPONENT,
} from '../../src/runtime/emotion-absence.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { EmotionStore } from '../../src/emotion/index.ts'
import { makeTmp } from '../support/tmp.ts'

const HOUR = 3_600_000
const AFTER = 24 * HOUR
const T0 = 1_700_000_000_000

// ---------- S1 纯函数 ----------

test('AB1 阈值边界：恰好等于阈值不写，超过才写', () => {
  const base = { lastOwnerTurnAtMs: T0, lastMissAtMs: undefined, afterMs: AFTER }
  assert.equal(shouldWriteMiss({ ...base, nowMs: T0 + AFTER }), false, '恰好 24h 不算「超过」')
  assert.equal(shouldWriteMiss({ ...base, nowMs: T0 + AFTER + 1 }), true)
  assert.equal(shouldWriteMiss({ ...base, nowMs: T0 + AFTER - 1 }), false)
})

test('AB2 没见过 ≠ 离别：无博士发言记录不写', () => {
  assert.equal(shouldWriteMiss({ nowMs: T0 + 100 * HOUR, lastOwnerTurnAtMs: undefined, lastMissAtMs: undefined, afterMs: AFTER }), false)
})

test('AB3 超阈值且从没写过 → 写', () => {
  assert.equal(shouldWriteMiss({ nowMs: T0 + 25 * HOUR, lastOwnerTurnAtMs: T0, lastMissAtMs: undefined, afterMs: AFTER }), true)
})

test('AB4 一次离别一条：写过且博士未回来 → 不写（含同刻边界）', () => {
  const base = { nowMs: T0 + 100 * HOUR, lastOwnerTurnAtMs: T0, afterMs: AFTER }
  assert.equal(shouldWriteMiss({ ...base, lastMissAtMs: T0 + 25 * HOUR }), false, '离别已写过')
  assert.equal(shouldWriteMiss({ ...base, lastMissAtMs: T0 }), false, '同刻也算已写')
})

test('AB5 博士回来过、再次离别 → 再写；回来了但阈值内 → 不写', () => {
  const returned = T0 + 30 * HOUR // 博士在第一次想念之后回来过
  assert.equal(shouldWriteMiss({ nowMs: returned + 25 * HOUR, lastOwnerTurnAtMs: returned, lastMissAtMs: T0 + 25 * HOUR, afterMs: AFTER }), true)
  assert.equal(shouldWriteMiss({ nowMs: returned + 1 * HOUR, lastOwnerTurnAtMs: returned, lastMissAtMs: T0 + 25 * HOUR, afterMs: AFTER }), false)
})

test('AB6 reason 措辞：小时档 / 分钟档 / 不足一分钟兜底', () => {
  assert.equal(absenceReason(T0 + 25 * HOUR, T0), '博士已经 25 小时没出现')
  assert.equal(absenceReason(T0 + 30 * 60_000, T0), '博士已经 30 分钟没出现')
  assert.equal(absenceReason(T0 + 10_000, T0), '博士已经 1 分钟没出现')
})

// ---------- S2 数据源查询 ----------

function openMemory(prefix: string): { memory: MemoryStore; cleanup: () => void } {
  const t = makeTmp(prefix)
  const memory = MemoryStore.open(t.db())
  return { memory, cleanup: () => t.cleanup(memory) }
}

function say(memory: MemoryStore, sessionId: string, atMs: number | undefined, turnIndex = 0): string {
  return memory.recordTurn({
    actor: 'system', sessionId, turnIndex, speaker: 'user', text: `说话 ${sessionId} ${turnIndex}`,
    ...(atMs === undefined ? {} : { occurredAtMs: atMs }),
  })
}

test('AB7 混杂对照：时钟/子任务/已删/无时间戳都不算「博士来过」', () => {
  const { memory, cleanup } = openMemory('prts-absence-q1-')
  try {
    say(memory, 'sess-owner', T0)                    // 真实博士，最早
    say(memory, 'prts-clock-x1', T0 + 9 * HOUR)      // 时钟自己说话，最新
    say(memory, 'subtask-t1', T0 + 8 * HOUR)         // 子任务派工
    const deleted = say(memory, 'sess-owner', T0 + 7 * HOUR, 1)
    memory.forget([deleted])                          // 已删除的真实发言
    say(memory, 'sess-owner', undefined, 2)           // 时间戳缺失
    assert.equal(memory.lastOwnerTurnAtMs(), T0, '只能取真实、未删、有时间戳的最新一条')
  } finally {
    cleanup()
  }
})

test('AB8 空库 / 只有合成会话 → undefined', () => {
  const { memory, cleanup } = openMemory('prts-absence-q2-')
  try {
    assert.equal(memory.lastOwnerTurnAtMs(), undefined)
    say(memory, 'prts-clock-x1', T0)
    say(memory, 'subtask-t1', T0 + HOUR)
    assert.equal(memory.lastOwnerTurnAtMs(), undefined, '系统自言自语不算见面')
  } finally {
    cleanup()
  }
})

// ---------- S3 去重读法 ----------

test('AB9 lastEventAtMs：多生产者交错只取本 component 最新；没有则 undefined', () => {
  const t = makeTmp('prts-absence-e1-')
  const emotion = EmotionStore.open(t.db('emotion.sqlite'))
  try {
    assert.equal(emotion.lastEventAtMs(ABSENCE_COMPONENT), undefined)
    const sys = (component: string) => ({ kind: 'system', component }) as const
    emotion.update(sys('turn-end'), { valence: 0.12, arousal: 0.2, label: '顺利', reason: 'r', atMs: T0 })
    emotion.update(sys(ABSENCE_COMPONENT), { ...MISS_MOOD, reason: 'r', atMs: T0 + HOUR })
    emotion.update({ kind: 'owner' }, { valence: 0.5, arousal: 0.3, label: '开心', reason: 'r', atMs: T0 + 2 * HOUR })
    emotion.update(sys(ABSENCE_COMPONENT), { ...MISS_MOOD, reason: 'r', atMs: T0 + 3 * HOUR })
    assert.equal(emotion.lastEventAtMs(ABSENCE_COMPONENT), T0 + 3 * HOUR)
    assert.equal(emotion.lastEventAtMs('turn-end'), T0)
  } finally {
    t.cleanup(emotion)
  }
})

// ---------- S5 端到端（真实两库 + 判定 + 写入） ----------

interface Rig {
  memory: MemoryStore
  emotion: EmotionStore
  signal: (nowMs: number) => void
  emotionDbPath: string
  cleanup: () => void
}

function rig(prefix: string): Rig {
  const t = makeTmp(prefix)
  const memory = MemoryStore.open(t.db('memory.sqlite'))
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const signal = createAbsenceSignal({
    emotion,
    lastOwnerTurnAtMs: () => memory.lastOwnerTurnAtMs(),
    afterMs: AFTER,
    log: () => { /* 测试静音 */ },
  })
  return { memory, emotion, signal, emotionDbPath, cleanup: () => t.cleanup(memory, emotion) }
}

function emotionChain(path: string): Array<{ seq: number; actor_json: string; payload_json: string; ts: number }> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT seq, actor_json, payload_json, ts FROM emotion_events ORDER BY seq').all() as never
  } finally {
    db.close()
  }
}

test('AB10 一次离别一条：超阈值写一条，连续检查不重复；内容可追溯', () => {
  const r = rig('prts-absence-once-')
  try {
    say(r.memory, 'sess-owner', T0)
    r.signal(T0 + 25 * HOUR)
    r.signal(T0 + 26 * HOUR)
    r.signal(T0 + 48 * HOUR)
    const chain = emotionChain(r.emotionDbPath)
    assert.equal(chain.length, 1, '一次离别只写一条')
    const actor = JSON.parse(chain[0].actor_json) as { kind: string; component: string }
    assert.deepEqual(actor, { kind: 'system', component: 'long-absence' })
    const payload = JSON.parse(chain[0].payload_json) as { valence: number; arousal: number; label: string; reason: string }
    assert.equal(payload.label, '想念')
    assert.equal(payload.valence, MISS_MOOD.valence)
    assert.equal(payload.reason, '博士已经 25 小时没出现')
    assert.equal(chain[0].ts, T0 + 25 * HOUR)
  } finally {
    r.cleanup()
  }
})

test('AB11 博士回来后再离别 → 第二条；刚回来 → 不写', () => {
  const r = rig('prts-absence-return-')
  try {
    say(r.memory, 'sess-owner', T0)
    r.signal(T0 + 25 * HOUR)
    const returned = T0 + 30 * HOUR
    say(r.memory, 'sess-owner', returned, 1)
    r.signal(returned + HOUR) // 刚回来，阈值内
    assert.equal(emotionChain(r.emotionDbPath).length, 1)
    r.signal(returned + 25 * HOUR) // 再次离别
    const chain = emotionChain(r.emotionDbPath)
    assert.equal(chain.length, 2)
    assert.equal(chain[1].ts, returned + 25 * HOUR)
  } finally {
    r.cleanup()
  }
})

test('AB12 情绪库故障吞掉不抛：检查是增强不是闸门', () => {
  const r = rig('prts-absence-swallow-')
  try {
    say(r.memory, 'sess-owner', T0)
    r.emotion.close() // 制造写失败
    r.signal(T0 + 25 * HOUR) // 不抛即过
  } finally {
    r.cleanup()
  }
})

// ---------- S6 重建不变 ----------

test('AB13 两库重建后链逐字节不变，去重判定不变（不写第三条）', () => {
  const r = rig('prts-absence-rebuild-')
  try {
    say(r.memory, 'sess-owner', T0)
    r.signal(T0 + 25 * HOUR)
    const returned = T0 + 30 * HOUR
    say(r.memory, 'sess-owner', returned, 1)
    r.signal(returned + 25 * HOUR)
    const before = JSON.stringify(emotionChain(r.emotionDbPath))
    assert.equal(JSON.parse(before).length, 2)

    r.emotion.rebuildProjections()
    r.memory.rebuildProjections()
    assert.equal(JSON.stringify(emotionChain(r.emotionDbPath)), before, '情绪链逐字节不变')
    assert.equal(r.emotion.verifyChain().ok, true)
    assert.equal(r.memory.lastOwnerTurnAtMs(), returned, '重建后数据源判定不变')

    r.signal(returned + 26 * HOUR)
    assert.equal(emotionChain(r.emotionDbPath).length, 2, '重建后去重仍生效')
  } finally {
    r.cleanup()
  }
})