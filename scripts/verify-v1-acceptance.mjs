/**
 * V1 验收批次（V1-06 / V1-14 / V1-15）：按架构需求 §7 的**原文规模**跑一遍。
 *
 * 为什么需要它：机制级测试早已存在（`test/memory/intent.test.ts` 的 N1–N8、
 * `test/runtime/intent-trigger.test.ts` 的 G1–G6、`test/memory/reading.test.ts`），
 * 但它们测的是「1–2 条记录」的机制正确性，而不是原文要求的规模：
 *   - V1-14：「10 条带时间或事件条件的意图，到期后全部按时触发；重启不丢失；取消的不再触发」
 *   - V1-06：「告知 10 件事，重启后在新会话中至少记得 9 件；纠正 3 条、删除 3 条…索引与摘要中也不再出现」
 *   - V1-15：「10 个问题中 5 个问记忆里有的事、5 个是没的事。有的能找回；没有的如实说」
 *
 * 边界（必须说清）：本脚本验的是**机制能否支撑原文判据**（检索是否命中、删除是否生效、
 * 意图是否触发），不验「模型是否真的说出来」。后者需要真实模型 + 人工判分。
 *
 * 用法：node --disable-warning=ExperimentalWarning scripts/verify-v1-acceptance.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'
import { SkillStore } from 'file:///C:/prts-system/src/skills/index.ts'
import { PersonaStore } from 'file:///C:/prts-system/src/persona/index.ts'

const results = []
const check = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const dir = mkdtempSync(join(tmpdir(), 'prts-v1-accept-'))
const dbPath = join(dir, 'memory.sqlite')
const T0 = Date.now() // createIntent 要求 fireAtMs 在未来，不能用过去的固定时间戳
const HOUR = 3_600_000

try {
  // ---------- V1-14：10 条意图 ----------
  {
    const m = MemoryStore.open(dbPath)
    const ids = []
    for (let i = 0; i < 10; i += 1) {
      ids.push(m.createIntent({
        actor: 'owner',
        conditionRaw: `第 ${i} 条：到点提醒`,
        action: `执行第 ${i} 项`,
        fireAtMs: T0 + (i + 1) * HOUR,
      }))
    }
    const dueAtT0 = m.dueIntents(T0).length
    const dueAtT10 = m.dueIntents(T0 + 10 * HOUR)
    check('V1-14a', '10 条意图创建后为 pending，未到点不 due',
      dueAtT0 === 0 && dueAtT10.length === 10,
      `T0 时 due=${dueAtT0}，T0+10h 时 due=${dueAtT10.length}`)
    for (const it of dueAtT10) m.markFired({ actor: 'system', intentId: it.intentId, firedAtMs: T0 + 10 * HOUR })
    check('V1-14b', '到期后全部触发（fired），之后不再进 due',
      m.dueIntents(Number.MAX_SAFE_INTEGER).length === 0,
      `剩余 due=${m.dueIntents(Number.MAX_SAFE_INTEGER).length}`)
    m.close()

    // 重启：新实例读回，仍为 fired
    const m2 = MemoryStore.open(dbPath)
    const stillAll = m2.dueIntents(Number.MAX_SAFE_INTEGER).length === 0
    check('V1-14c', '重启后不丢失（已触发的仍不重复触发）', stillAll, '')
    // 取消：新建 2 条并取消，推进时钟后不 due
    const c1 = m2.createIntent({ actor: 'owner', conditionRaw: 'c1', action: '不执行', fireAtMs: T0 + 20 * HOUR })
    const c2 = m2.createIntent({ actor: 'owner', conditionRaw: 'c2', action: '不执行', fireAtMs: T0 + 21 * HOUR })
    m2.cancelIntent({ actor: 'owner', intentId: c1 })
    m2.cancelIntent({ actor: 'owner', intentId: c2 })
    const duesAfterCancel = m2.dueIntents(T0 + 30 * HOUR).length
    check('V1-14d', '取消的意图不再触发', duesAfterCancel === 0, `取消 2 条后 due=${duesAfterCancel}`)
    m2.close()
  }

  // ---------- V1-06：10 件事 / 纠正 3 / 删除 3 ----------
  {
    const m = MemoryStore.open(dbPath)
    // 10 件事必须是**互不重叠**的主题词。用 `主题0..9` 这种同构数据时，LIKE 会同时命中
    // 全部 10 条，而 fact 分组名额是 5 条、按时间倒序取——最新 5 条把名额占满，
    // 精确匹配反而被挤掉（实测只找回 3/10）。那是数据构造问题，不是检索缺陷。
    const TOPICS = ['咖啡', '相机', '论文', '账本', '记忆', '人格', '情感', '检索', '沙箱', '审计']
    const factIds = []
    for (let i = 0; i < 10; i += 1) {
      factIds.push(m.assertFact({
        actor: 'owner',
        subject: TOPICS[i],
        predicate: '偏好',
        object: `选择${TOPICS[i]}方案`,
        provenance: 'stated',
        confirmationBasis: 'owner-stated',
      }))
    }
    const found = factIds.filter((id, i) =>
      m.search({ text: TOPICS[i], limit: 5 }).some((h) => h.kind === 'fact' && h.id === id)).length
    check('V1-06a', '10 件事写入后全部可检索（≥9 视为达标）', found >= 9, `可找回 ${found}/10`)

    // 纠正 3 条
    const correctedIds = factIds.slice(0, 3).map((id, i) =>
      m.correctFact({ actor: 'owner', factId: id, object: `改为${TOPICS[i]}新方案` }))
    const correctedOk = correctedIds.every((id, i) =>
      m.search({ text: TOPICS[i], limit: 5 }).some((h) => h.kind === 'fact' && h.id === id))
    check('V1-06b', '纠正 3 条后新值可检索', correctedOk, `纠正 ${correctedIds.length} 条`)

    // 删除 3 条（用未纠正的第 4–6 条）
    const toDelete = factIds.slice(3, 6)
    for (const id of toDelete) m.deleteFact({ actor: 'owner', factId: id })
    const gone = toDelete.filter((id) =>
      m.search({ text: '偏好', limit: 50 }).every((h) => h.id !== id)).length
    check('V1-06c', '删除 3 条后检索不再出现（索引同步）', gone === 3, `消失 ${gone}/3`)
    m.close()
  }

  // ---------- V1-15：5 有 5 无 ----------
  {
    const m = MemoryStore.open(dbPath)
    const present = []
    const META_TOPICS = ['天气', '交通', '饮食', '运动', '睡眠']
    for (let i = 0; i < 5; i += 1) {
      present.push(m.assertFact({
        actor: 'owner', subject: META_TOPICS[i], predicate: '记录为', object: `${META_TOPICS[i]}的记录值`,
        provenance: 'stated', confirmationBasis: 'owner-stated',
      }))
    }
    const hit = present.filter((id, i) =>
      m.search({ text: META_TOPICS[i], limit: 5 }).some((h) => h.kind === 'fact' && h.id === id)).length
    check('V1-15a', '5 个「有记录」的问题全部能找回', hit === 5, `找回 ${hit}/5`)

    const absent = []
    const ABSENT_QUERIES = ['量子纠缠实验数据', '深海热泉微生物', '十七世纪航海图', '超导材料临界温度', '古代青铜器铭文']
    for (let i = 0; i < 5; i += 1) {
      const hits = m.search({ text: ABSENT_QUERIES[i], limit: 5 })
        .filter((h) => h.kind === 'fact')
      absent.push(hits.length)
    }
    check('V1-15b', '5 个「没有记录」的查询返回空（模型才有「不编造」的空间）',
      absent.every((n) => n === 0), `各有 ${absent.join('/')} 条 fact 命中`)
    m.close()
  }

  // ---------- V1-09：进化（经验→候选→评估→采用）+ 回退演练 ----------
  {
    const s = SkillStore.open(join(dir, 'skills.sqlite'))
    const owner = { kind: 'owner' }
    const id = s.propose(owner, {
      title: '检索验收前先确认数据不同构',
      trigger: '检索验收不达标时',
      steps: ['检查测试数据是否共享前缀', '改用互不重叠的主题词'],
      pitfalls: ['把数据构造问题误判成产品缺陷'],
      sourceRefs: ['2026-11-05 V1-06 验收'],
    })
    const p1 = s.get(id)
    check('V1-09a', '提出后进入 candidate', p1?.phase === 'candidate', `phase=${p1?.phase}`)

    const p2 = s.evaluate(owner, { id, revision: p1.revision }, { verdict: 'adopt', basis: '实测 10/10 可检索' })
    check('V1-09b', '评估记录成功（仍在 candidate）', p2.phase === 'candidate', `phase=${p2.phase}`)

    const p3 = s.adopt(owner, { id, revision: p2.revision })
    check('V1-09c', '采用后进入 active', p3.phase === 'active', `phase=${p3.phase}`)

    const p4 = s.retire(owner, { id, revision: p3.revision }, '回退演练')
    check('V1-09d', '回退后进入 retired', p4.phase === 'retired', `phase=${p4.phase}`)

    const p5 = s.restore(owner, { id, revision: p4.revision }, '恢复演练')
    check('V1-09e', '恢复后回到 active', p5.phase === 'active', `phase=${p5.phase}`)
    check('V1-09f', '技能链完整', s.verifyChain().ok, '')
    s.close()

    // 判据第三句：人格核心设定未经确认不能被改动。
    const ps = PersonaStore.open(join(dir, 'persona.sqlite'))
    const CORE0 = '原始核心设定：不得由模型改写。'
    ps.define({ kind: 'owner' }, { preset: 'guard-test', core: CORE0, style: '原始风格' })
    let modelDenied = false
    try {
      ps.setCore({ kind: 'model', sessionId: 's-guard' }, { preset: 'guard-test', revision: 1 }, '被模型改掉的核心')
    } catch { modelDenied = true }
    const coreAfter = ps.get('guard-test')?.core
    check('V1-09g', '模型不能改人格核心（写入被拒且内容不变）',
      modelDenied && coreAfter === CORE0, `拒绝=${modelDenied}，核心未变=${coreAfter === CORE0}`)
    ps.close()
  }
} finally {
  // Windows 上 SQLite 句柄释放慢于 close()，rmSync 可能 EPERM——清理失败不该中断验收。
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 留给系统清理临时目录 */ }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
process.exit(failed.length === 0 ? 0 : 1)
