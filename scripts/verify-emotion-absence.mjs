#!/usr/bin/env node
/**
 * 耦合边「长时间未见 → 情感」：真实组件验证（DESIGN-06 S7）。
 *
 * 真实 MemoryStore + EmotionStore + attachWakeClock + createAbsenceSignal，
 * 临时目录（生产零写），时钟可注入。零模型调用——④ 路径上无模型，不烧 token。
 *
 * 对照链：阈值内不写 → 超阈值写一条 → 重复 tick 不重复 → 合成会话不算见面 →
 * 博士回来不写 → 再离别第二条 → deliver 全程零调用（只写情绪不说话）→
 * 重开库去重仍在 → 两库重建链逐字节不变 + verifyChain。
 * 任何一步对照不过 exit(1)。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-emotion-absence.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'
import { EmotionStore } from 'file:///C:/prts-system/src/emotion/index.ts'
import { attachWakeClock } from 'file:///C:/prts-system/src/runtime/wake-clock.ts'
import { createAbsenceSignal } from 'file:///C:/prts-system/src/runtime/emotion-absence.ts'

const HOUR = 3_600_000
const T0 = 1_700_000_000_000

function check(ok, label, detail = '') {
  if (!ok) {
    console.error(`FAIL: ${label}${detail === '' ? '' : ` —— ${detail}`}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

const dataRoot = mkdtempSync(join(tmpdir(), 'prts-absence-verify-'))
console.log(`临时 dataRoot：${dataRoot}`)

const memPath = join(dataRoot, 'memory.sqlite')
const emoPath = join(dataRoot, 'emotion.sqlite')
let memory = MemoryStore.open(memPath)
let emotion = EmotionStore.open(emoPath)

let nowMs = T0
let deliverCalls = 0
const clock = attachWakeClock({
  collectDue: () => [], // 没有任何「要说的事」：说话路径全程不该被走到
  deliver: async () => { deliverCalls += 1; throw new Error('④ 路径不得投递') },
  onTick: createAbsenceSignal({
    emotion,
    lastOwnerTurnAtMs: () => memory.lastOwnerTurnAtMs(),
    afterMs: 24 * HOUR,
    log: () => {},
  }),
  now: () => nowMs,
  log: () => {},
})

function missRows() {
  const db = new DatabaseSync(emoPath, { readOnly: true })
  try {
    return db.prepare(
      `SELECT seq, actor_json, payload_json, ts FROM emotion_events
        WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = 'long-absence'
        ORDER BY seq`,
    ).all()
  } finally { db.close() }
}

const say = (sessionId, atMs, turnIndex) => memory.recordTurn({
  actor: 'system', sessionId, turnIndex, speaker: 'user',
  text: `说话 ${sessionId} ${turnIndex}`, occurredAtMs: atMs,
})

async function tickAt(ms) {
  nowMs = ms
  const fired = await clock.tick()
  check(fired.length === 0, `tick(${(ms - T0) / HOUR}h) 无投递`, JSON.stringify(fired))
}

try {
  // 1. 没见过 ≠ 离别；阈值内不写。
  await tickAt(T0 + HOUR)
  check(missRows().length === 0, '无博士记录：不写')
  say('sess-owner', T0, 0)
  await tickAt(T0 + HOUR)
  check(missRows().length === 0, '阈值内（1h < 24h）：不写')

  // 2. 超阈值写一条，内容可追溯。
  await tickAt(T0 + 25 * HOUR)
  let rows = missRows()
  check(rows.length === 1, '超阈值：写一条想念', `实际 ${rows.length}`)
  const actor = JSON.parse(rows[0].actor_json)
  check(actor.kind === 'system' && actor.component === 'long-absence',
    'actor 固定 system{long-absence}', rows[0].actor_json)
  const p0 = JSON.parse(rows[0].payload_json)
  check(p0.label === '想念' && p0.valence === -0.15 && p0.arousal === 0.25,
    'mood -0.15/0.25 想念', rows[0].payload_json)
  check(p0.reason === '博士已经 25 小时没出现', 'reason 时长措辞', p0.reason)
  check(rows[0].ts === T0 + 25 * HOUR, 'ts 即 tick 时刻')

  // 3. 一次离别一条：博士没回来，连续 tick 不重复。
  await tickAt(T0 + 26 * HOUR)
  check(missRows().length === 1, '重复 tick：不重复写')

  // 4. 合成会话污染对照：时钟自己 26h 时的发言不算「博士来过」。
  //    若被计入，51h 这次 tick 会误判「上次见面 26h、已隔 25h」而写第二条。
  say('prts-clock-x1', T0 + 26 * HOUR, 0)
  await tickAt(T0 + 51 * HOUR)
  check(missRows().length === 1, '时钟合成会话不重置离别计时')

  // 5. 博士回来：阈值内不写；再离别：第二条。
  say('sess-owner', T0 + 52 * HOUR, 1)
  await tickAt(T0 + 53 * HOUR)
  check(missRows().length === 1, '刚回来（1h）：不写')
  await tickAt(T0 + 77 * HOUR)
  rows = missRows()
  check(rows.length === 2, '再次离别：第二条', `实际 ${rows.length}`)
  check(JSON.parse(rows[1].payload_json).reason === '博士已经 25 小时没出现',
    '第二条 reason 从新的最后见面起算', rows[1].payload_json)

  // 6. 说话路径全程零调用。
  check(deliverCalls === 0 && clock.stats().fired === 0,
    'deliver 零调用：只写情绪，不说话', `deliverCalls=${deliverCalls}`)

  // 7. 重开库：去重的事实来源是链，不是内存——重启后仍不重复。
  memory.close()
  emotion.close()
  memory = MemoryStore.open(memPath)
  emotion = EmotionStore.open(emoPath)
  const clock2 = attachWakeClock({
    collectDue: () => [],
    deliver: async () => { deliverCalls += 1; throw new Error('④ 路径不得投递') },
    onTick: createAbsenceSignal({
      emotion,
      lastOwnerTurnAtMs: () => memory.lastOwnerTurnAtMs(),
      afterMs: 24 * HOUR,
      log: () => {},
    }),
    now: () => nowMs,
    log: () => {},
  })
  nowMs = T0 + 78 * HOUR
  await clock2.tick()
  check(missRows().length === 2, '重开库后 tick：去重仍生效（重启安全）')
  const state = emotion.get()
  check(state?.label === '想念' && state?.revision === 2, '重开库状态保留（想念，revision 2）',
    JSON.stringify(state))

  // 8. 重建不变：两库 rebuildProjections 后链逐字节不变，去重判定不变。
  const before = JSON.stringify(missRows())
  memory.rebuildProjections()
  emotion.rebuildProjections()
  check(JSON.stringify(missRows()) === before, '两库重建后情绪链逐字节不变')
  check(memory.verifyChain().ok === true && emotion.verifyChain().ok === true, '两链校验通过')
  nowMs = T0 + 79 * HOUR
  await clock2.tick()
  check(missRows().length === 2, '重建后 tick：不写第三条')
  check(deliverCalls === 0, '全程 deliver 零调用（含重开/重建后）')

  console.log('\nPASS: S7 真实组件路径闭环（零模型调用）。')
  console.log(`证据目录保留：${dataRoot}`)
} finally {
  memory.close()
  emotion.close()
}