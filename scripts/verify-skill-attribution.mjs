#!/usr/bin/env node
/**
 * 耦合边 ③ 技能效果归因：真实运行时验证（DESIGN-04 A7）。
 *
 * 单测用假钩子证明了归因函数；本脚本走**真接线**：startRuntime 把
 * ledger.taskForSession 接进 skill-inject，真实模型回合触发注入，
 * offer 载荷带 taskId，账本验收后 `/skill show` 显示成功数。
 *
 * 路径：临时 dataRoot（人格库从生产复制，生产零写入）→ 种一条 active 技能
 * → 建任务并绑会话 → 真模型对话一轮触发注入 → claimDone → ownerAccept
 * → 对照归因数字与 /skill show 输出 → 重建投影后数字不变 → 两链 verify。
 * 任何一步对照不过 exit(1)，不打印「结论一致」了事。
 *
 * 成本：一轮真实模型调用（提示词要求只说不做）。密钥只进内存 credentials。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-skill-attribution.mjs
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRuntime } from 'file:///C:/prts-system/src/runtime/start.ts'
import { runChat } from 'file:///C:/prts-system/src/cli/chat.ts'
import { SkillStore } from 'file:///C:/prts-system/src/skills/index.ts'
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

const dataRoot = mkdtempSync(join(tmpdir(), 'prts-attr-verify-'))
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
const sessionId = 'attr-verify-session'
const modelActor = { kind: 'model', sessionId }

try {
  // 1. 种一条 active 技能（触发面与下面的任务话题共享 token）。
  const skillId = skills.propose(owner, {
    title: '归档对账先以磁盘为基准',
    trigger: '核对归档目录与文档清单是否一致',
    steps: ['先枚举磁盘拿真值', '再改文档数字'],
    pitfalls: ['只改一处会再生分歧'],
  })
  const ev = skills.evaluate(owner, { id: skillId, revision: 1 }, { verdict: 'adopt', basis: '验证脚本种子技能' })
  skills.adopt(owner, { id: skillId, revision: ev.revision })

  // 2. 建任务、激活、绑会话（owner 通道，与 /task 命令同路径）。
  const created = app.ledger.create(owner, {
    title: '核对归档',
    objective: '核对归档目录与文档清单是否一致',
    acceptance: { kind: 'owner-confirm' },
  })
  const active = app.ledger.activate(owner, { id: created.id, revision: created.revision })
  app.ledger.bindSession(owner, { id: active.id, revision: active.revision }, sessionId)
  check(app.ledger.taskForSession(sessionId)?.id === active.id, '任务已绑定会话')

  // 3. 真模型回合：话题命中技能触发面 → 注入 → offer 带 taskId。
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
  check(offers.length === 1, '注入触发且只记一次 offer', `实际 ${offers.length} 条`)
  check(offers[0].sessionId === sessionId, 'offer 载荷带 sessionId')
  check(offers[0].taskId === active.id, 'offer 载荷带绑定任务 id（归因连接键）',
    `期望 ${active.id}，实际 ${String(offers[0].taskId)}`)

  // 4. 收尾：模型可能已在回合里 claimDone（相位防御），否则这里补；验收走 owner。
  let snap = app.ledger.get(active.id)
  if (snap.phase === 'active') snap = app.ledger.claimDone(modelActor, { id: snap.id, revision: snap.revision })
  check(snap.phase === 'verifying', '任务进入 verifying', `实际 ${snap.phase}`)
  const accepted = app.ledger.ownerAccept({ id: snap.id, revision: snap.revision })
  check(accepted.phase === 'done', 'ownerAccept → done')

  // 5. 归因对照：成功 1、失败 0，episode 追到账本 seq。
  const outcomes = app.ledger.outcomeEvents()
  const attr = attribute(skills.offers(), outcomes).get(skillId)
  check(attr !== undefined && attr.success === 1 && attr.failure === 0, '归因：成功 1 · 失败 0',
    JSON.stringify(attr))
  check(attr.episodes.length === 1 && attr.episodes[0].taskId === active.id
    && outcomes.some((o) => o.seq === attr.episodes[0].ledgerSeq && o.outcome === 'success'),
  'episode 可追溯到验收事件 seq')

  // 6. /skill show 的真实输出（宿主命令，不触发模型）。
  const printed = []
  await runChat({
    ctx: app.ctx,
    lines: lines(`/skill show ${skillId.slice(0, 12)}`, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    sessionId,
    ledger: app.ledger,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
  })
  const showText = printed.join('')
  check(/任务归因：成功 1 · 失败 0/.test(showText), '/skill show 显示成功 1 · 失败 0', showText)
  check(/相关性非因果/.test(showText), '/skill show 措辞标明相关性非因果')

  // 7. 重建不变 + 链完整。
  const before = JSON.stringify(attribute(skills.offers(), app.ledger.outcomeEvents()).get(skillId))
  skills.rebuildProjections()
  app.ledger.rebuildProjections()
  const after = JSON.stringify(attribute(skills.offers(), app.ledger.outcomeEvents()).get(skillId))
  check(before === after, '两库重建投影后归因数字不变')
  check(skills.verifyChain().ok === true, '技能链校验通过')
  check(app.ledger.verifyChain().ok === true, '账本链校验通过')

  console.log(`\nPASS: A7 真实路径闭环。usage: in ${usage.inputTokens} / out ${usage.outputTokens} tokens`)
  console.log(`证据目录保留：${dataRoot}`)
} finally {
  skills.close()
  await app.dispose()
}