/**
 * V1-09 进化：技能与经验的「经验 → 候选 → 评估 → 采用 → 回退」全流程。
 *
 * 依据架构需求 §7 V1-09：「至少完成 1 次『经验 → 候选 → 评估 → 采用』流程，
 * 并完成 1 次回退演练；**人格核心设定未经确认不能被改动**」。
 *
 * 本文件钉住的是**不变量**，不是实现细节：
 *
 * 1. 模型可以 `propose` / `evaluate` / `adopt`（2026-11-09 放开）；`reject` /
 *    `retire` / `restore` 仍只有 owner 能做——否决与回退留在人手里。
 *    放开的前提是：技能只是注入上下文的建议文本，不参与工具注册、不参与
 *    `Authority.guard`，真正的强制点在 K2a 守卫。**若将来技能能携带工具、
 *    数据源或授权路径，必须先恢复 actor 校验**——那时它才真的是「能力扩张」。
 * 2. 没有评估就不能采用；评估结论是 reject 或 needs-work 时同样不能采用。
 *    「候选与启用分开」是这一格的设计要点（`docs/memory-landscape.md:129`）。
 * 3. 每次变更进哈希链；投影（skills 表）只能由 `fold.ts` 重建。
 * 4. 回退（retire）必须留下理由，且可恢复（restore）——回退演练要能演回来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SkillStore } from '../../src/skills/index.ts'
import type { SkillActor, SkillId } from '../../src/skills/index.ts'
import { makeTmp } from '../support/tmp.ts'

const owner: SkillActor = { kind: 'owner' }
const model = (sessionId = 'sess-1'): SkillActor => ({ kind: 'model', sessionId })

const lesson = {
  title: '先 typecheck 再跑全量',
  trigger: '改完一批文件准备验证时',
  steps: ['npx tsc -p .', 'node --test "test/**/*.test.ts"'],
  pitfalls: ['只跑单测会漏掉类型错误'],
}

function open(): { store: SkillStore; dbPath: string; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-skills-')
  const dbPath = join(tmp.dir, 'skills.sqlite')
  return { store: SkillStore.open(dbPath), dbPath, tmp }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  return assert.fail('expected throw, got none') as never
}

/** 走完 propose → evaluate(adopt) → adopt，返回 active 的技能。 */
function activated(store: SkillStore): { id: SkillId; revision: number } {
  const id = store.propose(owner, lesson)
  const s = store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: '在三个任务上试过，漏检率下降' })
  const a = store.adopt(owner, { id, revision: s.revision })
  return { id, revision: a.revision }
}

test('SK1 空库：没有任何技能', () => {
  const c = open()
  try {
    assert.deepEqual(c.store.list(), [])
  } finally { c.tmp.cleanup(c.store) }
})

test('SK2 模型可以提经验，落成 candidate，内容原样保留', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    const s = c.store.get(id)
    assert.ok(s !== undefined)
    assert.equal(s.phase, 'candidate')
    assert.equal(s.title, lesson.title)
    assert.equal(s.trigger, lesson.trigger)
    assert.deepEqual(s.steps, lesson.steps)
    assert.deepEqual(s.pitfalls, lesson.pitfalls)
    assert.equal(s.revision, 1)
  } finally { c.tmp.cleanup(c.store) }
})

test('SK3 模型可以自评自采——2026-11-09 放开（技能不授予权限）', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    const e = c.store.evaluate(model(), { id, revision: 1 }, {
      verdict: 'adopt',
      basis: '在归档对账任务上照这条做过，磁盘真值与文档数字对上了',
    })
    const a = c.store.adopt(model(), { id, revision: e.revision })
    assert.equal(a.phase, 'active', '模型评估为 adopt 后可以自己采用')
    assert.equal(a.evaluations.length, 1)
    assert.equal(a.evaluations[0].by.kind, 'model', '评估者必须留痕：谁评的要能查')
    assert.equal((a.evaluations[0].by as { sessionId: string }).sessionId, 'sess-1')
    assert.deepEqual(c.store.adoptedBy(id), model(), '采用者要能从事件链读回（注入层据此标注）')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK4 没评估过不能采用——候选与启用分开', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    assert.equal(codeOf(() => c.store.adopt(owner, { id, revision: 1 })), 'INVALID_TRANSITION')
    assert.equal(c.store.get(id)?.phase, 'candidate')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK5 评估 adopt 之后才能采用，采用后是 active', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    const e = c.store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: '三个任务上漏检率下降' })
    assert.equal(c.store.get(id)?.phase, 'candidate', '评估本身不改变相位')
    const a = c.store.adopt(owner, { id, revision: e.revision })
    assert.equal(a.phase, 'active')
    assert.equal(a.evaluations.length, 1)
    assert.equal(a.evaluations[0].verdict, 'adopt')
    assert.equal(a.evaluations[0].basis, '三个任务上漏检率下降')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK6 评估结论是 reject / needs-work 时不能采用', () => {
  const c = open()
  try {
    const a = c.store.propose(model(), lesson)
    c.store.evaluate(owner, { id: a, revision: 1 }, { verdict: 'reject', basis: '不通用' })
    assert.equal(codeOf(() => c.store.adopt(owner, { id: a, revision: 2 })), 'INVALID_TRANSITION')

    const b = c.store.propose(model(), lesson)
    c.store.evaluate(owner, { id: b, revision: 1 }, { verdict: 'needs-work', basis: '还缺失败条件' })
    assert.equal(codeOf(() => c.store.adopt(owner, { id: b, revision: 2 })), 'INVALID_TRANSITION')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK7 回退演练：active → retired，理由必填，且不再出现在 active 列表里', () => {
  const c = open()
  try {
    const { id, revision } = activated(c.store)
    assert.equal(codeOf(() => c.store.retire(owner, { id, revision }, '')), 'INVALID_INPUT')
    const r = c.store.retire(owner, { id, revision }, '在新仓库里失效了')
    assert.equal(r.phase, 'retired')
    assert.equal(r.retireReason, '在新仓库里失效了')
    assert.equal(c.store.list({ phase: 'active' }).length, 0)
    assert.equal(c.store.list({ phase: 'retired' }).length, 1)
  } finally { c.tmp.cleanup(c.store) }
})

test('SK8 回退可恢复：retired → restore → active（演练要能演回来）', () => {
  const c = open()
  try {
    const { id, revision } = activated(c.store)
    const r = c.store.retire(owner, { id, revision }, '演练')
    const back = c.store.restore(owner, { id, revision: r.revision }, '演练结束，确认仍适用')
    assert.equal(back.phase, 'active')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK9 模型也能回退与否决——2026-11-09 二次放开（连回退也放开）', () => {
  const c = open()
  try {
    const { id, revision } = activated(c.store)
    const r = c.store.retire(model(), { id, revision }, '换仓库后触发条件不再出现')
    assert.equal(r.phase, 'retired', '模型可以撤下已生效的技能')
    const back = c.store.restore(model(), { id, revision: r.revision }, '演练结束，确认仍适用')
    assert.equal(back.phase, 'active', '模型也能恢复')

    const p = c.store.propose(model(), lesson)
    assert.equal(c.store.reject(model(), { id: p, revision: 1 }, '不通用').phase, 'rejected', '模型能否决候选')

    // 理由必填不因放开而放松：没有理由的回退，下次还会被重新提出。
    const { id: id2, revision: rev2 } = activated(c.store)
    assert.equal(codeOf(() => c.store.retire(model(), { id: id2, revision: rev2 }, '   ')), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.restore(model(), { id: id2, revision: rev2 }, '')), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.reject(model(), { id: id2, revision: rev2 }, '')), 'INVALID_INPUT')
    assert.equal(c.store.get(id2)?.phase, 'active', '被拒的回退不得改变相位')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK10 重启后仍在：事件在链上，投影重开即得', () => {
  const c = open()
  let reopened: SkillStore | undefined
  try {
    const { id } = activated(c.store)
    c.store.close()
    reopened = SkillStore.open(c.dbPath)
    const s = reopened.get(id)
    assert.ok(s !== undefined, '重启后应仍能取到')
    assert.equal(s.phase, 'active')
    assert.equal(s.title, lesson.title)
  } finally {
    reopened?.close()
    c.tmp.cleanup()
  }
})

test('SK11 断链检测：正常链先要通过，改一行哈希才报 brokenAtSeq', () => {
  const c = open()
  try {
    activated(c.store)
    // 先钉住「正常链 = ok」。少了这一条，一个 toFields 漏字段的实现（正常链也判断）
    // 照样能通过断链用例——这是真实踩过的假绿，由 `test/acceptance/v1-09-evolution.test.ts` 抓到。
    const before = c.store.verifyChain()
    assert.equal(before.ok, true, '未篡改的链必须校验通过')
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('UPDATE skill_events SET hash = ? WHERE seq = 1').run('0'.repeat(64))
    } finally { db.close() }
    const again = SkillStore.open(c.dbPath)
    try {
      const v = again.verifyChain()
      assert.equal(v.ok, false)
      if (!v.ok) assert.equal(v.brokenAtSeq, 1)
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})

test('SK12 修订号并发：拿旧 revision 提交被拒，且不写事件', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    const e = c.store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: 'ok' })
    assert.equal(codeOf(() => c.store.adopt(owner, { id, revision: 1 })), 'STALE_REVISION', 'revision 已推进到 2')
    const a = c.store.adopt(owner, { id, revision: e.revision })
    assert.equal(a.phase, 'active')
    assert.equal(a.revision, 3)
  } finally { c.tmp.cleanup(c.store) }
})

test('SK13 投影可重建：删掉 projects 行后从事件重建', () => {
  const c = open()
  try {
    const { id } = activated(c.store)
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('DELETE FROM skills').run()
    } finally { db.close() }
    const again = SkillStore.open(c.dbPath)
    try {
      assert.equal(again.get(id), undefined, '前提：投影确实被删了')
      again.rebuildProjections()
      const s = again.get(id)
      assert.ok(s !== undefined, '重建后应恢复')
      assert.equal(s.phase, 'active')
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})

test('SK14 评估依据不能为空——没有理由的「采用」不可追溯', () => {
  const c = open()
  try {
    const id = c.store.propose(model(), lesson)
    assert.equal(codeOf(() => c.store.evaluate(owner, { id, revision: 1 }, { verdict: 'adopt', basis: '   ' })), 'INVALID_INPUT')
  } finally { c.tmp.cleanup(c.store) }
})

test('SK15 提案字段校验：标题、触发条件、步骤都不能空', () => {
  const c = open()
  try {
    assert.equal(codeOf(() => c.store.propose(owner, { ...lesson, title: '' })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.propose(owner, { ...lesson, trigger: '' })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.propose(owner, { ...lesson, steps: [] })), 'INVALID_INPUT')
  } finally { c.tmp.cleanup(c.store) }
})
