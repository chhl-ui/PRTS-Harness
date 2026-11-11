/**
 * DESIGN-05 S2/S3/S5：/accept、/reject 的学习→情感接线（CLI 级）。
 *
 * 与 K9/K10 同模式：真实 Ledger + SkillStore + EmotionStore 三个临时库，
 * runChat 走真实命令路径（宿主命令不触发模型）。情绪断言直接读
 * emotion_events 链（actor_json / payload_json），不只读投影——
 * 投影对而链错的情形必须能红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runChat } from '../../src/cli/chat.ts'
import { SkillStore } from '../../src/skills/index.ts'
import type { SkillId } from '../../src/skills/index.ts'
import { Ledger } from '../../src/ledger/index.ts'
import type { TaskSnapshot } from '../../src/ledger/index.ts'
import { EmotionStore } from '../../src/emotion/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const OWNER = { kind: 'owner' } as const
const MODEL = { kind: 'model', sessionId: 'sess-x' } as const

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface FakeAgent {
  status: string
  followup(msg: unknown): void
  session: { id: string; append(type: string, data: unknown): void }
}

interface FakeState {
  agent: FakeAgent
  followups: number
}

function makeAgent(id: string): FakeState {
  const state: FakeState = { followups: 0, agent: undefined as unknown as FakeAgent }
  state.agent = {
    status: 'idle',
    followup(): void { state.followups += 1 },
    session: { id, append(): void { /* 宿主命令不写会话事件 */ } },
  }
  return state
}

function fakeCtx(state: FakeState): Context {
  const agents = new Map([[state.agent.session.id, state.agent]])
  return {
    get(name: string): unknown {
      if (name === 'agents') {
        return {
          list: () => [...agents.keys()].map((id) => ({ session: { id } })),
          get: (id: string) => agents.get(id),
          async create(): Promise<unknown> {
            return { agent: state.agent, dispose: async (): Promise<void> => {} }
          },
        }
      }
      return undefined
    },
    on(): () => void { return (): void => {} },
  } as unknown as Context
}

async function chat(dataRoot: string, cmds: string[], ledger: Ledger): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx(makeAgent('sess-a')),
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    sessionId: 'sess-a',
    ledger,
  })
  return printed.join('')
}

interface Rig {
  t: ReturnType<typeof makeTmp>
  dataRoot: string
  ledger: Ledger
  skillId: SkillId
}

/** 临时数据根 + 一条 active 技能 + 账本。 */
function rig(): Rig {
  const t = makeTmp('prts-outcome-emotion-')
  const dataRoot = join(t.dir, 'data')
  mkdirSync(dataRoot, { recursive: true })
  const skills = SkillStore.open(join(dataRoot, 'skills.sqlite'))
  let skillId: SkillId
  try {
    skillId = skills.propose(OWNER, {
      title: '归档对账先以磁盘为基准',
      trigger: '核对归档目录与文档清单是否一致',
      steps: ['先枚举磁盘拿真值', '再改文档数字'],
    })
    const ev = skills.evaluate(OWNER, { id: skillId, revision: 1 }, { verdict: 'adopt', basis: '测试种子' })
    skills.adopt(OWNER, { id: skillId, revision: ev.revision })
  } finally { skills.close() }
  const corePath = join(dataRoot, 'core.sqlite')
  initCoreDb(corePath)
  return { t, dataRoot, ledger: Ledger.open(corePath), skillId }
}

function done(r: Rig): void {
  r.ledger.close()
  r.t.cleanup()
}

/** 建任务并推进到 verifying；bind=true 时绑到 chat  helper 的会话（/reject 无 id 参）。 */
function verifying(r: Rig, bind = false): TaskSnapshot {
  const created = r.ledger.create(OWNER, {
    title: '核对归档',
    objective: '核对归档目录与文档清单是否一致',
    acceptance: { kind: 'owner-confirm' },
  })
  let snap = r.ledger.activate(OWNER, { id: created.id, revision: created.revision })
  if (bind) snap = r.ledger.bindSession(OWNER, { id: snap.id, revision: snap.revision }, 'sess-a')
  return r.ledger.claimDone(MODEL, { id: snap.id, revision: snap.revision })
}

/** 注入层在真实运行时里做的事：offer 载荷带绑定任务 id。 */
function offerFor(r: Rig, taskId: string): void {
  const s = SkillStore.open(join(r.dataRoot, 'skills.sqlite'))
  try {
    const snap = s.get(r.skillId)
    assert.ok(snap !== undefined)
    s.recordOffered(MODEL, { id: r.skillId, revision: snap.revision }, { sessionId: 'sess-x', taskId })
  } finally { s.close() }
}

interface EmotionRow {
  seq: number
  actor_json: string
  payload_json: string
}

function emotionEvents(dataRoot: string): EmotionRow[] {
  const path = join(dataRoot, 'emotion.sqlite')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT seq, actor_json, payload_json FROM emotion_events ORDER BY seq')
      .all() as unknown as EmotionRow[]
  } finally { db.close() }
}

function actorOf(row: EmotionRow): { kind: string; component?: string } {
  return JSON.parse(row.actor_json) as { kind: string; component?: string }
}

function payloadOf(row: EmotionRow): { valence: number; arousal: number; label: string; reason: string } {
  return JSON.parse(row.payload_json) as { valence: number; arousal: number; label: string; reason: string }
}

test('EM-S2a /accept 有在场技能 → skill-outcome 欣慰，reason 可追溯', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    const text = await chat(r.dataRoot, [`/accept ${v.id}`], r.ledger)
    assert.match(text, /已验收/, `验收应成功，实际：${text}`)
    assert.equal(r.ledger.get(v.id).phase, 'done')
    const rows = emotionEvents(r.dataRoot)
    assert.equal(rows.length, 1, '一次结局只写一条情绪（D3）')
    assert.deepEqual(actorOf(rows[0]), { kind: 'system', component: 'skill-outcome' })
    const p = payloadOf(rows[0])
    assert.equal(p.label, '欣慰')
    assert.equal(p.valence, 0.5)
    assert.ok(p.reason.includes(v.id), `reason 应含任务 id：${p.reason}`)
    assert.ok(p.reason.includes(r.skillId.slice(0, 12)), `reason 应含技能短 id：${p.reason}`)
    assert.ok(p.reason.includes('在场技能'), `措辞不声称因果：${p.reason}`)
    const store = EmotionStore.open(join(r.dataRoot, 'emotion.sqlite'))
    try {
      assert.equal(store.get()?.label, '欣慰')
      assert.equal(store.verifyChain().ok, true)
    } finally { store.close() }
  } finally { done(r) }
})

test('EM-S2b /accept 无技能 → 既有 owner-feedback 被认可，逐字不变', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    await chat(r.dataRoot, [`/accept ${v.id}`], r.ledger)
    const rows = emotionEvents(r.dataRoot)
    assert.equal(rows.length, 1)
    assert.deepEqual(actorOf(rows[0]), { kind: 'system', component: 'owner-feedback' })
    const p = payloadOf(rows[0])
    assert.equal(p.label, '被认可')
    assert.equal(p.valence, 0.35)
    assert.equal(p.reason, `博士验收：任务 ${v.id} 验收通过`)
  } finally { done(r) }
})

test('EM-S2c /reject 有在场技能 → skill-outcome 失落，reason 含驳回理由', async () => {
  const r = rig()
  try {
    const v = verifying(r, true)
    offerFor(r, v.id)
    const text = await chat(r.dataRoot, ['/reject 数字对不上'], r.ledger)
    assert.match(text, /已驳回/, `驳回应成功，实际：${text}`)
    const rows = emotionEvents(r.dataRoot)
    assert.equal(rows.length, 1)
    assert.deepEqual(actorOf(rows[0]), { kind: 'system', component: 'skill-outcome' })
    const p = payloadOf(rows[0])
    assert.equal(p.label, '失落')
    assert.equal(p.valence, -0.35)
    assert.ok(p.reason.includes('数字对不上'), `reason 应含驳回理由：${p.reason}`)
    assert.ok(p.reason.includes(v.id), `reason 应含任务 id：${p.reason}`)
  } finally { done(r) }
})

test('EM-S2d /reject 无技能 → 既有 owner-feedback 受挫', async () => {
  const r = rig()
  try {
    verifying(r, true)
    await chat(r.dataRoot, ['/reject 数字对不上'], r.ledger)
    const rows = emotionEvents(r.dataRoot)
    assert.equal(rows.length, 1)
    assert.deepEqual(actorOf(rows[0]), { kind: 'system', component: 'owner-feedback' })
    assert.equal(payloadOf(rows[0]).label, '受挫')
  } finally { done(r) }
})

test('EM-S2e /cancel 不写情绪：博士决策不是技能效果', async () => {
  const r = rig()
  try {
    const created = r.ledger.create(OWNER, {
      title: '核对归档', objective: '核对归档', acceptance: { kind: 'owner-confirm' },
    })
    const active = r.ledger.activate(OWNER, { id: created.id, revision: created.revision })
    offerFor(r, active.id)
    const text = await chat(r.dataRoot, [`/cancel ${active.id}`], r.ledger)
    assert.match(text, /已取消/, `取消应成功，实际：${text}`)
    assert.equal(emotionEvents(r.dataRoot).length, 0, 'cancelled 不归因也不动情绪')
  } finally { done(r) }
})

test('EM-S3 情绪库打不开：/accept 仍 done，裁决不受情绪失败影响', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    // 用目录占住 emotion.sqlite 路径：open 必抛，且不是权限噪声。
    mkdirSync(join(r.dataRoot, 'emotion.sqlite'))
    const text = await chat(r.dataRoot, [`/accept ${v.id}`], r.ledger)
    assert.match(text, /已验收/, `情绪失败不得拖垮裁决，实际：${text}`)
    assert.equal(r.ledger.get(v.id).phase, 'done', '账本事实不变')
  } finally { done(r) }
})

test('EM-S2f 先拒后收：两条情绪各随命令，终态欣慰', async () => {
  const r = rig()
  try {
    const v = verifying(r, true)
    offerFor(r, v.id)
    await chat(r.dataRoot, ['/reject 数字对不上'], r.ledger)
    const mid = r.ledger.get(v.id)
    const v2 = r.ledger.claimDone(MODEL, { id: mid.id, revision: mid.revision })
    await chat(r.dataRoot, [`/accept ${v2.id}`], r.ledger)
    const rows = emotionEvents(r.dataRoot)
    assert.equal(rows.length, 2, '两个结局回合各写一条')
    assert.equal(payloadOf(rows[0]).label, '失落')
    assert.equal(payloadOf(rows[1]).label, '欣慰')
    const store = EmotionStore.open(join(r.dataRoot, 'emotion.sqlite'))
    try {
      const state = store.get()
      assert.equal(state?.label, '欣慰')
      assert.equal(state?.revision, 2)
    } finally { store.close() }
  } finally { done(r) }
})

test('EM-S5 账本重建投影：情绪链逐字节不变，链校验过', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    await chat(r.dataRoot, [`/accept ${v.id}`], r.ledger)
    const before = JSON.stringify(emotionEvents(r.dataRoot))
    r.ledger.rebuildProjections()
    const after = JSON.stringify(emotionEvents(r.dataRoot))
    assert.equal(after, before, '钩子不在投影重放路径，重建不得重放情绪')
    const store = EmotionStore.open(join(r.dataRoot, 'emotion.sqlite'))
    try {
      assert.equal(store.verifyChain().ok, true)
      assert.equal(store.get()?.label, '欣慰')
    } finally { store.close() }
  } finally { done(r) }
})