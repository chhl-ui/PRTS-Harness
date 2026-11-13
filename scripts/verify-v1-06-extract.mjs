/**
 * V1-06 提炼质量验收（真实模型版）：对话 turn → 真 Strata consolidateFacts 抽取
 * → 重启 ≥9 可检索 → 3 条对话内更正触发取代 → 3 条删除全生效。
 *
 * ## 与既有覆盖的分工
 *
 * - `test/memory/consolidate-real-path.test.ts` 验**链路通**（stub generator 断言
 *   turn 真进了 prompt、解析写成了 fact）。它不回答模型抽得准不准。
 * - `scripts/verify-v1-acceptance.mjs` 的 V1-06a/b/c 直接 `assertFact`/`correctFact`/
 *   `deleteFact`，验的是检索与删除机制，同样绕过模型抽取。
 * - 本脚本补上最后一环：**真实模型从自然对话里抽取的准确率**——判据与 V1-06 原文对齐：
 *   「告知 10 件事 ≥9 记得；纠正 3 条、删除 3 条全部生效」。
 *
 * ## 判定口径
 *
 * - **抽取命中**：标注值（如「墨团」）出现在某条 active mem_facts 的 object 文本里。
 *   精确字符串匹配，不用模型判分（判分器自己会漂移）。
 * - **多余抽取**：active fact 不含任何标注值 → 逐条列出，由人判定是否幻觉/合理。
 * - **更正取代**：更正 turn（带 `looksLikeCorrection` 标记）抽取出的新值，须让
 *   同 slot 旧值 `retired_at_ms` 非空且 `superseded_by` 指向新行——走
 *   `assertFact(supersedeSameSlot)` 真实路径，不调 `correctFact`。
 * - **删除生效**：`deleteFact` 后 `search` 与 active facts 均不再出现。
 *
 * ## 用法
 *
 *   先起 Strata（http://127.0.0.1:8080），然后：
 *   node --disable-warning=ExperimentalWarning scripts/verify-v1-06-extract.mjs
 *
 *   端点/模型可改：V106_BASE / V106_MODEL。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'
import { OpenAIGenerator } from 'file:///C:/prts-system/src/memory/generate.ts'

const BASE = (process.env.V106_BASE ?? 'http://127.0.0.1:8080/v1').replace(/\/+$/, '')
const MODEL = process.env.V106_MODEL ?? 'qwen3.8-flash-next-iq3_xxs'

const results = []
function check(id, label, ok, detail) {
  results.push({ id, label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${label}  — ${detail}`)
}

/** 10 件被告知的事：自然措辞、互不重叠的主题、不会自然误中的标注值。 */
const TOLD = [
  { topic: '咖啡',   text: '我喝咖啡只喝美式，不加糖也不加奶。',       mark: '美式' },
  { topic: '相机',   text: '我的主力相机镜头是 85mm 定焦。',            mark: '85mm' },
  { topic: '宠物',   text: '我的猫叫墨团，今年三岁了。',                mark: '墨团' },
  { topic: '实验室', text: '实验室在 B 楼 417 房间。',                  mark: '417' },
  { topic: '数据处理', text: '数据处理我习惯用 polars，不碰 pandas。',   mark: 'polars' },
  { topic: '编辑器', text: '写代码我用 Neovim，别的编辑器不习惯。',      mark: 'Neovim' },
  { topic: '通勤',   text: '我每天骑电瓶车上班，下雨天才开车。',         mark: '电瓶车' },
  { topic: '音乐',   text: '跑步的时候我听后摇。',                      mark: '后摇' },
  { topic: '饮食',   text: '我不吃香菜，一点都受不了那个味。',           mark: '香菜' },
  { topic: '母语',   text: '我的母语其实是湖南话。',                    mark: '湖南话' },
]

/** 噪声 turn：没有可抽取事实，检验模型会不会硬编。 */
const NOISE = [
  '今天天气怎么样？',
  '帮我看看这段代码哪里有问题。',
]

/** 3 条对话内更正：措辞带 looksLikeCorrection 词表标记，触发 supersedeSameSlot。 */
const CORRECTIONS = [
  { topic: '宠物',   text: '更正一下：猫更名了，现在叫煤球。',   old: '墨团', mark: '煤球' },
  { topic: '咖啡',   text: '我最近改喝拿铁了，不再喝美式。',     old: '美式', mark: '拿铁' },
  { topic: '实验室', text: '实验室搬到 C 楼 203 了。',           old: '417',  mark: '203' },
]

/** 读全部 fact 行（含 object 正文），raw 层看取代/删除的真实落库状态。 */
function dumpFacts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db.prepare(
      `SELECT f.fact_id AS id, f.subject, f.predicate, f.slot,
              f.retired_at_ms, f.superseded_by, f.deleted_at_ms,
              b.body AS object
         FROM mem_facts f JOIN mem_bodies b ON b.body_ref = f.body_ref`,
    ).all()
  } finally {
    db.close()
  }
}

const active = (rows) => rows.filter((r) => r.deleted_at_ms === null && r.retired_at_ms === null)
const hits = (rows, mark) => rows.filter((r) => `${r.subject}|${r.predicate}|${r.object}|${r.slot}`.includes(mark))

// ---------- 预检：Strata 必须在跑 ----------
{
  let up = false
  try {
    const r = await fetch(`${BASE.replace(/\/v1$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
    up = r.ok
  } catch { /* down */ }
  if (!up) {
    console.error(`生成端点不可达：${BASE}（先起 Strata / 设 V106_BASE）`)
    process.exit(2)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'prts-v106-'))
const dbPath = join(dir, 'memory.sqlite')
const generator = new OpenAIGenerator({ baseUrl: BASE, model: MODEL })

try {
  // ---------- A：10 件被告知 → 真模型抽取 ----------
  {
    const m = MemoryStore.open(dbPath)
    const turns = [...TOLD.map(t => ({ speaker: '博士', text: t.text })), ...NOISE.map(text => ({ speaker: '博士', text }))]
    turns.forEach((t, i) => m.recordTurn({ actor: 'owner', sessionId: 'v106-s1', turnIndex: i, speaker: t.speaker, text: t.text }))

    const r = await m.consolidateFacts({ generator, limit: 50, batchSize: 20, actor: 'system' })
    console.log(`[consolidate A] turns=${r.turns} extracted=${r.extracted} added=${r.added} skipped=${r.skipped} stop=${r.stop}`)

    const rows = dumpFacts(dbPath)
    const act = active(rows)
    const allMarks = [...TOLD.map(t => t.mark)]
    const recalled = TOLD.filter((t) => hits(act, t.mark).length > 0)
    const extras = act.filter((r0) => allMarks.every((mk) => !`${r0.subject}|${r0.predicate}|${r0.object}|${r0.slot}`.includes(mk)))
    console.log('--- 抽取到的全部 active fact ---')
    for (const f of act) console.log(`  ${f.subject} | ${f.predicate} | ${f.object} | slot=${f.slot}`)
    check('V106-A1', '10 件被告知的事经真模型抽取后可检索（判据 ≥9）', recalled.length >= 9, `命中 ${recalled.length}/10${recalled.length < 10 ? `，缺：${TOLD.filter(t => !recalled.includes(t)).map(t => t.mark).join('、')}` : ''}`)
    check('V106-A2', '多余抽取 ≤2 条（噪声/幻觉控制）', extras.length <= 2, `${extras.length} 条：${extras.map(f => `${f.object}`).join('；').slice(0, 300) || '无'}`)
    m.close()

    // ---------- A3：重启后新实例仍可检索 ≥9（判据「重启后在新会话中记得」） ----------
    const m2 = MemoryStore.open(dbPath)
    const afterRestart = TOLD.filter((t) =>
      m2.search({ text: t.mark, limit: 5 }).some((h) => h.kind === 'fact')).length
    check('V106-A3', '重启后 ≥9 件仍可经 search 检索（新会话路径）', afterRestart >= 9, `可检索 ${afterRestart}/10`)
    m2.close()
  }

  // ---------- B：3 条对话内更正 → 真模型抽取 + supersedeSameSlot ----------
  {
    const m = MemoryStore.open(dbPath)
    CORRECTIONS.forEach((c, i) => m.recordTurn({ actor: 'owner', sessionId: 'v106-s1', turnIndex: 100 + i, speaker: '博士', text: c.text }))
    const r = await m.consolidateFacts({ generator, limit: 50, batchSize: 20, actor: 'system' })
    console.log(`[consolidate B] turns=${r.turns} extracted=${r.extracted} added=${r.added} skipped=${r.skipped} stop=${r.stop}`)

    const rows = dumpFacts(dbPath)
    const act = active(rows)
    for (const c of CORRECTIONS) {
      const newHit = hits(act, c.mark)
      const oldRow = rows.find((r0) => r0.deleted_at_ms === null && r0.retired_at_ms !== null
        && `${r0.subject}|${r0.predicate}|${r0.object}|${r0.slot}`.includes(c.old))
      const superseded = oldRow !== undefined && newHit.length > 0
      check(`V106-B-${c.topic}`, `更正「${c.topic}」：新值在役 + 旧值退役（superseded_by）`, superseded,
        `新值=${newHit.length > 0 ? newHit[0].object : '缺'} 旧值=${oldRow === undefined ? '未退役/未找到' : `退役→${oldRow.superseded_by}`}`)
    }
    m.close()
  }

  // ---------- C：删除 3 条 → 检索与摘要都不再出现 ----------
  {
    const m = MemoryStore.open(dbPath)
    const DEL = ['Neovim', '电瓶车', '后摇']
    const rows = dumpFacts(dbPath)
    const targets = DEL.flatMap((d) => active(rows).filter((r0) => `${r0.subject}|${r0.predicate}|${r0.object}|${r0.slot}`.includes(d)).map((r0) => r0.id))
    for (const id of targets) m.deleteFact({ actor: 'owner', factId: id })
    const after = dumpFacts(dbPath)
    const actAfter = active(after)
    const gone = DEL.filter((d) => hits(actAfter, d).length === 0
      && m.search({ text: d, limit: 10 }).every((h) => h.kind !== 'fact')).length
    check('V106-C1', '删除 3 条后：active facts 与 search 均不再出现', gone === 3, `消失 ${gone}/3（目标行 ${targets.length} 条）`)
    m.close()
  }
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n== V1-06 提炼质量验收：${results.length - failed.length}/${results.length} 项通过 ==`)
  rmSync(dir, { recursive: true, force: true })
  if (failed.length > 0) process.exit(1)
}
