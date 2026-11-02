/**
 * 产品口径端到端：`store.search` 的语义路在「未预热（cap 50k）」与「预热内存索引」下的差异。
 *
 * 与前两个探针的区别：
 *  - `probe-recall-weighted.mjs` 自己在探针里实现全量余弦，测的是**算法**上限；
 *  - 本探针走 `MemoryStore.search()` —— 与生产注入完全同一条代码路径，
 *    测的是**产品**实际给出的命中。
 *
 * 判据：预热后 @8 应从前一档（cap 50k 的约 30.9%）升到全量档（约 36.9%）。
 * 若两者相同，说明索引没有真正接入检索路径（修复未生效）。
 *
 * 用法：node --max-old-space-size=8192 --disable-warning=ExperimentalWarning \
 *   .rivet/scratch/probe-index-e2e.mjs [N]
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, OllamaEmbedder } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const N = Number(process.argv[2] ?? '250')
const LIMIT = 15 // 生产注入口径：limit * 3

const dbRO = new DatabaseSync(DB, { readOnly: true })
const bodies = new Map()
for (const r of dbRO.prepare(
  `SELECT t.turn_id AS tid, b.body AS body
     FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
    WHERE b.body IS NOT NULL`,
).all()) bodies.set(r.tid, String(r.body).slice(0, 60))
dbRO.close()

const store = MemoryStore.open(DB)
const emb = new OllamaEmbedder()
const all = JSON.parse(readFileSync(SRC, 'utf8')).slice(0, N)

const rankOf = (hits, golds) => {
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    if (h.kind !== 'turn') continue
    const b = bodies.get(h.id)
    if (b !== undefined && golds.includes(b)) return i + 1
  }
  return -1
}
const inK = (v, k) => v > 0 && v <= k
const pct = (a, b) => (a / b * 100).toFixed(1)

const rows = []
try {
  // ---- 冷路径：未预热，语义路受 SEMANTIC_SCAN_CAP 截断 ----
  console.log('未预热（SQL 降级路径，cap 50k）…')
  const tCold = Date.now()
  for (const q of all) {
    const golds = []
    ;(q.haystack_sessions ?? []).forEach((s) => s.forEach((t) => {
      if (t.has_answer === true && typeof t.content === 'string') golds.push(t.content.slice(0, 60))
    }))
    if (golds.length === 0) continue
    const [qv] = await emb.embed([q.question])
    const hits = store.search({
      text: q.question, limit: LIMIT, includeOrigin: ['live'],
      queryVector: qv, semanticTopK: LIMIT, semanticMinSim: 0.25,
    })
    rows.push({ id: q.question_id, type: q.question_type, cold: rankOf(hits, golds), warm: null })
  }
  console.log(`  完成 ${rows.length} 题，${((Date.now() - tCold) / 1000).toFixed(1)}s`)

  // ---- 预热 ----
  const tWarm = Date.now()
  const size = store.warmVectorIndex()
  const st = store.vectorIndexStatus()
  console.log(`预热：${size} 行 / dim ${st.dimension} / ${((Date.now() - tWarm) / 1000).toFixed(1)}s（跳过 ${st.skipped}）`)
  if (!st.ready) throw new Error('索引未就绪——本探针的结论不成立')

  // ---- 热路径 ----
  console.log('已预热（内存全量余弦）…')
  const tWarmQ = Date.now()
  for (const r of rows) {
    const q = all.find((x) => x.question_id === r.id)
    const golds = []
    ;(q.haystack_sessions ?? []).forEach((s) => s.forEach((t) => {
      if (t.has_answer === true && typeof t.content === 'string') golds.push(t.content.slice(0, 60))
    }))
    const [qv] = await emb.embed([q.question])
    const hits = store.search({
      text: q.question, limit: LIMIT, includeOrigin: ['live'],
      queryVector: qv, semanticTopK: LIMIT, semanticMinSim: 0.25,
    })
    r.warm = rankOf(hits, golds)
  }
  console.log(`  完成 ${rows.length} 题，${((Date.now() - tWarmQ) / 1000).toFixed(1)}s（${((Date.now() - tWarmQ) / rows.length).toFixed(2)}s/题）`)
} finally {
  store.close()
}

const n = rows.length
console.log(`\n=== 产品口径 @8（${n} 题，limit=${LIMIT}，含语义路）===`)
console.log(`  未预热（cap 50k）  ${rows.filter((r) => inK(r.cold, 8)).length}/${n} = ${pct(rows.filter((r) => inK(r.cold, 8)).length, n)}%`)
console.log(`  预热后（全量）     ${rows.filter((r) => inK(r.warm, 8)).length}/${n} = ${pct(rows.filter((r) => inK(r.warm, 8)).length, n)}%`)

const both = rows.filter((r) => inK(r.cold, 8) && inK(r.warm, 8)).length
const onlyCold = rows.filter((r) => inK(r.cold, 8) && !inK(r.warm, 8)).length
const onlyWarm = rows.filter((r) => !inK(r.cold, 8) && inK(r.warm, 8)).length
const neither = rows.filter((r) => !inK(r.cold, 8) && !inK(r.warm, 8)).length
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
console.log(`  配对：都中 ${both} | 只冷 ${onlyCold} | 只热 ${onlyWarm} | 都无 ${neither}`)
console.log(`  双向不一致 ${onlyCold + onlyWarm}，McNemar p = ${mcnemarExact(onlyCold, onlyWarm).toFixed(4)}`)

const types = [...new Set(rows.map((r) => r.type))]
console.log('\n分型 @8：未预热 → 预热后')
for (const t of types) {
  const sub = rows.filter((r) => r.type === t)
  const c = sub.filter((r) => inK(r.cold, 8)).length
  const w = sub.filter((r) => inK(r.warm, 8)).length
  console.log(`  ${t.padEnd(28)}n=${String(sub.length).padStart(3)}  ${pct(c, sub.length)}% → ${pct(w, sub.length)}%`)
}
