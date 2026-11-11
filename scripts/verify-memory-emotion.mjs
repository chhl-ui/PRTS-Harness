#!/usr/bin/env node
/**
 * 耦合边「记忆 → 情感」：真实运行时验证（DESIGN-07 S7）。
 *
 * startRuntime + scriptedLlm + 真实 agent 回合（runTurn 同款驱动，同会话复用
 * agent）：真实用户消息 → pre-step 真实检索注入 → 想起 / 顾虑写链。
 * 零真实模型调用（脚本化替身），临时 dataRoot 生产零写。
 * 时钟显式关闭——本验证只测 M→E，不让 ④ 混进链里。
 *
 * 对照链：种旧事实 + 连败任务（种数据不写情绪）→ 真实一轮 → 链上想起 + 顾虑
 * 且顾虑后写 → 同会话再提不重写 → 重开运行时去重仍在（冷却/结局判定走链）→
 * 无关查询零新增 → 三库重建链逐字节不变 + verifyChain。
 * 任何一步对照不过 exit(1)。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-memory-emotion.mjs
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startRuntime } from '../src/runtime/start.ts'
import { EmotionStore } from '../src/emotion/index.ts'
import { scriptedLlmPlugin } from '../test/support/scripted-llm.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const prtsYml = fileURLToPath(new URL('../config/prts.yml', import.meta.url))

function check(ok, label, detail = '') {
  if (!ok) {
    console.error(`FAIL: ${label}${detail === '' ? '' : ` —— ${detail}`}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

const root = mkdtempSync(join(tmpdir(), 'prts-me-verify-'))
const dataRoot = join(root, 'data')
const ws = join(root, 'ws')
mkdirSync(dataRoot, { recursive: true })
mkdirSync(ws, { recursive: true })
console.log(`临时 dataRoot：${dataRoot}`)

const savedClock = process.env.PRTS_CLOCK
process.env.PRTS_CLOCK = 'off' // ④ 不在本验证范围：链上只允许 M→E 与 turn-end

const emoPath = join(dataRoot, 'emotion.sqlite')
function rows(component) {
  const db = new DatabaseSync(emoPath, { readOnly: true })
  try {
    return db.prepare(
      `SELECT seq, actor_json, payload_json, ts FROM emotion_events
        WHERE kind = 'emotion.updated' AND json_extract(actor_json, '$.component') = ?
        ORDER BY seq`,
    ).all(component)
  } finally { db.close() }
}
function allRows() {
  const db = new DatabaseSync(emoPath, { readOnly: true })
  try {
    return db.prepare('SELECT seq, actor_json, payload_json, ts FROM emotion_events ORDER BY seq').all()
  } finally { db.close() }
}

const runtimeOpts = {
  configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
  patches: [{ id: 'llm-deepseek', disabled: true }],
}
const OWNER = { kind: 'owner' }
const MODEL = { kind: 'model', sessionId: 'sess-verify' }

// runTurn 每次新建 agent，同 sessionId 第二次 create 会抛「already exists」；
// 同会话多轮必须复用同一个 agent（生产 runChat 也是一会话一 agent）。
const agentCache = new Map()
function waitIdle(agent, ms = 30000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (agent.status === 'idle' && Date.now() - t0 > 200) return resolve()
      if (Date.now() - t0 > ms) return reject(new Error(`agent 未在 ${ms}ms 内回到 idle（status=${agent.status}）`))
      setTimeout(tick, 50)
    }
    setTimeout(tick, 150)
  })
}
async function turn(ctx, text, sessionId) {
  let entry = agentCache.get(sessionId)
  if (entry === undefined) {
    entry = await ctx.get('agents').create({
      sessionId, meta: { cwd: ws },
      agentOptions: { provider: 'deepseek-official', model: 'fake-1' },
    })
    agentCache.set(sessionId, entry)
  }
  const events = []
  const off = ctx.events?.on?.('agent/assistant-stream', (e) => events.push(e))
  const idle = waitIdle(entry.agent)
  entry.agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  off?.()
  return events
}

let app
let emotion
try {
  app = await startRuntime(runtimeOpts)
  scriptedLlmPlugin([
    { text: '我看一下记录。' },
    { text: '还在核对，有进展会汇报。' },
  ]).apply(app.ctx)

  // ---- 种数据：一条旧事实 + 一个连败 2 次的任务。种数据不得写情绪。 ----
  const factId = app.memory.assertFact({
    actor: 'system', subject: '博士', predicate: '说过', object: '冬天去看极光拍照片',
    provenance: 'stated', confirmationBasis: 'owner-stated', origin: 'live',
  })
  let snap = app.ledger.create(OWNER, {
    title: '核对极光装备', objective: '核对极光装备清单', acceptance: { kind: 'owner-confirm' },
  })
  snap = app.ledger.activate(OWNER, { id: snap.id, revision: snap.revision })
  for (let i = 0; i < 2; i++) {
    snap = app.ledger.claimDone(MODEL, { id: snap.id, revision: snap.revision })
    snap = app.ledger.ownerReject({ id: snap.id, revision: snap.revision }, `第 ${i + 1} 次驳回`)
  }
  const taskId = snap.id
  check(allRows().length === 0, '种事实/造连败不写情绪（情绪只在被提到时产生）')

  // ---- 真实一轮：用户消息同时命中旧事实与连败项目。 ----
  const t1Events = await turn(app.ctx, '冬天去看极光装备核对', 'sess-verify')
  check(t1Events.length > 0, '模型替身真被调用（不是只入队）')

  const injected = app.memory.injectionRecords({ sessionId: 'sess-verify', outcome: 'injected' })
  check(injected.some((r) => r.hitIds.includes(factId)), '旧事实真实进入本轮注入清单')

  const recall = rows('memory-recall')
  check(recall.length === 1, '想起：恰好一条', `实际 ${recall.length}`)
  const ra = JSON.parse(recall[0].actor_json)
  check(ra.kind === 'system' && ra.component === 'memory-recall',
    '想起 actor 固定 system{memory-recall}', recall[0].actor_json)
  const rp = JSON.parse(recall[0].payload_json)
  check(rp.label === '想起' && rp.valence === 0.1 && rp.arousal === 0.15,
    '想起 mood 0.1/0.15', recall[0].payload_json)
  check(rp.refId === factId, '想起 refId 指向命中的事实', rp.refId)
  check(rp.reason === '想起旧事：冬天去看极光拍照片', '想起 reason 可追溯', rp.reason)

  const concern = rows('failure-mention')
  check(concern.length === 1, '顾虑：恰好一条', `实际 ${concern.length}`)
  const ca = JSON.parse(concern[0].actor_json)
  check(ca.kind === 'system' && ca.component === 'failure-mention',
    '顾虑 actor 固定 system{failure-mention}', concern[0].actor_json)
  const cp = JSON.parse(concern[0].payload_json)
  check(cp.label === '顾虑' && cp.valence === -0.2 && cp.arousal === 0.3,
    '顾虑 mood -0.2/0.3', concern[0].payload_json)
  check(cp.refId === taskId, '顾虑 refId 指向连败任务', cp.refId)
  check(cp.reason === '又提到反复失败的项目：核对极光装备（连续失败 2 次）',
    '顾虑 reason 可追溯', cp.reason)
  check(recall[0].seq < concern[0].seq, '同轮两写：顾虑后写（更具体者胜）')

  const turnEnd = rows('turn-end')
  check(turnEnd.length === 1 && JSON.parse(turnEnd[0].payload_json).label === '顺利',
    'turn-end 顺利在链：这一轮真实收尾（不是只跑了 pre-step）')

  // ---- 同会话再提：无新结局、冷却内 → 一条都不许多写。 ----
  await turn(app.ctx, '极光装备核对得怎么样了', 'sess-verify')
  check(rows('memory-recall').length === 1 && rows('failure-mention').length === 1,
    '同会话再提：想起/顾虑都不重写')
  check(allRows().length === 3, '第二轮零新增（turn-end 5 分钟节流内）', `实际 ${allRows().length}`)

  // ---- 重开运行时：去重的事实来源是链，不是内存。 ----
  await app.dispose()
  agentCache.clear()
  app = await startRuntime(runtimeOpts)
  scriptedLlmPlugin([
    { text: '我接着核对。' },
    { text: '天气是不错。' },
  ]).apply(app.ctx)
  await turn(app.ctx, '冬天去看极光装备核对', 'sess-verify-2')
  check(rows('memory-recall').length === 1, '重开后新会话再命中：7 天冷却仍生效（重启安全）')
  check(rows('failure-mention').length === 1, '重开后再提：无新结局不重写（重启安全）')
  check(rows('turn-end').length === 2, '重开后 turn-end 节流是进程内的：再写一条顺利（预期）')

  // ---- 无关查询对照：不命中就不写。 ----
  await turn(app.ctx, '今天天气不错', 'sess-verify-3')
  check(rows('memory-recall').length === 1 && rows('failure-mention').length === 1,
    '无关查询：想起/顾虑零新增')
  check(allRows().length === 4, '全程链上恰好 4 条（想起/顾虑/顺利×2）', `实际 ${allRows().length}`)

  // ---- 三库重建：链逐字节不变，校验通过。 ----
  const before = JSON.stringify(allRows())
  emotion = EmotionStore.open(emoPath)
  app.memory.rebuildProjections()
  app.ledger.rebuildProjections()
  emotion.rebuildProjections()
  check(JSON.stringify(allRows()) === before, '三库重建后情绪链逐字节不变')
  check(app.memory.verifyChain().ok === true, '记忆链校验通过')
  check(app.ledger.verifyChain().ok === true, '账本链校验通过')
  check(emotion.verifyChain().ok === true, '情绪链校验通过')

  console.log('\nPASS: S7 真实运行时路径闭环（零真实模型调用）。')
  console.log(`证据目录保留：${root}`)
} finally {
  await app?.dispose()
  emotion?.close()
  if (savedClock === undefined) delete process.env.PRTS_CLOCK
  else process.env.PRTS_CLOCK = savedClock
}