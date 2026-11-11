#!/usr/bin/env node
/**
 * 耦合边「学习→情感」：真实运行时验证（DESIGN-05 S7）。
 *
 * 单测用假 ctx 证明了接线；本脚本走**真接线**：startRuntime 真实模型回合
 * 触发注入（offer 带 taskId），/reject、/accept 走 runChat 真实命令路径，
 * 情绪事件进临时 emotion.sqlite。生产库零写入（人格库是生产副本）。
 *
 * 路径：临时 dataRoot → 种 active 技能 → 任务一带绑定真模型回合 →
 * 对照任务二（无技能）accept → owner-feedback；任务一先拒后收 →
 * skill-outcome 失落→欣慰；重开库状态保留；重建投影情绪链不变；三链 verify。
 * 任何一步对照不过 exit(1)，不打印「结论一致」了事。
 *
 * 成本：一轮真实模型调用（提示词要求只说不做）。密钥只进内存 credentials。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-emotion-outcome.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startRuntime } from 'file:///C:/prts-system/src/runtime/start.ts'
import { runChat } from 'file:///C:/prts-system/src/cli/chat.ts'
import { SkillStore } from 'file:///C:/prts-system/src/skills/index.ts'
import { EmotionStore } from 'file:///C:/prts-system/src/emotion/index.ts'
import { attribute } from 'file:///C:/prts-system/src/runtime/skill-attribution.ts'

const CONFIG = 'C:/prts-system/config/prts.yml'
const PROD_PERSONA = 'C:/prts-data/persona.sqlite'

process.env.PRTS_CLOCK = 'off'

const keyFile = 'C:/prts-data/secrets/deepseek.key'
const apiKey = process.env.DEEPSEEK_API_KEY
  ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined)
if (!apiKey) {
  console.error('需要 DEEPSEEK_API_KEY 或 C:/prts-data/secrets/deepseek.key')
  process.exit(2)
}

function check(ok, label, detail = '') {
  if (!ok) {
    console.error(`FAIL: ${label}${detail === '' ? '' : ` —— ${detail}`}`)
    process.exit(1)
  }
  console.log(`ok: ${label}`)
}

async function* lines(...xs) { for (const x of xs) yield x }

const dataRoot = mkdtempSync(join(tmpdir(), 'prts-emotion-verify-'))
copyFileSync(PROD_PERSONA, join(dataRoot, 'persona.sqlite'))
console.log(`临时 dataRoot：${dataRoot}`)

const app = await startRuntime({
  configPath: CONFIG,
  dataRoot,
  workspace: dataRoot,
  mode: 'normal',
  credentials: { DEEPSEEK_API_KEY: apiKey },
})
const usage = { inputTokens: 0, outputTokens: 0 }
app.ctx.events?.on?.('agent/assistant-stream', (payload) => {
  const chunk = payload?.frame?.chunk
  if (payload?.frame?.type !== 'chunk' || chunk?.type !== 'usage' || chunk.usage === undefined) return
  usage.inputTokens += chunk.usage.inputTokens ?? 0
  usage.outputTokens += chunk.usage.outputTokens ?? 0
})

const skills = SkillStore.open(join(dataRoot, 'skills.sqlite'))
const owner = { kind: 'owner' }
const sessionId = 'emotion-verify-session'
const modelActor = { kind: 'model', sessionId }

function emotionRows() {
  const db = new DatabaseSync(join(dataRoot, 'emotion.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT seq, actor_json, payload_json FROM emotion_events ORDER BY seq').all()
  } finally { db.close() }
}

async function hostCmd(...cmds) {
  const printed = []
  await runChat({
    ctx: app.ctx,
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    sessionId,
    ledger: app.ledger,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
  })
  return printed.join('')
}

try {
  // 1. 种一条 active 技能（触发面与任务话题共享 token）。
  const skillId = skills.propose(owner, {
    title: '归档对账先以磁盘为基准',
    trigger: '核对归档目录与文档清单是否一致',
    steps: ['先枚举磁盘拿真值', '再改文档数字'],
    pitfalls: ['只改一处会再生分歧'],
  })
  const ev = skills.evaluate(owner, { id: skillId, revision: 1 }, { verdict: 'adopt', basis: '验证脚本种子技能' })
  skills.adopt(owner, { id: skillId, revision: ev.revision })

  // 2. 任务一：建、激活、绑会话；真模型回合触发注入。
  const created = app.ledger.create(owner, {
    title: '核对归档',
    objective: '核对归档目录与文档清单是否一致',
    acceptance: { kind: 'owner-confirm' },
  })
  const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
  app.ledger.bindSession(owner, { id: active.id, revision: active.revision }, sessionId)
  const r = await runChat({
    ctx: app.ctx,
    lines: lines('帮我核对归档目录与文档清单是否一致。只说做法，不要动手，不要调用任何工具。', '/exit'),
    out: () => {},
    cwd: dataRoot,
    dataRoot,
    sessionId,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
  })
  check(r.replies.join('').trim() !== '', '模型回合有回复')
  const offers = skills.offers().filter((o) => o.skillId === skillId)
  check(offers.length === 1 && offers[0].taskId === active.id, '注入触发，offer 带绑定任务 id',
    JSON.stringify(offers))

  // 模型回合正常收尾本身写一条「顺利」（turn-end 既有生产者）——它是基线，不是本边的产物。
  let rows = emotionRows()
  check(rows.length === 1 && JSON.parse(rows[0].actor_json).component === 'turn-end'
    && JSON.parse(rows[0].payload_json).label === '顺利',
  '基线：turn 收尾写「顺利」（既有生产者回归）', JSON.stringify(rows))

  // 3. 对照任务二（无技能、无模型回合）：accept → 既有 owner-feedback。
  const c2 = app.ledger.create(owner, {
    title: '对照任务', objective: '无技能对照', acceptance: { kind: 'owner-confirm' },
  })
  const a2 = app.ledger.activate(owner, { id: c2.id, revision: c2.revision })
  const v2 = app.ledger.claimDone(modelActor, { id: a2.id, revision: a2.revision })
  const t2 = await hostCmd(`/accept ${v2.id}`)
  check(/已验收/.test(t2), '对照任务 accept 成功', t2)
  rows = emotionRows()
  check(rows.length === 2, '对照任务写一条情绪', `实际 ${rows.length}`)
  check(JSON.parse(rows[1].actor_json).component === 'owner-feedback'
    && JSON.parse(rows[1].payload_json).label === '被认可',
  '无技能 → owner-feedback 被认可（行为不变）', rows[1].actor_json + ' ' + rows[1].payload_json)

  // 4. 任务一先拒后收：/reject（会话绑定寻址）→ 失落；再 claimDone → /accept → 欣慰。
  let snap = app.ledger.get(active.id)
  if (snap.phase === 'active') snap = app.ledger.claimDone(modelActor, { id: snap.id, revision: snap.revision })
  check(snap.phase === 'verifying', '任务一进入 verifying', `实际 ${snap.phase}`)
  const tr = await hostCmd('/reject 演练驳回')
  check(/已驳回/.test(tr), '任务一 reject 成功', tr)
  rows = emotionRows()
  check(rows.length === 3, '驳回写一条情绪', `实际 ${rows.length}`)
  const rej = JSON.parse(rows[2].payload_json)
  check(JSON.parse(rows[2].actor_json).component === 'skill-outcome' && rej.label === '失落',
    '有技能失败 → skill-outcome 失落', rows[2].actor_json + ' ' + rows[2].payload_json)
  check(rej.reason.includes(active.id) && rej.reason.includes('演练驳回'),
    '失落 reason 含任务 id 与驳回理由', rej.reason)

  const again = app.ledger.get(active.id)
  const vv = app.ledger.claimDone(modelActor, { id: again.id, revision: again.revision })
  const ta = await hostCmd(`/accept ${vv.id}`)
  check(/已验收/.test(ta), '任务一 accept 成功', ta)
  rows = emotionRows()
  check(rows.length === 4, '验收写一条情绪（一次结局一条，不双写）', `实际 ${rows.length}`)
  const acc = JSON.parse(rows[3].payload_json)
  check(JSON.parse(rows[3].actor_json).component === 'skill-outcome' && acc.label === '欣慰',
    '有技能成功 → skill-outcome 欣慰', rows[3].actor_json + ' ' + rows[3].payload_json)
  check(acc.reason.includes(active.id) && acc.reason.includes(skillId.slice(0, 12))
    && acc.reason.includes('在场技能'),
  '欣慰 reason 含任务 id、技能短 id，措辞不声称因果', acc.reason)

  // 5. 重开库：状态保留。
  const emo = EmotionStore.open(join(dataRoot, 'emotion.sqlite'))
  try {
    const state = emo.get()
    check(state?.label === '欣慰' && state?.revision === 4, '重开库状态保留（欣慰，revision 4）',
      JSON.stringify(state))
    check(emo.verifyChain().ok === true, '情绪链校验通过')
  } finally { emo.close() }

  // 6. 重建不变：账本/技能库重建后情绪链逐字节不变；③ 归因数字同步核对。
  const before = JSON.stringify(emotionRows())
  app.ledger.rebuildProjections()
  skills.rebuildProjections()
  check(JSON.stringify(emotionRows()) === before, '两库重建投影后情绪链逐字节不变')
  const attr = attribute(skills.offers(), app.ledger.outcomeEvents()).get(skillId)
  check(attr?.success === 1 && attr?.failure === 1, '③ 归因同步核对：成功 1 · 失败 1',
    JSON.stringify(attr))
  check(app.ledger.verifyChain().ok === true && skills.verifyChain().ok === true, '账本/技能链校验通过')

  console.log(`\nPASS: S7 真实路径闭环。usage: in ${usage.inputTokens} / out ${usage.outputTokens} tokens`)
  console.log(`证据目录保留：${dataRoot}`)
} finally {
  skills.close()
  await app.dispose()
}