/**
 * 阅读阶段 A/B：同一批命中，「平铺」vs「归组成卡」喂给同一判分器，配对比较。
 *
 * 为什么必须这样测（口径依据）：
 *  - `organizeReading` 用 union-find 归组，**不删除、不压缩、不重排命中集合**——
 *    所以 recall@8 在数学上不可能因阅读阶段而变。roadmap 里「multi-session 分型
 *    recall@8 从 27.2% 提升」这条判据在阅读层不成立，属口径错配。
 *  - 唯一能验证阅读阶段价值的是端到端：这段上下文够不够写出满足 rubric 的答案。
 *    `probe-e2e-injection.mjs` 已用同一判分器测过「有注入 14/20」。
 *
 * 已知限制：n=20 的判分可答对率，±1 题不可解读（历史四组配置全落在 1 题内）。
 * 因此本探针给配对表 + McNemar 精确检验，而不是只报总数。
 *
 * 两组差异仅来自 `ReadingDeps`：{} = 旧平铺（与历史逐字一致）；
 * {factMeta, turnEntities} = 生产现状的归组路径。
 *
 * 用法：node --disable-warning=ExperimentalWarning .rivet/scratch/probe-reading-ab.mjs [N]
 */
import { readFileSync } from 'node:fs'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'
import { renderInjection } from 'file:///C:/prts-system/src/runtime/memory-inject.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const KEY = readFileSync('C:/prts-data/secrets/deepseek.key', 'utf8').trim()
const N = Number(process.argv[2] ?? '20')
const LIMIT = 5

async function judge(rubric, memory) {
  const prompt = `The text labelled "Rubric" describes what a CORRECT ANSWER must contain. It is a grading rubric, NOT an answer to be reproduced.

Given the retrieved memory items below, could a responder write an answer that satisfies that rubric?

Rubric: ${rubric}

Retrieved memory:
${memory}

Reply with exactly one word: yes or no.`
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 8 }),
  })
  if (!res.ok) throw new Error(`api ${res.status}: ${(await res.text()).slice(0, 150)}`)
  const j = await res.json()
  return String(j.choices?.[0]?.message?.content ?? '').trim().toLowerCase().startsWith('yes')
}

// ---- 分层抽样：与 probe-e2e-injection.mjs 完全同源，保证与历史 12/20 可比 ----
const all = JSON.parse(readFileSync(SRC, 'utf8'))
const byType = new Map()
for (const q of all) {
  if (!byType.has(q.question_type)) byType.set(q.question_type, [])
  byType.get(q.question_type).push(q)
}
const picked = []
for (let i = 0; picked.length < N; i++) {
  let added = false
  for (const list of byType.values()) {
    if (picked.length >= N) break
    const q = list[i]
    if (q !== undefined) { picked.push(q); added = true }
  }
  if (!added) break
}
console.log(`抽样 ${picked.length} 题：${JSON.stringify(
  picked.reduce((m, q) => { m[q.question_type] = (m[q.question_type] ?? 0) + 1; return m }, {}))}`)

const store = MemoryStore.open(DB)
const rows = []
let err = 0
try {
  for (const q of picked) {
    // 生产口径：`ranked = search({text, limit: limit*3, includeOrigin:['live']})`，
    // 取前 limit 条注入。本探针不开 PRTS_EMBED（与历史 12/20 基线同口径）。
    const ranked = store.search({ text: q.question, limit: LIMIT * 3, includeOrigin: ['live'] })
    const hits = ranked.slice(0, LIMIT)
    if (hits.length === 0) { console.log(`  ${q.question_id} 无命中，跳过`); continue }

    const factIds = hits.filter((h) => h.kind === 'fact').map((h) => h.id)
    const turnIds = hits.filter((h) => h.kind === 'turn').map((h) => h.id)
    const reading = {
      ...(factIds.length > 0 ? { factMeta: store.factMeta(factIds) } : {}),
      ...(turnIds.length > 0 ? { turnEntities: store.turnEntities(turnIds) } : {}),
    }
    const flatText = renderInjection(hits, {})
    const cardText = renderInjection(hits, reading)
    const same = flatText === cardText

    let flatYes = false
    let cardYes = false
    try {
      flatYes = await judge(q.answer, flatText)
      cardYes = await judge(q.answer, cardText)
    } catch (e) {
      err++
      console.log(`  ${q.question_id} 判分失败：${e.message}`)
      continue
    }
    rows.push({ id: q.question_id, type: q.question_type, same, flatYes, cardYes })
    console.log(`  ${q.question_id} [${q.question_type}] ${same ? '同文' : '成卡'} 平铺=${flatYes ? 'Y' : 'n'} 卡片=${cardYes ? 'Y' : 'n'}`)
  }
} finally {
  store.close()
}

const n = rows.length
const both = rows.filter((r) => r.flatYes && r.cardYes).length
const onlyFlat = rows.filter((r) => r.flatYes && !r.cardYes).length
const onlyCard = rows.filter((r) => !r.flatYes && r.cardYes).length
const neither = rows.filter((r) => !r.flatYes && !r.cardYes).length
const sameCount = rows.filter((r) => r.same).length

function comb(nn, kk) {
  if (kk < 0 || kk > nn) return 0
  const k = Math.min(kk, nn - kk)
  let r = 1
  for (let i = 1; i <= k; i++) r = r * (nn - k + i) / i
  return r
}
function mcnemarExact(b, c) {
  const total = b + c
  if (total === 0) return 1
  const k = Math.max(b, c)
  let tail = 0
  for (let i = k; i <= total; i++) tail += comb(total, i)
  return Math.min(1, 2 * (tail / Math.pow(2, total)))
}

const pct = (a, b) => (a / b * 100).toFixed(1)
console.log(`\n=== 阅读阶段 A/B（${n} 题，limit=${LIMIT}，全库 246k，判分=DeepSeek）===`)
console.log(`  组内文本完全相同的题 ${sameCount}/${n}（这些题无同主题命中可归并，阅读阶段对它们零影响）`)
console.log(`  平铺可答对 ${rows.filter((r) => r.flatYes).length}/${n} = ${pct(rows.filter((r) => r.flatYes).length, n)}%`)
console.log(`  成卡可答对 ${rows.filter((r) => r.cardYes).length}/${n} = ${pct(rows.filter((r) => r.cardYes).length, n)}%`)
console.log(`  配对：都中 ${both} | 只平铺 ${onlyFlat} | 只成卡 ${onlyCard} | 都无 ${neither}`)
console.log(`  双向不一致 ${onlyFlat + onlyCard}，McNemar p = ${mcnemarExact(onlyFlat, onlyCard).toFixed(4)}`)
console.log('\n=== 只看「真的成卡」的题（文本变化才是阅读阶段的处理对象）===')
const changed = rows.filter((r) => !r.same)
if (changed.length === 0) {
  console.log('  无成卡题——本批命中没有任何一组共享主题/会话，阅读阶段在本批上无作用面')
} else {
  const cBoth = changed.filter((r) => r.flatYes && r.cardYes).length
  const cFlat = changed.filter((r) => r.flatYes && !r.cardYes).length
  const cCard = changed.filter((r) => !r.flatYes && r.cardYes).length
  const cNone = changed.filter((r) => !r.flatYes && !r.cardYes).length
  console.log(`  n=${changed.length}  平铺 ${changed.filter((r) => r.flatYes).length} / 成卡 ${changed.filter((r) => r.cardYes).length}`)
  console.log(`  配对：都中 ${cBoth} | 只平铺 ${cFlat} | 只成卡 ${cCard} | 都无 ${cNone}，McNemar p = ${mcnemarExact(cFlat, cCard).toFixed(4)}`)
}
if (err > 0) console.log(`\n判分失败 ${err} 题（未计入）`)
