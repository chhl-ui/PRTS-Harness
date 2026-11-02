/**
 * 产品口径参数扫描：索引预热之后，`semanticMinSim` / `semanticTopK` 还剩多少收益没拿到。
 *
 * 背景：`probe-index-e2e.mjs` 已证明索引修复生效（@8 30.5% → 33.9%），但算法上限是
 * 36.9%（`probe-recall-weighted.mjs` 的手工融合）。差 3pp 指向两个产品参数：
 *  - `semanticMinSim = 0.25`（注入层默认）会挡掉余弦 0.25 以下的候选；
 *  - `semanticTopK = limit * 3 = 15` 只让 15 条向量候选参与融合（探针用的是 64）。
 *
 * 判据：若某组配置回到 ≈36.9%，说明瓶颈从「索引覆盖」转移到「产品参数」，
 * 修 cap 是正确的第一步，但还需要放宽这两个旋钮。
 *
 * 用法：node --max-old-space-size=8192 --disable-warning=ExperimentalWarning \
 *   .rivet/scratch/probe-index-tune.mjs [N]
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, OllamaEmbedder } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const N = Number(process.argv[2] ?? '250')
const LIMIT = 15

const CONFIGS = [
  { name: 'minSim 0.25 / topK 15（当前生产）', minSim: 0.25, topK: 15 },
  { name: 'minSim 0    / topK 15', minSim: 0, topK: 15 },
  { name: 'minSim 0    / topK 64', minSim: 0, topK: 64 },
  { name: 'minSim 0.25 / topK 64', minSim: 0.25, topK: 64 },
]

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
  const tWarm = Date.now()
  const size = store.warmVectorIndex()
  console.log(`预热 ${size} 行 / ${((Date.now() - tWarm) / 1000).toFixed(1)}s`)

  const t0 = Date.now()
  for (const q of all) {
    const golds = []
    ;(q.haystack_sessions ?? []).forEach((s) => s.forEach((t) => {
      if (t.has_answer === true && typeof t.content === 'string') golds.push(t.content.slice(0, 60))
    }))
    if (golds.length === 0) continue
    const [qv] = await emb.embed([q.question])
    const r = { type: q.question_type, ranks: {} }
    for (const c of CONFIGS) {
      const hits = store.search({
        text: q.question, limit: LIMIT, includeOrigin: ['live'],
        queryVector: qv, semanticTopK: c.topK, semanticMinSim: c.minSim,
      })
      r.ranks[c.name] = rankOf(hits, golds)
    }
    rows.push(r)
  }
  console.log(`完成 ${rows.length} 题，${((Date.now() - t0) / 1000).toFixed(1)}s`)
} finally {
  store.close()
}

const n = rows.length
console.log(`\n=== 产品口径 @8 参数扫描（${n} 题，limit=${LIMIT}）===`)
for (const c of CONFIGS) {
  const hit = rows.filter((r) => inK(r.ranks[c.name], 8)).length
  console.log(`  ${c.name.padEnd(34)} ${String(hit).padStart(3)}/${n} = ${pct(hit, n)}%`)
}

const base = CONFIGS[0].name
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
console.log(`\n=== 相对当前生产的配对检验（A=${base}）===`)
for (const c of CONFIGS.slice(1)) {
  const onlyA = rows.filter((r) => inK(r.ranks[base], 8) && !inK(r.ranks[c.name], 8)).length
  const onlyB = rows.filter((r) => !inK(r.ranks[base], 8) && inK(r.ranks[c.name], 8)).length
  console.log(`  ${c.name.padEnd(34)} 只前 ${onlyA} / 只后 ${onlyB}，McNemar p = ${mcnemarExact(onlyA, onlyB).toFixed(4)}`)
}

const types = [...new Set(rows.map((r) => r.type))]
console.log('\n分型 @8')
console.log(`  ${'类型'.padEnd(28)}${'n'.padStart(4)}  ${CONFIGS.map((c) => c.name.slice(0, 12).padStart(14)).join('')}`)
for (const t of types) {
  const sub = rows.filter((r) => r.type === t)
  const cells = CONFIGS.map((c) => `${pct(sub.filter((r) => inK(r.ranks[c.name], 8)).length, sub.length)}%`.padStart(14))
  console.log(`  ${t.padEnd(28)}${String(sub.length).padStart(4)}  ${cells.join('')}`)
}
