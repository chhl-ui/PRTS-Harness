/**
 * DESIGN-08 记忆↔学习：经验巩固。
 *
 * S1 纯函数（buildExperienceFact）：不碰库，期望手算，对照不过即红。
 * S2–S5 接线：真实 MemoryStore + Ledger + SkillStore + EmotionStore 四个临时库，
 * runChat 走真实 /accept、/reject 命令路径（宿主命令不触发模型）。事实断言直接读
 * mem_facts 投影与 memory_events 链（actor_kind / payload_json），不只读投影——
 * 投影对而链错的情形必须能红。与 DESIGN-05 outcome-emotion.test.ts 同模式。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runChat } from '../../src/cli/chat.ts'
import { buildExperienceFact } from '../../src/runtime/memory-experience.ts'
import { SkillStore } from '../../src/skills/index.ts'
import type { SkillId } from '../../src/skills/index.ts'
import { Ledger } from '../../src/ledger/index.ts'
import type { TaskSnapshot } from '../../src/ledger/index.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { EmotionStore } from '../../src/emotion/index.ts'
import { attribute } from '../../src/runtime/skill-attribution.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const OWNER = { kind: 'owner' } as const
const MODEL = { kind: 'model', sessionId: 'sess-x' } as const

// ───────────────────────── S1 纯函数 ─────────────────────────

test('MX-S1a 有技能 + 成功：fact input 逐项正确', () => {
  const f = buildExperienceFact({
    taskId: 'task-1', outcome: 'success', taskTitle: '核对归档',
    skills: [{ id: 'sk-abcdef0123456789', title: '归档对账先以磁盘为基准' }], outcomeSeq: 7,
  })
  assert.ok(f !== null)
  assert.equal(f.actor, 'system')
  assert.equal(f.subject, '我')
  assert.equal(f.predicate, '做过')
  assert.equal(f.object, '任务《核对归档》验收通过；在场技能：归档对账先以磁盘为基准')
  assert.equal(f.slot, '核对归档')
  assert.equal(f.provenance, 'inferred')
  assert.equal(f.confirmationBasis, 'verifier')
  assert.equal(f.origin, 'live')
  assert.equal(f.importance, 0.5)
  assert.equal(f.retentionClass, 'retirable')
  assert.equal(f.derivedFromTaskId, 'task-1')
  assert.equal(f.outcomeSeq, 7)
  assert.equal(f.supersedeSameSlot, undefined, '每段经历并存，不开同槽取代')
})

test('MX-S1b 失败：object 措辞为「被驳回」', () => {
  const f = buildExperienceFact({
    taskId: 'task-1', outcome: 'failure', taskTitle: '核对归档',
    skills: [{ id: 'sk-a', title: '某技能' }], outcomeSeq: 3,
  })
  assert.ok(f !== null)
  assert.equal(f.object, '任务《核对归档》被驳回；在场技能：某技能')
})

test('MX-S1c 无技能 → null（D2 门控）', () => {
  assert.equal(buildExperienceFact({ taskId: 'task-1', outcome: 'success', skills: [] }), null)
})

test('MX-S1d 技能标题缺省 → 回退短 id（slice 0,12）', () => {
  const f = buildExperienceFact({
    taskId: 'task-1', outcome: 'success', taskTitle: '核对归档',
    skills: [{ id: 'sk-abcdef0123456789' }], outcomeSeq: 1,
  })
  assert.ok(f !== null)
  assert.equal(f.object, '任务《核对归档》验收通过；在场技能：sk-abcdef012')
})

test('MX-S1e 任务标题缺省 → 回退 taskId', () => {
  const f = buildExperienceFact({
    taskId: 'task-xyz', outcome: 'success', skills: [{ id: 'sk-a', title: '某技能' }], outcomeSeq: 1,
  })
  assert.ok(f !== null)
  assert.equal(f.object, '任务《task-xyz》验收通过；在场技能：某技能')
  assert.equal(f.slot, 'task-xyz')
})

test('MX-S1f 多技能：按序以「、」连接', () => {
  const f = buildExperienceFact({
    taskId: 'task-1', outcome: 'failure', taskTitle: '核对归档',
    skills: [{ id: 'sk-b', title: '乙技能' }, { id: 'sk-a', title: '甲技能' }], outcomeSeq: 2,
  })
  assert.ok(f !== null)
  assert.equal(f.object, '任务《核对归档》被驳回；在场技能：乙技能、甲技能')
})

// ───────────────────────── S2–S5 接线 ─────────────────────────

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface FakeAgent {
  status: string
  followup(msg: unknown): void
  session: { id: string; append(type: string, data: unknown): void }
}
interface FakeState { agent: FakeAgent; followups: number }

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

interface Rig {
  t: ReturnType<typeof makeTmp>
  dataRoot: string
  ledger: Ledger
  memory: MemoryStore
  skillId: SkillId
}

/** 临时数据根 + 一条 active 技能 + 账本 + 记忆库。 */
function rig(): Rig {
  const t = makeTmp('prts-mem-exp-')
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
  const memory = MemoryStore.open(join(dataRoot, 'memory.sqlite'))
  return { t, dataRoot, ledger: Ledger.open(corePath), memory, skillId }
}

function done(r: Rig): void {
  r.ledger.close()
  r.t.cleanup(r.memory)
}

/** memory 可被替换（S4 失败隔离用）；缺省用 rig 的真实库。 */
async function chat(r: Rig, cmds: string[], memory?: MemoryStore): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx(makeAgent('sess-a')),
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: r.dataRoot,
    dataRoot: r.dataRoot,
    sessionId: 'sess-a',
    ledger: r.ledger,
    memory: memory === undefined ? r.memory : memory,
  })
  return printed.join('')
}

/** 建任务并推进到 verifying；bind=true 时绑到会话（/reject 无 id 参）。 */
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

interface FactRow {
  fact_id: string
  subject: string
  predicate: string
  confirmation_basis: string
  provenance: string
  retention_class: string
  importance: number
  slot: string | null
  body: string
}

/** 经验事实投影（subject=我 / predicate=做过），join 正文。 */
function experienceFacts(dataRoot: string): FactRow[] {
  const path = join(dataRoot, 'memory.sqlite')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(
      `SELECT f.fact_id, f.subject, f.predicate, f.confirmation_basis, f.provenance,
              f.retention_class, f.importance, f.slot, b.body
         FROM mem_facts f JOIN mem_bodies b ON b.body_ref = f.body_ref
        WHERE f.subject = '我' AND f.predicate = '做过' AND f.deleted_at_ms IS NULL
        ORDER BY f.recorded_at_ms, f.fact_id`,
    ).all() as unknown as FactRow[]
  } finally { db.close() }
}

interface EventRow { seq: number; actor_kind: string; payload_json: string }

function factAssertedEvents(dataRoot: string): EventRow[] {
  const path = join(dataRoot, 'memory.sqlite')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(
      "SELECT seq, actor_kind, payload_json FROM memory_events WHERE kind = 'fact.asserted' ORDER BY seq",
    ).all() as unknown as EventRow[]
  } finally { db.close() }
}

function emotionComponents(dataRoot: string): string[] {
  const path = join(dataRoot, 'emotion.sqlite')
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare('SELECT actor_json FROM emotion_events ORDER BY seq').all() as unknown as { actor_json: string }[])
      .map((r) => (JSON.parse(r.actor_json) as { component?: string }).component ?? '')
  } finally { db.close() }
}

test('MX-S2a /accept 有技能 → 一条经验事实，字段与载荷逐项可追溯', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    const text = await chat(r, [`/accept ${v.id}`])
    assert.match(text, /已验收/, `验收应成功：${text}`)
    const facts = experienceFacts(r.dataRoot)
    assert.equal(facts.length, 1, '一次结局一条经验事实')
    const f = facts[0]
    assert.equal(f.subject, '我')
    assert.equal(f.predicate, '做过')
    assert.equal(f.confirmation_basis, 'verifier')
    assert.equal(f.provenance, 'inferred')
    assert.equal(f.retention_class, 'retirable')
    assert.equal(f.importance, 0.5)
    assert.equal(f.slot, '核对归档')
    assert.equal(f.body, '任务《核对归档》验收通过；在场技能：归档对账先以磁盘为基准')
    // 链上 actor 固定 system，载荷带 taskId + 结局 seq（fold 不读，重建不变）
    const events = factAssertedEvents(r.dataRoot)
    assert.equal(events.length, 1)
    assert.equal(events[0].actor_kind, 'system')
    const p = JSON.parse(events[0].payload_json) as { derived_from_task_id?: string; outcome_seq?: number }
    assert.equal(p.derived_from_task_id, v.id)
    const outcomes = r.ledger.outcomeEvents().filter((e) => e.taskId === v.id)
    assert.equal(p.outcome_seq, outcomes[outcomes.length - 1].seq)
    assert.equal(r.memory.verifyChain().ok, true)
  } finally { done(r) }
})

test('MX-S2b /reject 有技能 → 失败经验事实', async () => {
  const r = rig()
  try {
    const v = verifying(r, true)
    offerFor(r, v.id)
    const text = await chat(r, ['/reject 数字对不上'])
    assert.match(text, /已驳回/, `驳回应成功：${text}`)
    const facts = experienceFacts(r.dataRoot)
    assert.equal(facts.length, 1)
    assert.equal(facts[0].body, '任务《核对归档》被驳回；在场技能：归档对账先以磁盘为基准')
    assert.equal(facts[0].confirmation_basis, 'verifier')
  } finally { done(r) }
})

test('MX-S2c 先拒后收 → 失败 + 成功两条经验事实并存', async () => {
  const r = rig()
  try {
    const v = verifying(r, true)
    offerFor(r, v.id)
    await chat(r, ['/reject 数字对不上'])
    const mid = r.ledger.get(v.id)
    const v2 = r.ledger.claimDone(MODEL, { id: mid.id, revision: mid.revision })
    await chat(r, [`/accept ${v2.id}`])
    const facts = experienceFacts(r.dataRoot)
    assert.equal(facts.length, 2, '不同结局正文不同 → 两条并存')
    assert.ok(facts.some((f) => f.body.includes('被驳回')))
    assert.ok(facts.some((f) => f.body.includes('验收通过')))
  } finally { done(r) }
})

test('MX-S2d 无技能 → 不写经验事实（其 turn 已在情景记忆）', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    // 不 offer：无在场技能
    const text = await chat(r, [`/accept ${v.id}`])
    assert.match(text, /已验收/)
    assert.equal(experienceFacts(r.dataRoot).length, 0)
    assert.deepEqual(emotionComponents(r.dataRoot), ['owner-feedback'], '情绪走既有泛化反馈')
  } finally { done(r) }
})

test('MX-S2e 同一 (任务,结局) 重复 → identity_key 去重不产生第二条', async () => {
  const r = rig()
  try {
    const v = verifying(r, true)
    offerFor(r, v.id)
    await chat(r, ['/reject 第一次'])
    // ownerReject 把任务打回 active，可再次 claimDone → reject：同任务同结局
    const mid = r.ledger.get(v.id)
    const v2 = r.ledger.claimDone(MODEL, { id: mid.id, revision: mid.revision })
    await chat(r, [`/reject 第二次`])
    assert.equal(r.ledger.outcomeEvents().filter((e) => e.taskId === v.id && e.outcome === 'failure').length, 2,
      '账本确有两条失败结局')
    assert.equal(experienceFacts(r.dataRoot).length, 1, '同正文 → identity_key 去重，投影只一条')
  } finally { done(r) }
})

test('MX-S3 经验事实经 memory.search 按任务话题可召回，无关查询不命中', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    await chat(r, [`/accept ${v.id}`])
    const hits = r.memory.search({ text: '核对归档' })
    const factHits = hits.filter((h) => h.kind === 'fact')
    assert.equal(factHits.length, 1, `话题查询应命中经验事实：${JSON.stringify(hits)}`)
    assert.ok(factHits[0].text.includes('核对归档'))
    assert.ok(factHits[0].text.includes('验收通过'))
    const unrelated = r.memory.search({ text: '今天天气不错' }).filter((h) => h.kind === 'fact')
    assert.equal(unrelated.length, 0, '无关查询不命中经验事实')
  } finally { done(r) }
})

test('MX-S4a deps.memory 未注入 → 裁决与情绪照常，不抛', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    // 传一个 assertFact 必抛的替身：记忆写失败不得拖垮裁决与情绪
    const broken = { assertFact(): string { throw new Error('memory down') } } as unknown as MemoryStore
    const text = await chat(r, [`/accept ${v.id}`], broken)
    assert.match(text, /已验收/, `记忆失败不得拖垮裁决：${text}`)
    assert.equal(r.ledger.get(v.id).phase, 'done')
    assert.deepEqual(emotionComponents(r.dataRoot), ['skill-outcome'], '情绪写不受记忆失败影响')
  } finally { done(r) }
})

test('MX-S4b 完全无 memory 句柄 → 裁决与情绪照常', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx(makeAgent('sess-a')),
      lines: lines(`/accept ${v.id}`, '/exit'),
      out: (s) => printed.push(s),
      cwd: r.dataRoot, dataRoot: r.dataRoot, sessionId: 'sess-a', ledger: r.ledger,
      // memory 缺省
    })
    assert.match(printed.join(''), /已验收/)
    assert.equal(r.ledger.get(v.id).phase, 'done')
    assert.deepEqual(emotionComponents(r.dataRoot), ['skill-outcome'])
    assert.equal(experienceFacts(r.dataRoot).length, 0)
  } finally { done(r) }
})

test('MX-S5 三库重建：经验事实与归因数字不变，三链校验过', async () => {
  const r = rig()
  try {
    const v = verifying(r)
    offerFor(r, v.id)
    await chat(r, [`/accept ${v.id}`])
    const factsBefore = JSON.stringify(experienceFacts(r.dataRoot))
    const eventsBefore = JSON.stringify(factAssertedEvents(r.dataRoot))
    const skills = SkillStore.open(join(r.dataRoot, 'skills.sqlite'))
    try {
      const attrBefore = attribute(skills.offers(), r.ledger.outcomeEvents()).get(r.skillId)
      r.memory.rebuildProjections()
      r.ledger.rebuildProjections()
      skills.rebuildProjections()
      assert.equal(JSON.stringify(experienceFacts(r.dataRoot)), factsBefore, '记忆重建后经验事实投影逐字不变')
      assert.equal(JSON.stringify(factAssertedEvents(r.dataRoot)), eventsBefore, '载荷 taskId/seq 在链上不变')
      const attrAfter = attribute(skills.offers(), r.ledger.outcomeEvents()).get(r.skillId)
      assert.deepEqual(attrAfter, attrBefore, '账本/技能重建后归因数字不变')
      assert.equal(attrAfter?.success, 1)
      assert.equal(r.memory.verifyChain().ok, true, '记忆链校验过')
      assert.equal(r.ledger.verifyChain().ok, true, '账本链校验过')
      assert.equal(skills.verifyChain().ok, true, '技能链校验过')
      // 重建后仍可召回
      assert.equal(r.memory.search({ text: '核对归档' }).filter((h) => h.kind === 'fact').length, 1)
    } finally { skills.close() }
  } finally { done(r) }
})