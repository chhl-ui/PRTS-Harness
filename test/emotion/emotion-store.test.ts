/**
 * V1-05 情感状态。
 *
 * 架构需求 §7 原文：「状态持久化，重启后保留；10 个情境样本中，博士认可情感反应
 * 得体的至少 8 个；**情感变化不改变任何事实性回答**」。
 *
 * 三句话里两句可自动化，本文件钉的就是那两句：
 * 1. 持久化 —— 重启后 valence / arousal / label 原样还在
 * 2. 不改变事实 —— 情绪变了，记忆检索结果、技能列表、账本查询**一个字节都不变**
 *
 * 第二句是这条需求里唯一的安全边界：情绪只能进表达层，不能进事实层。
 * 如果「今天心情不好」能让检索少返两条记忆，那就是情感污染了事实——那是
 * 比「反应不得体」严重得多的失败形态，而且不会报错。
 *
 * 「10 个情境 ≥8 得体」是人工验收，不在本文件范围；测试只用占位文本，
 * 不预设 PRTS 该有什么情绪。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EmotionStore } from '../../src/emotion/index.ts'
import type { EmotionActor } from '../../src/emotion/index.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const owner: EmotionActor = { kind: 'owner' }
const system: EmotionActor = { kind: 'system', component: 'task' }

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  return assert.fail('expected throw, got none') as never
}

function open(): { store: EmotionStore; dbPath: string; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-emotion-')
  const dbPath = join(tmp.dir, 'emotion.sqlite')
  return { store: EmotionStore.open(dbPath), dbPath, tmp }
}

test('EM1 空库：没有状态，渲染空串（不编一个默认情绪）', () => {
  const c = open()
  try {
    assert.equal(c.store.get(), undefined)
    assert.equal(c.store.renderMood(), '')
  } finally { c.tmp.cleanup(c.store) }
})

test('EM2 owner 设定情绪后状态生效', () => {
  const c = open()
  try {
    const s = c.store.update(owner, { valence: 0.6, arousal: 0.3, label: '愉快', reason: '任务顺利完成' })
    assert.equal(s.valence, 0.6)
    assert.equal(s.arousal, 0.3)
    assert.equal(s.label, '愉快')
    assert.equal(s.revision, 1)
    assert.equal(c.store.get()?.label, '愉快')
  } finally { c.tmp.cleanup(c.store) }
})

test('EM3 模型不能设定情绪——情绪不是模型能自我调节的旋钮', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.2, arousal: 0.2, label: '平静', reason: '基线' })
    const before = c.store.get()
    assert.equal(codeOf(() => c.store.update({ kind: 'model', sessionId: 's' } as never, { valence: -1, arousal: 1, label: '愤怒', reason: '想改' })), 'FORBIDDEN')
    assert.equal(c.store.get()?.label, before?.label, '被拒后状态不得改变')
    assert.equal(c.store.get()?.revision, before?.revision)
  } finally { c.tmp.cleanup(c.store) }
})

test('EM4 越界值被拒：valence ∈ [-1,1]、arousal ∈ [0,1]', () => {
  const c = open()
  try {
    assert.equal(codeOf(() => c.store.update(owner, { valence: 1.5, arousal: 0.5, label: 'x', reason: 'r' })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { valence: 0, arousal: -0.1, label: 'x', reason: 'r' })), 'INVALID_INPUT')
    assert.equal(codeOf(() => c.store.update(owner, { valence: Number.NaN, arousal: 0.5, label: 'x', reason: 'r' })), 'INVALID_INPUT')
  } finally { c.tmp.cleanup(c.store) }
})

test('EM5 重启后保留——V1-05 的第一句话', () => {
  const c = open()
  let reopened: EmotionStore | undefined
  try {
    c.store.update(system, { valence: -0.4, arousal: 0.7, label: '焦虑', reason: '连续失败' })
    c.store.close()
    reopened = EmotionStore.open(c.dbPath)
    const s = reopened.get()
    assert.ok(s !== undefined)
    assert.equal(s.valence, -0.4)
    assert.equal(s.arousal, 0.7)
    assert.equal(s.label, '焦虑')
  } finally {
    reopened?.close()
    c.tmp.cleanup()
  }
})

test('EM6 情绪会随时间衰减回基线——不能一次不愉快锁死一整天', () => {
  const c = open()
  try {
    const t0 = 1_700_000_000_000
    c.store.update(owner, { valence: 0.8, arousal: 0.8, label: '兴奋', reason: '成功', atMs: t0 })
    const now = c.store.decay(t0)
    assert.equal(now.valence, 0.8, '零时刻不衰减')
    const HALF = 3 * 3_600_000 // 3 小时半衰期
    const later = c.store.decay(t0 + HALF)
    assert.ok(Math.abs(later.valence - 0.4) < 0.02, `半衰期后 valence 应约一半，实得 ${later.valence}`)
    const much = c.store.decay(t0 + 10 * HALF)
    assert.ok(Math.abs(much.valence) < 0.02, `很久之后应回基线，实得 ${much.valence}`)
    // 衰减是读时计算，不写链：verifyChain 的事件数不该因为多读几次而增长
    const before = c.store.verifyChain()
    void c.store.decay(t0 + HALF)
    void c.store.decay(t0 + 2 * HALF)
    const after = c.store.verifyChain()
    assert.deepEqual(after, before, '衰减不得产生新事件')
  } finally { c.tmp.cleanup(c.store) }
})

test('EM7 情感变化不改变任何事实性回答——V1-05 的安全边界', () => {
  const c = open()
  const memTmp = makeTmp('prts-emotion-fact-')
  const mem = MemoryStore.open(join(memTmp.dir, 'memory.sqlite'))
  try {
    mem.recordTurn({ actor: 'owner', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '我的镜头偏好是 85mm 定焦', occurredAtMs: 1_700_000_000_000 })

    c.store.update(owner, { valence: 0.9, arousal: 0.9, label: '愉快', reason: '顺利' })
    const happy = mem.search({ text: '镜头偏好', limit: 5 }).map((h) => h.id)

    c.store.update(owner, { valence: -0.9, arousal: 0.9, label: '烦躁', reason: '受阻' })
    const angry = mem.search({ text: '镜头偏好', limit: 5 }).map((h) => h.id)

    assert.deepEqual(angry, happy, '同一查询在两种情绪下必须返回完全相同的命中')

    // 结构上的保证：情感库不持有任何能影响检索/账本/技能的方法
    const methods = Object.getOwnPropertyNames(EmotionStore.prototype)
    assert.deepEqual(methods.filter((m) => /search|ledger|task|skill|grant|memory/i.test(m)), [])
  } finally {
    c.tmp.cleanup(c.store)
    memTmp.cleanup(mem)
  }
})

test('EM8 渲染出的一句话只描述情绪本身，不含事实断言', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.5, arousal: 0.4, label: '平静', reason: '基线' })
    const mood = c.store.renderMood()
    assert.ok(mood.includes('平静'), `应包含当前情绪标签：${mood}`)
    assert.ok(mood.length < 120, `应该是一句话，实得 ${mood.length} 字符`)
  } finally { c.tmp.cleanup(c.store) }
})

test('EM9 链校验：正常链先通过，改一行才报断链', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.1, arousal: 0.2, label: 'a', reason: 'r' })
    c.store.update(owner, { valence: 0.2, arousal: 0.3, label: 'b', reason: 'r' })
    assert.equal(c.store.verifyChain().ok, true, '未篡改的链必须校验通过')
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('UPDATE emotion_events SET hash = ? WHERE seq = 1').run('0'.repeat(64))
    } finally { db.close() }
    const again = EmotionStore.open(c.dbPath)
    try {
      const v = again.verifyChain()
      assert.equal(v.ok, false)
      if (!v.ok) assert.equal(v.brokenAtSeq, 1)
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})

test('EM10 投影可重建', () => {
  const c = open()
  try {
    c.store.update(owner, { valence: 0.3, arousal: 0.4, label: '专注', reason: 'r' })
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('DELETE FROM emotion_state').run()
    } finally { db.close() }
    const again = EmotionStore.open(c.dbPath)
    try {
      assert.equal(again.get(), undefined, '前提：投影被删了')
      again.rebuildProjections()
      assert.equal(again.get()?.label, '专注')
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})
