/**
 * 技能使用信号：`skill.offered` 事件与 `usageStats`。
 *
 * 为什么需要：技能采用之后，系统里没有任何信号回答「这条技能到底有没有被用起来」。
 * 采用是闭眼自评（`evaluate` 的 basis 由模型自己写），采用之后也没有回音——
 * 那让「进化」只剩下自说自话。这里记录的是**使用信号**，不是效果证明：
 * 它能回答「被提供给模型多少次、最后一次什么时候」，回答不了「用了之后结果如何」。
 * 后者需要任务级归因，不在这一步。
 *
 * 纪律：`skill.offered` 不改变相位、不推进 revision（提供不是状态变更），
 * 因此 fold 里是 no-op，投影表零迁移；统计直接查事件链。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { SkillStore } from '../../src/skills/index.ts'
import type { SkillId } from '../../src/skills/index.ts'
import { makeTmp } from '../support/tmp.ts'

const owner = { kind: 'owner' as const }
const model = (sessionId = 'sess-1') => ({ kind: 'model' as const, sessionId })

const lesson = {
  title: '先 grep 消费方再改签名',
  trigger: '要改被多处 import 的函数时',
  steps: ['grep 所有引用', '逐个确认同步'],
}

function open(): { store: SkillStore; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-skill-usage-')
  return { store: SkillStore.open(join(tmp.dir, 'skills.sqlite')), tmp }
}

/** propose → evaluate(adopt) → adopt，返回 active 的快照 id。 */
function activate(store: SkillStore): SkillId {
  const id = store.propose(model(), lesson)
  const e = store.evaluate(model(), { id, revision: 1 }, { verdict: 'adopt', basis: '在上一轮任务里验证过' })
  store.adopt(model(), { id, revision: e.revision })
  return id
}

test('SU1 记一次提供：写 skill.offered，相位与 revision 都不动', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const before = c.store.get(id)
    assert.ok(before !== undefined)
    c.store.recordOffered(model('sess-a'), { id, revision: before.revision })
    const after = c.store.get(id)
    assert.ok(after !== undefined)
    assert.equal(after.phase, 'active', '提供不是状态变更')
    assert.equal(after.revision, before.revision, '提供不推进 revision（否则乐观并发会误报过期）')
    const stats = c.store.usageStats(id)
    assert.equal(stats.offered, 1)
    assert.ok(stats.lastOfferedAt !== null && stats.lastOfferedAt > 0, '最后一次提供时间要能查')
  } finally { c.tmp.cleanup(c.store) }
})

test('SU2 多次提供累加；不同会话分别计数', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model('sess-a'), { id, revision: rev })
    c.store.recordOffered(model('sess-a'), { id, revision: rev })
    c.store.recordOffered(model('sess-b'), { id, revision: rev })
    assert.equal(c.store.usageStats(id).offered, 3)
  } finally { c.tmp.cleanup(c.store) }
})

test('SU3 offered 事件进哈希链；重建投影后相位仍 active', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model(), { id, revision: rev })
    assert.equal(c.store.verifyChain().ok, true, '加了事件种类之后正常链仍要校验通过')
    c.store.rebuildProjections()
    assert.equal(c.store.get(id)?.phase, 'active', 'no-op 事件不参与投影，重建后状态不变')
    assert.equal(c.store.usageStats(id).offered, 1, '统计来自事件链，重建后仍在')
  } finally { c.tmp.cleanup(c.store) }
})

test('SU4 未知技能 / 过期 revision 不能记提供', () => {
  const c = open()
  try {
    assert.throws(() => c.store.recordOffered(model(), { id: 'sk-nope' as SkillId, revision: 1 }), /not found|NOT_FOUND/i)
    const id = activate(c.store)
    assert.throws(() => c.store.recordOffered(model(), { id, revision: 999 }), /revision|STALE/i)
  } finally { c.tmp.cleanup(c.store) }
})

test('SU5 context 落载荷：offers() 读回 sessionId + taskId（DESIGN-04 连接键）', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model('sess-a'), { id, revision: rev }, { sessionId: 'sess-a', taskId: 'task-1' })
    const rows = c.store.offers()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].skillId, id)
    assert.equal(rows[0].sessionId, 'sess-a')
    assert.equal(rows[0].taskId, 'task-1')
    assert.equal(c.store.usageStats(id).offered, 1, '提供次数口径不变')
    assert.equal(c.store.get(id)?.phase, 'active', '带 context 的提供仍不是状态变更')
    assert.equal(c.store.verifyChain().ok, true)
  } finally { c.tmp.cleanup(c.store) }
})

test('SU6 旧格式兼容：不传 context 的 offer，sessionId 从 actor 兜底，taskId 缺席', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model('sess-old'), { id, revision: rev })
    const rows = c.store.offers()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'sess-old', '旧事件载荷没有 sessionId，actor 里有')
    assert.equal(rows[0].taskId, undefined, '没有连接键就不主张关联')
  } finally { c.tmp.cleanup(c.store) }
})

test('SU7 hasOffered：按 (会话, 任务) 精确匹配，重启去重的依据', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model('sess-a'), { id, revision: rev }, { sessionId: 'sess-a', taskId: 'task-1' })
    c.store.recordOffered(model('sess-a'), { id, revision: rev }, { sessionId: 'sess-a' })
    assert.equal(c.store.hasOffered(id, 'sess-a', 'task-1'), true)
    assert.equal(c.store.hasOffered(id, 'sess-a', 'task-2'), false, '换任务 = 新上下文，没记过')
    assert.equal(c.store.hasOffered(id, 'sess-b', 'task-1'), false, '换会话不算')
    assert.equal(c.store.hasOffered(id, 'sess-a'), true, '无任务提供匹配 undefined')
    assert.equal(c.store.hasOffered(id, 'sess-b'), false)
  } finally { c.tmp.cleanup(c.store) }
})

test('SU8 context 校验：空 sessionId / 空 taskId 拒写，失败路径不留痕', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    assert.throws(() => c.store.recordOffered(model(), { id, revision: rev }, { sessionId: ' ' }), /sessionId/i)
    assert.throws(() => c.store.recordOffered(model(), { id, revision: rev }, { sessionId: 's', taskId: '' }), /taskId/i)
    assert.equal(c.store.usageStats(id).offered, 0, '被拒的调用不记事件')
  } finally { c.tmp.cleanup(c.store) }
})

test('SU9 重建投影后 offers() 不变：归因读的是链', () => {
  const c = open()
  try {
    const id = activate(c.store)
    const rev = c.store.get(id)?.revision ?? 0
    c.store.recordOffered(model('sess-a'), { id, revision: rev }, { sessionId: 'sess-a', taskId: 'task-1' })
    const before = c.store.offers()
    c.store.rebuildProjections()
    assert.deepEqual(c.store.offers(), before)
  } finally { c.tmp.cleanup(c.store) }
})
