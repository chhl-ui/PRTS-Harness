/**
 * `/skill` 命令的 CLI 级验收：候选可见、评估可记、采用生效、退役可回退、效果归因。
 *
 * 为什么要有这条命令：技能库的全生命周期在库层已有（`src/skills/store.ts`：
 * propose / evaluate / adopt / reject / retire / restore）。2026-11-09 放开后
 * 模型侧也有全套工具，但博士这条命令面是人工闸门——随时能撤任何一条。
 * 历史上 evaluate/adopt 曾零执行者入口，生产库里那条候选从提出起永远停在原地；
 * 这条命令补的就是那个缺失的执行者位。
 *
 * 生效边界与 `/persona` 不同：技能注入走 `attachSkillInjection` 的每轮
 * `store.list({ phase: 'active' })`（`src/runtime/skill-inject.ts`），
 * 不是启动期装配，所以**采用后下一轮就生效**，不需要重启。
 * 但这条命令与运行时是两个连接——必须验证另一连接能看到这次采用，
 * 否则「命令写进去了、注入层看不见」会变成静默失效。
 *
 * K9/K10（DESIGN-04）：`/skill show` 的任务归因数字必须来自账本验收事件，
 * 措辞必须标明相关性非因果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import { SkillStore } from '../../src/skills/index.ts'
import type { SkillId, SkillSnapshot } from '../../src/skills/index.ts'
import { Ledger } from '../../src/ledger/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const OWNER = { kind: 'owner' } as const

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
    session: { id, append(): void { /* /skill 不写会话事件 */ } },
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

/** 在 tmp 数据根下建 skills.sqlite，种一条模型提出的候选。返回库路径与技能 id。 */
function seed(dataRoot: string): { dbPath: string; id: SkillId; title: string } {
  mkdirSync(dataRoot, { recursive: true })
  const dbPath = join(dataRoot, 'skills.sqlite')
  const store = SkillStore.open(dbPath)
  const title = '归档对账先以磁盘为基准再改文档数字'
  try {
    const id = store.propose(
      { kind: 'model', sessionId: 'sess-seed' },
      {
        title,
        trigger: '核对归档目录与文档清单是否一致',
        steps: ['先枚举磁盘拿真值', '再改文档三处数字'],
        pitfalls: ['只改一处会再生分歧'],
        sourceRefs: ['commit:abc1234'],
      },
    )
    return { dbPath, id, title }
  } finally {
    store.close()
  }
}

function read(dbPath: string, id: SkillId): SkillSnapshot {
  const s = SkillStore.open(dbPath)
  try {
    const snap = s.get(id)
    assert.ok(snap !== undefined, `技能 ${id} 应存在`)
    return snap
  } finally {
    s.close()
  }
}

function shortId(id: string): string {
  return id.slice(0, 12)
}

async function chat(
  dataRoot: string,
  state: FakeState,
  cmds: string[],
  ledger?: Ledger,
): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx(state),
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    sessionId: 'sess-a',
    ...(ledger === undefined ? {} : { ledger }),
  })
  return printed.join('')
}

test('K1 无参 /skill：列出待评估候选，并给出下一步命令', async () => {
  const t = makeTmp('prts-skill-1-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { title, id } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, ['/skill'])
    assert.match(text, new RegExp(title.slice(0, 6)), `应列出候选标题，实际：${text}`)
    assert.match(text, /candidate/, `应标出相位，实际：${text}`)
    assert.match(text, /\/skill eval/, `应给出评估用法，实际：${text}`)
    assert.match(text, /\/skill adopt/, `应给出采用用法，实际：${text}`)
    assert.match(text, new RegExp(shortId(id)), `应给出可复制的短 id，实际：${text}`)
    assert.equal(state.followups, 0, '/skill 是宿主命令，不得触发模型回合')
  } finally { t.cleanup() }
})

test('K2 /skill eval：记录评估但不改相位（评估与采用分开）', async () => {
  const t = makeTmp('prts-skill-2-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [`/skill eval ${shortId(id)} adopt 在两次对账任务上用过，省了返工`])
    assert.match(text, /已记录评估|adopt/, `应有评估回执，实际：${text}`)
    assert.match(text, /\/skill adopt/, `应提示下一步采用，实际：${text}`)
    const snap = read(dbPath, id)
    assert.equal(snap.phase, 'candidate', '评估不改变相位')
    assert.equal(snap.evaluations.length, 1, '应留下一条评估记录')
    assert.equal(snap.evaluations[0]?.verdict, 'adopt')
    assert.match(String(snap.evaluations[0]?.basis), /返工/, '依据必须落库')
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K3 /skill adopt：已评估为 adopt 后生效，且另一连接（注入层）能看见', async () => {
  const t = makeTmp('prts-skill-3-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id, title } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [
      `/skill eval ${shortId(id)} adopt 对账流程跑过一遍，数字对上了`,
      `/skill adopt ${shortId(id)}`,
    ])
    assert.match(text, new RegExp(`已采用|${title.slice(0, 4)}`), `应有采用回执，实际：${text}`)
    assert.doesNotMatch(text, /重启/, '技能注入在每轮读取，不是启动期装配——不该提示重启')
    // 注入层用的是另一个长开连接（start.ts 的 store 与命令连接不是同一个）。
    const reader = SkillStore.open(dbPath)
    try {
      const active = reader.list({ phase: 'active' })
      assert.equal(active.length, 1, '另一连接应读到这条已采用的技能')
      assert.equal(active[0]?.id, id)
    } finally { reader.close() }
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K4 /skill adopt 未经评估：拒绝且相位不变', async () => {
  const t = makeTmp('prts-skill-4-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [`/skill adopt ${shortId(id)}`])
    assert.match(text, /失败|evaluate|评估/, `应说明必须先评估，实际：${text}`)
    assert.equal(read(dbPath, id).phase, 'candidate', '被拒绝前不得改动相位')
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K5 /skill 未知 id：报错且不动任何技能', async () => {
  const t = makeTmp('prts-skill-5-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, ['/skill adopt sk-doesnotexist'])
    assert.match(text, /没有匹配|未找到|不存在/, `应报未知 id，实际：${text}`)
    assert.equal(read(dbPath, id).phase, 'candidate')
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K6 /skill retire 与 /skill restore：回退演练往返', async () => {
  const t = makeTmp('prts-skill-6-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id } = seed(dataRoot)
    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [
      `/skill eval ${shortId(id)} adopt 试过没问题`,
      `/skill adopt ${shortId(id)}`,
      `/skill retire ${shortId(id)} 换仓库后触发条件不再出现`,
      `/skill restore ${shortId(id)} 演练结束，确认仍适用`,
    ])
    const snap = read(dbPath, id)
    assert.equal(snap.phase, 'active', 'restore 后应回到 active')
    assert.match(text, /已退役|retired/, `应有退役回执，实际：${text}`)
    assert.match(text, /已恢复|restore/, `应有恢复回执，实际：${text}`)
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K7 /skill list --all：无过滤列出全部相位', async () => {
  const t = makeTmp('prts-skill-7-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id, title } = seed(dataRoot)
    // 再种一条已采用的，验证 --all 会同时列出 candidate 与 active。
    const store = SkillStore.open(dbPath)
    const second = store.propose(
      { kind: 'owner' },
      { title: '已采用的另一条', trigger: '任何时候', steps: ['做'] },
    )
    const e = store.evaluate(OWNER, { id: second, revision: 1 }, { verdict: 'adopt', basis: '试过' })
    store.adopt(OWNER, { id: second, revision: e.revision })
    store.close()

    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, ['/skill list --all'])
    assert.match(text, new RegExp(title.slice(0, 6)), `应列出候选，实际：${text}`)
    assert.match(text, /已采用的另一条/, `应列出 active，实际：${text}`)
    assert.match(text, /candidate/)
    assert.match(text, /active/)
    assert.match(text, new RegExp(shortId(id)))
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K8 /skill show 显示使用信号——采用之后有没有被用起来', async () => {
  const t = makeTmp('prts-skill-8-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { dbPath, id } = seed(dataRoot)
    // 先落两次「被提供」信号（skill-inject 在真实运行时里做同样的事）。
    const s = SkillStore.open(dbPath)
    try {
      const snap = s.get(id)
      assert.ok(snap !== undefined)
      s.recordOffered({ kind: 'model', sessionId: 'sess-x' }, { id, revision: snap.revision })
      s.recordOffered({ kind: 'model', sessionId: 'sess-y' }, { id, revision: snap.revision })
    } finally { s.close() }

    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [`/skill show ${shortId(id)}`])
    assert.match(text, /提供过：2 次/, `应显示提供次数，实际：${text}`)
    assert.match(text, /最近/, `应显示最后一次提供的时间，实际：${text}`)
    assert.match(text, /任务归因：不可用/, `没配 ledger 需要如实说明，实际：${text}`)
    assert.equal(state.followups, 0)
  } finally { t.cleanup() }
})

test('K9 /skill show 任务归因：offer 带任务键 + 账本验收 → 成功 1（DESIGN-04）', async () => {
  const t = makeTmp('prts-skill-9-')
  const dataRoot = join(t.dir, 'data')
  const { dbPath, id } = seed(dataRoot)
  const corePath = join(dataRoot, 'core.sqlite')
  initCoreDb(corePath)
  const ledger = Ledger.open(corePath)
  try {
    const created = ledger.create(OWNER, { title: '对账', objective: '核对归档与文档', acceptance: { kind: 'owner-confirm' } })
    const active = ledger.activate(OWNER, { id: created.id, revision: created.revision })
    // 注入层在真实运行时里做的事：提供时把绑定任务落进 offer 载荷。
    const s = SkillStore.open(dbPath)
    try {
      const snap = s.get(id)
      assert.ok(snap !== undefined)
      s.recordOffered(
        { kind: 'model', sessionId: 'sess-x' },
        { id, revision: snap.revision },
        { sessionId: 'sess-x', taskId: active.id },
      )
    } finally { s.close() }
    const v = ledger.claimDone({ kind: 'model', sessionId: 'sess-x' }, { id: active.id, revision: active.revision })
    ledger.ownerAccept({ id: v.id, revision: v.revision })

    const state = makeAgent('sess-a')
    const text = await chat(dataRoot, state, [`/skill show ${shortId(id)}`], ledger)
    assert.match(text, /提供过：1 次/, `应显示提供次数，实际：${text}`)
    assert.match(text, /任务归因：成功 1 · 失败 0/, `成功数应来自账本验收，实际：${text}`)
    assert.match(text, /相关性非因果/, `措辞必须标明不是因果证据，实际：${text}`)
    assert.equal(state.followups, 0)
  } finally { ledger.close(); t.cleanup() }
})

test('K10 先拒后收：失败与成功各记一回合；claimDone 本身不算成功', async () => {
  const t = makeTmp('prts-skill-10-')
  const dataRoot = join(t.dir, 'data')
  const { dbPath, id } = seed(dataRoot)
  const corePath = join(dataRoot, 'core.sqlite')
  initCoreDb(corePath)
  const ledger = Ledger.open(corePath)
  try {
    const created = ledger.create(OWNER, { title: '对账', objective: '核对归档与文档', acceptance: { kind: 'owner-confirm' } })
    const active = ledger.activate(OWNER, { id: created.id, revision: created.revision })
    const s = SkillStore.open(dbPath)
    try {
      const snap = s.get(id)
      assert.ok(snap !== undefined)
      s.recordOffered(
        { kind: 'model', sessionId: 'sess-x' },
        { id, revision: snap.revision },
        { sessionId: 'sess-x', taskId: active.id },
      )
    } finally { s.close() }
    const v = ledger.claimDone({ kind: 'model', sessionId: 'sess-x' }, { id: active.id, revision: active.revision })

    // 只 claimDone 还没裁决：模型自报不算成功。
    const mid = await chat(dataRoot, makeAgent('sess-a'), [`/skill show ${shortId(id)}`], ledger)
    assert.match(mid, /任务归因：成功 0 · 失败 0/, `claimDone 不是验收，实际：${mid}`)

    const rej = ledger.ownerReject({ id: v.id, revision: v.revision }, '数字对不上')
    const afterReject = await chat(dataRoot, makeAgent('sess-a'), [`/skill show ${shortId(id)}`], ledger)
    assert.match(afterReject, /任务归因：成功 0 · 失败 1/, `驳回应记一回合失败，实际：${afterReject}`)

    const v2 = ledger.claimDone({ kind: 'model', sessionId: 'sess-x' }, { id: rej.id, revision: rej.revision })
    ledger.ownerAccept({ id: v2.id, revision: v2.revision })
    const done = await chat(dataRoot, makeAgent('sess-a'), [`/skill show ${shortId(id)}`], ledger)
    assert.match(done, /任务归因：成功 1 · 失败 1/, `先拒后收 = 两个回合，实际：${done}`)
  } finally { ledger.close(); t.cleanup() }
})
