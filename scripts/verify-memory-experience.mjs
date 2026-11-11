#!/usr/bin/env node
/**
 * 耦合边「记忆↔学习」：真实运行时验证（DESIGN-08 S6）。
 *
 * startRuntime + scriptedLlm + 真实 agent 回合（同会话复用 agent）：真实用户消息
 * → pre-step 真实技能注入（offer 带 taskId）→ claimDone → /accept 走 runChat 真实
 * 命令路径 → recordOutcomeEmotion 钩子写经验事实进临时 memory.sqlite。
 * 零真实模型调用（脚本化替身），临时 dataRoot 生产零写。时钟显式关闭。
 *
 * 对照链：种 active 技能 + 任务 → 真实一轮注入 offer（带 taskId）→ accept →
 * 经验事实落 mem_facts（verifier、actor system、载荷可追溯 taskId+seq）→ 按话题
 * 召回命中 → 重开库重新 assert 同一事实去重仍在 → 三库重建链逐字节不变 + verifyChain。
 * 任何一步对照不过 exit(1)，不打印「结论一致」了事。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-memory-experience.mjs
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { startRuntime } from '../src/runtime/start.ts'
import { runChat } from '../src/cli/chat.ts'
import { SkillStore } from '../src/skills/index.ts'
import { MemoryStore } from '../src/memory/index.ts'
import { EmotionStore } from '../src/emotion/index.ts'
import { attribute } from '../src/runtime/skill-attribution.ts'
import { buildExperienceFact } from '../src/runtime/memory-experience.ts'
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

const root = mkdtempSync(join(tmpdir(), 'prts-mx-verify-'))
const dataRoot = join(root, 'data')
const ws = join(root, 'ws')
mkdirSync(dataRoot, { recursive: true })
mkdirSync(ws, { recursive: true })
console.log(`临时 dataRoot：${dataRoot}`)

const savedClock = process.env.PRTS_CLOCK
process.env.PRTS_CLOCK = 'off'

const memPath = join(dataRoot, 'memory.sqlite')
function experienceFacts() {
  const db = new DatabaseSync(memPath, { readOnly: true })
  try {
    return db.prepare(
      `SELECT f.fact_id, f.subject, f.predicate, f.confirmation_basis, f.provenance,
              f.retention_class, f.importance, f.slot, b.body
         FROM mem_facts f JOIN mem_bodies b ON b.body_ref = f.body_ref
        WHERE f.subject = '我' AND f.predicate = '做过' AND f.deleted_at_ms IS NULL
        ORDER BY f.recorded_at_ms, f.fact_id`,
    ).all()
  } finally { db.close() }
}
function factAssertedEvents() {
  const db = new DatabaseSync(memPath, { readOnly: true })
  try {
    return db.prepare(
      "SELECT seq, actor_kind, payload_json FROM memory_events WHERE kind = 'fact.asserted' ORDER BY seq",
    ).all()
  } finally { db.close() }
}

const runtimeOpts = {
  configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
  patches: [{ id: 'llm-deepseek', disabled: true }],
}
const OWNER = { kind: 'owner' }
const sessionId = 'mx-verify-session'
const MODEL = { kind: 'model', sessionId }

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
async function turn(ctx, text) {
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

async function* lines(...xs) { for (const x of xs) yield x }

let app
let skills
let emotion
try {
  app = await startRuntime(runtimeOpts)
  scriptedLlmPlugin([{ text: '我先枚举磁盘拿真值，再核对文档清单。' }]).apply(app.ctx)

  // ---- 种一条 active 技能（触发面与任务话题共享 token）。 ----
  skills = SkillStore.open(join(dataRoot, 'skills.sqlite'))
  const skillId = skills.propose(OWNER, {
    title: '归档对账先以磁盘为基准',
    trigger: '核对归档目录与文档清单是否一致',
    steps: ['先枚举磁盘拿真值', '再改文档数字'],
    pitfalls: ['只改一处会再生分歧'],
  })
  const ev = skills.evaluate(OWNER, { id: skillId, revision: 1 }, { verdict: 'adopt', basis: '验证脚本种子技能' })
  skills.adopt(OWNER, { id: skillId, revision: ev.revision })

  // ---- 任务：建、激活、绑会话；真模型回合触发注入。 ----
  const created = app.ledger.create(OWNER, {
    title: '核对归档', objective: '核对归档目录与文档清单是否一致', acceptance: { kind: 'owner-confirm' },
  })
  const active = app.ledger.activate(OWNER, { id: created.id, revision: created.revision })
  app.ledger.bindSession(OWNER, { id: active.id, revision: active.revision }, sessionId)
  const taskId = active.id

  const t1Events = await turn(app.ctx, '帮我核对归档目录与文档清单是否一致。只说做法，不要动手。')
  check(t1Events.length > 0, '模型替身真被调用（不是只入队）')
  const offers = skills.offers().filter((o) => o.skillId === skillId)
  check(offers.length === 1 && offers[0].taskId === taskId, '注入触发，offer 带绑定任务 id', JSON.stringify(offers))
  check(experienceFacts().length === 0, '注入/对话阶段不写经验事实（只在验收结局写）')

  // ---- claimDone → /accept（真实命令路径，memory 注入）→ 经验事实。 ----
  // 真实回合可能推进任务修订号，claimDone 前重取快照（同 DESIGN-05 脚本）。
  const cur = app.ledger.get(taskId)
  const verifying = app.ledger.claimDone(MODEL, { id: cur.id, revision: cur.revision })
  check(verifying.phase === 'verifying', '任务进入 verifying', verifying.phase)
  const printed = []
  await runChat({
    ctx: app.ctx, lines: lines(`/accept ${verifying.id}`, '/exit'),
    out: (s) => printed.push(s), cwd: dataRoot, dataRoot, sessionId,
    ledger: app.ledger, memory: app.memory,
    authority: app.authority, approvalBridge: app.approvalBridge,
  })
  check(/已验收/.test(printed.join('')), 'accept 成功', printed.join(''))
  check(app.ledger.get(taskId).phase === 'done', '账本裁决 done')

  const facts = experienceFacts()
  check(facts.length === 1, '一条经验事实落 mem_facts', `实际 ${facts.length}`)
  const f = facts[0]
  check(f.subject === '我' && f.predicate === '做过', 'subject=我 / predicate=做过', JSON.stringify(f))
  check(f.confirmation_basis === 'verifier' && f.provenance === 'inferred',
    'confirmationBasis=verifier（来自验收，非模型自报）/ provenance=inferred', JSON.stringify(f))
  check(f.retention_class === 'retirable' && f.importance === 0.5, 'retirable / importance 0.5', JSON.stringify(f))
  check(f.slot === '核对归档', 'slot=任务标题（规范化）', f.slot)
  check(f.body === '任务《核对归档》验收通过；在场技能：归档对账先以磁盘为基准',
    '正文带标题+结局+在场技能标题（可召回）', f.body)

  const events = factAssertedEvents()
  check(events.length === 1 && events[0].actor_kind === 'system', '链上 actor 固定 system', JSON.stringify(events))
  const payload = JSON.parse(events[0].payload_json)
  check(payload.derived_from_task_id === taskId, '载荷 derived_from_task_id 可追溯', payload.derived_from_task_id)
  const outcomes = app.ledger.outcomeEvents().filter((e) => e.taskId === taskId)
  check(payload.outcome_seq === outcomes[outcomes.length - 1].seq,
    '载荷 outcome_seq = 该任务最新结局 seq', `${payload.outcome_seq} vs ${outcomes[outcomes.length - 1].seq}`)

  // ---- 按话题召回（既有 memory.search fact 通道，M→L 闭合）。 ----
  const hits = app.memory.search({ text: '核对归档' }).filter((h) => h.kind === 'fact')
  check(hits.length === 1 && hits[0].text.includes('验收通过'), '按任务话题召回命中经验事实', JSON.stringify(hits))
  const unrelated = app.memory.search({ text: '今天天气不错' }).filter((h) => h.kind === 'fact')
  check(unrelated.length === 0, '无关查询不命中经验事实', JSON.stringify(unrelated))

  // ---- 重开库：去重的事实来源是链/投影，不是进程内存。 ----
  const reopen = MemoryStore.open(memPath)
  try {
    const again = buildExperienceFact({
      taskId, outcome: 'success', taskTitle: '核对归档',
      skills: [{ id: skillId, title: '归档对账先以磁盘为基准' }],
      outcomeSeq: payload.outcome_seq,
    })
    reopen.assertFact(again) // 同正文 → identity_key 去重
    check(experienceFacts().length === 1, '重开库重新 assert 同一事实：去重仍在（不产生第二条）')
    check(reopen.verifyChain().ok === true, '重开库记忆链校验通过')
  } finally { reopen.close() }

  // ---- 三库重建：经验事实与归因数字不变，链逐字节不变，校验通过。 ----
  const factsBefore = JSON.stringify(experienceFacts())
  const eventsBefore = JSON.stringify(factAssertedEvents())
  const attrBefore = attribute(skills.offers(), app.ledger.outcomeEvents()).get(skillId)
  app.memory.rebuildProjections()
  app.ledger.rebuildProjections()
  skills.rebuildProjections()
  check(JSON.stringify(experienceFacts()) === factsBefore, '记忆重建后经验事实投影逐字不变')
  check(JSON.stringify(factAssertedEvents()) === eventsBefore, '载荷 taskId/seq 在链上重建不变')
  const attrAfter = attribute(skills.offers(), app.ledger.outcomeEvents()).get(skillId)
  check(JSON.stringify(attrAfter) === JSON.stringify(attrBefore) && attrAfter?.success === 1,
    '账本/技能重建后 ③ 归因数字不变（成功 1）', JSON.stringify(attrAfter))
  check(app.memory.verifyChain().ok === true, '记忆链校验通过')
  check(app.ledger.verifyChain().ok === true, '账本链校验通过')
  check(skills.verifyChain().ok === true, '技能链校验通过')
  emotion = EmotionStore.open(join(dataRoot, 'emotion.sqlite'))
  check(emotion.verifyChain().ok === true, '情绪链校验通过（DESIGN-05 回音同源仍在）')

  console.log('\nPASS: S6 真实运行时路径闭环（零真实模型调用）。')
  console.log(`证据目录保留：${root}`)
} finally {
  skills?.close()
  emotion?.close()
  await app?.dispose()
  if (savedClock === undefined) delete process.env.PRTS_CLOCK
  else process.env.PRTS_CLOCK = savedClock
}