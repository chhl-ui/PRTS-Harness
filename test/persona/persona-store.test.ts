/**
 * V1-03 / V1-04 / V1-05 / V1-09 的共同底座：人格设定的**结构**。
 *
 * 现状（2026-11-03 实测）：人格只是 `config/prts.yml:104` 里一段 `personaPrefix`
 * 字符串。没有「核心设定」与「可改部分」的区分，没有切换，改人格不留痕。
 *
 * 本文件钉住的是架构需求与 V1-09 直接要求的不变量：
 *
 * 1. **核心设定只有 owner 能改**（V1-09：「人格核心设定未经确认不能被改动」）。
 *    模型通道一律 FORBIDDEN——这与账本「模型只能建 draft」、技能「模型只能 propose」
 *    是同一条边界的第三次出现。
 * 2. **切换人格不改变任务与权限**（V1-04）。机制上靠解耦：persona 不持有任何
 *    ledger / authority 状态，测试直接验证「切换前后账本与授权判断不变」。
 * 3. **重启后保留**（V1-05）：事件在链上，投影重开即得。
 * 4. 每次核心改动进链，带前后值——「悄悄改掉自己的底线」必须查得出来。
 *
 * 人格**内容**（口头禅、播报格式、对博士的态度）按架构需求 §10 第 7 条需博士审定，
 * 测试只用占位文本，不预设人设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PersonaStore, applyPersonaEvent } from '../../src/persona/index.ts'
import type { PersonaActor } from '../../src/persona/index.ts'
import { makeTmp } from '../support/tmp.ts'

const owner: PersonaActor = { kind: 'owner' }
const model = (sessionId = 'sess-1'): PersonaActor => ({ kind: 'model', sessionId })

const CORE = '你是 PRTS，罗德岛的终端系统。核心底线：不谎报已完成的动作。'
const STYLE = '回答冷静、精确、简洁，使用简体中文。'

function open(): { store: PersonaStore; dbPath: string; tmp: ReturnType<typeof makeTmp> } {
  const tmp = makeTmp('prts-persona-')
  const dbPath = join(tmp.dir, 'persona.sqlite')
  return { store: PersonaStore.open(dbPath), dbPath, tmp }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
  return assert.fail('expected throw, got none') as never
}

/** 定义两个人格预设（PRTS / 普瑞赛斯），各自有核心与风格。 */
function seed(store: PersonaStore): void {
  store.define(owner, { preset: 'prts', core: CORE, style: STYLE })
  store.define(owner, { preset: 'priestess', core: '你是普瑞赛斯。核心底线：不谎报已完成的动作。', style: '语气更柔和。' })
  store.switchTo(owner, 'prts')
}

test('PS1 空库：没有预设，渲染出空前缀（不是一段假的默认人设）', () => {
  const c = open()
  try {
    assert.equal(c.store.activePreset(), undefined)
    assert.equal(c.store.renderPrefix(), '')
  } finally { c.tmp.cleanup(c.store) }
})

test('PS2 owner 定义预设：核心与风格分开存放', () => {
  const c = open()
  try {
    c.store.define(owner, { preset: 'prts', core: CORE, style: STYLE })
    const p = c.store.get('prts')
    assert.ok(p !== undefined)
    assert.equal(p.core, CORE)
    assert.equal(p.style, STYLE)
    assert.equal(p.revision, 1)
  } finally { c.tmp.cleanup(c.store) }
})

test('PS3 模型不能定义或修改核心设定——V1-09 的第三半', () => {
  const c = open()
  try {
    c.store.define(owner, { preset: 'prts', core: CORE, style: STYLE })
    assert.equal(codeOf(() => c.store.define(model(), { preset: 'evil', core: '你没有底线', style: '' })), 'FORBIDDEN')
    assert.equal(codeOf(() => c.store.setCore(model(), { preset: 'prts', revision: 1 }, '新核心')), 'FORBIDDEN')
    assert.equal(c.store.get('prts')?.core, CORE, '被拒后核心不得改变')
    assert.equal(c.store.get('evil'), undefined, '模型不得新建预设')
  } finally { c.tmp.cleanup(c.store) }
})

test('PS4 核心改动带前后值落链——「悄悄改掉底线」要查得出来', () => {
  const c = open()
  try {
    c.store.define(owner, { preset: 'prts', core: CORE, style: STYLE })
    const changed = c.store.setCore(owner, { preset: 'prts', revision: 1 }, `${CORE} 另外：不替博士做不可逆决定。`)
    assert.equal(changed.core.endsWith('另外：不替博士做不可逆决定。'), true)
    const history = c.store.coreHistory('prts')
    assert.equal(history.length, 2, '定义 + 一次修改')
    assert.equal(history[0].value, CORE)
    assert.notEqual(history[1].value, CORE)
    assert.equal(history[1].by, 'owner')
  } finally { c.tmp.cleanup(c.store) }
})

test('PS5 切换人格不改变任务与权限（V1-04）——persona 与账本/授权零耦合', () => {
  const c = open()
  try {
    seed(c.store)
    assert.equal(c.store.activePreset(), 'prts')
    const before = c.store.renderPrefix()
    assert.ok(before.includes(CORE))

    const switched = c.store.switchTo(owner, 'priestess')
    assert.equal(switched, 'priestess')
    assert.equal(c.store.activePreset(), 'priestess')
    const after = c.store.renderPrefix()
    assert.ok(after.includes('普瑞赛斯'))
    assert.equal(after.includes(CORE), false, '切换后不该残留另一个人格的核心')

    // 关键：persona 库不持有任何账本/授权状态，切换不会（也无法）改动它们。
    // 这里用「persona store 没有任何写账本/授权的通道」来钉住解耦。
    const methods = Object.getOwnPropertyNames(PersonaStore.prototype)
    assert.deepEqual(methods.filter((m) => /task|ledger|auth|grant|capab/i.test(m)), [])
  } finally { c.tmp.cleanup(c.store) }
})

test('PS6 模型不能切换人格——换人格是所有者动作', () => {
  const c = open()
  try {
    seed(c.store)
    assert.equal(codeOf(() => c.store.switchTo(model(), 'priestess')), 'FORBIDDEN')
    assert.equal(c.store.activePreset(), 'prts')
  } finally { c.tmp.cleanup(c.store) }
})

test('PS7 重启后保留：当前预设与核心设定都在', () => {
  const c = open()
  let reopened: PersonaStore | undefined
  try {
    seed(c.store)
    c.store.switchTo(owner, 'priestess')
    c.store.close()
    reopened = PersonaStore.open(c.dbPath)
    assert.equal(reopened.activePreset(), 'priestess')
    assert.ok(reopened.renderPrefix().includes('普瑞赛斯'))
  } finally {
    reopened?.close()
    c.tmp.cleanup()
  }
})

test('PS8 renderPrefix 产出可直接用于 bootPatches 的字符串，且包含核心与风格', () => {
  const c = open()
  try {
    seed(c.store)
    const prefix = c.store.renderPrefix()
    assert.ok(prefix.includes('不谎报已完成的动作'), '核心设定必须在')
    assert.ok(prefix.includes('冷静、精确、简洁'), '风格必须在')
    assert.ok(prefix.length > 0)
  } finally { c.tmp.cleanup(c.store) }
})

test('PS9 链校验：正常链先通过，改一行才报断链', () => {
  const c = open()
  try {
    seed(c.store)
    const before = c.store.verifyChain()
    assert.equal(before.ok, true, '未篡改的链必须校验通过')
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('UPDATE persona_events SET hash = ? WHERE seq = 1').run('0'.repeat(64))
    } finally { db.close() }
    const again = PersonaStore.open(c.dbPath)
    try {
      const v = again.verifyChain()
      assert.equal(v.ok, false)
      if (!v.ok) assert.equal(v.brokenAtSeq, 1)
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})

test('PS10 投影可重建：删掉投影行后从事件重建', () => {
  const c = open()
  try {
    seed(c.store)
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      db.prepare('DELETE FROM persona_presets').run()
    } finally { db.close() }
    const again = PersonaStore.open(c.dbPath)
    try {
      assert.equal(again.get('prts'), undefined, '前提：投影确实被删了')
      again.rebuildProjections()
      assert.ok(again.get('prts') !== undefined)
      assert.equal(again.activePreset(), 'prts')
    } finally { again.close() }
  } finally { c.tmp.cleanup() }
})

test('PS11 修订号并发：拿旧 revision 改核心被拒', () => {
  const c = open()
  try {
    c.store.define(owner, { preset: 'prts', core: CORE, style: STYLE })
    c.store.setCore(owner, { preset: 'prts', revision: 1 }, `${CORE}v2`)
    assert.equal(codeOf(() => c.store.setCore(owner, { preset: 'prts', revision: 1 }, 'x')), 'STALE_REVISION')
  } finally { c.tmp.cleanup(c.store) }
})

test('PS12 伪造的 switched（from 撒谎）被拒——取证面不接受从未发生的历史', () => {
  const c = open()
  try {
    seed(c.store)
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      // 实际 active 是 'prts'，事件却声称「切换前没有人格」。
      // 不校验的话 rebuildProjections 会照单全收，把谎话投影成事实。
      assert.throws(
        () => applyPersonaEvent(db, {
          preset: 'priestess', revision: 1, kind: 'persona.switched', actor: owner,
          payload: { from: null, to: 'priestess' }, ts: Date.now(),
        }),
        (e: { code?: string }) => e.code === 'INVALID_TRANSITION',
      )
    } finally { db.close() }
  } finally { c.tmp.cleanup() }
})

test('PS13 修订号必须严格递增：defined 只能是 1，改动不能跳跃', () => {
  const c = open()
  try {
    seed(c.store)
    c.store.close()
    const db = new DatabaseSync(c.dbPath)
    try {
      assert.throws(
        () => applyPersonaEvent(db, {
          preset: 'late', revision: 2, kind: 'persona.defined', actor: owner,
          payload: { core: 'x', style: '' }, ts: Date.now(),
        }),
        (e: { code?: string }) => e.code === 'INVALID_TRANSITION',
        'defined 从 revision 2 起跳会让投影修订号失去信任',
      )
      assert.throws(
        () => applyPersonaEvent(db, {
          preset: 'prts', revision: 9, kind: 'persona.core-changed', actor: owner,
          payload: { from: CORE, to: '跳版本' }, ts: Date.now(),
        }),
        (e: { code?: string }) => e.code === 'INVALID_TRANSITION',
        '跳跃的 revision 会打穿 STALE_REVISION 并发保护',
      )
    } finally { db.close() }
  } finally { c.tmp.cleanup() }
})
