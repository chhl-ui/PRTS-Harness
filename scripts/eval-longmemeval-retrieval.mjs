/**
 * V1-17 检索线跑分（LongMemEval s_cleaned，全库口径）。
 *
 * 口径与 `docs/design-memory-v1.md` §9.3 的 v2.8 基线一致：
 * - 库：`C:/prts-benchmark/memory-s.sqlite`（已导入 s_cleaned 全量 246,607 turn）
 * - 每题用**生产检索路径** `MemoryStore.search({ includeOrigin: ['benchmark'] })` 全库检索
 * - gold = `has_answer === true` 的 turnId（与导入侧的 `qid|sid|ti` 同一构造）
 * - any@K = gold 至少一条落进 top-K；all@K = 全部 gold 落进 top-K；MRR = 首个 gold 的倒数排名
 * - 无 gold 的题跳过（与既有探针一致），跳过数如实报出
 *
 * 用途：V1-17 要求「每次修改记忆或检索策略都重跑」。本脚本零 API 成本，
 * 只测检索层；端到端 QA 另用 `probe-e2e-fullcorpus.mjs`（需要模型）。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/eval-longmemeval-retrieval.mjs
 *   LIMIT_Q=20 node --disable-warning=ExperimentalWarning scripts/eval-longmemeval-retrieval.mjs
 *   OUT=C:/prts-benchmark/longmemeval/retrieval-2026-11-05.json node --disable-warning=ExperimentalWarning scripts/eval-longmemeval-retrieval.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = process.env.SRC ?? 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = process.env.DB ?? 'C:/prts-benchmark/memory-s.sqlite'
const LIMIT_Q = Number(process.env.LIMIT_Q ?? '0') // 0 = 全量
const K1 = 8
const K2 = 32
const OUT = process.env.OUT ?? null

const turnId = (qid, sid, ti) =>
  `turn-${createHash('sha256').update(`${qid}|${sid}|${ti}`).digest('hex').slice(0, 32)}`

const pct = (x, n) => `${((100 * x) / n).toFixed(1)}%`

const data = JSON.parse(readFileSync(SRC, 'utf8'))
const store = MemoryStore.open(DB)

const perType = new Map()
/** 逐题耗时的原始值——V1-16 的判据是 P95，只留 per-type 均值会把尾部掩掉。 */
const allMs = []
let n = 0
let skipped = 0
const t0 = Date.now()

for (const q of data) {
  if (LIMIT_Q > 0 && n >= LIMIT_Q) break
  const gold = []
  ;(q.haystack_sessions ?? []).forEach((list, si) => {
    const sid = q.haystack_session_ids?.[si] ?? si
    list.forEach((t, ti) => {
      if (t.has_answer === true) gold.push(turnId(q.question_id, sid, ti))
    })
  })
  if (gold.length === 0) {
    skipped += 1
    continue
  }

  const started = Date.now()
  const hits = store.search({ text: q.question, includeOrigin: ['benchmark'], limit: K2 })
    .filter((h) => h.kind === 'turn')
  const ms = Date.now() - started
  n += 1

  const top1 = hits.slice(0, K1).map((h) => h.id)
  const top2 = hits.map((h) => h.id)
  const any8 = gold.some((g) => top1.includes(g))
  const all8 = gold.every((g) => top1.includes(g))
  const any32 = gold.some((g) => top2.includes(g))
  const all32 = gold.every((g) => top2.includes(g))
  let rr = 0
  for (let i = 0; i < top2.length; i += 1) {
    if (gold.includes(top2[i])) {
      rr = 1 / (i + 1)
      break
    }
  }

  const type = q.question_type ?? 'unknown'
  const row = perType.get(type) ?? { n: 0, any8: 0, all8: 0, any32: 0, all32: 0, mrr: 0, ms: 0 }
  row.n += 1
  row.any8 += any8 ? 1 : 0
  row.all8 += all8 ? 1 : 0
  row.any32 += any32 ? 1 : 0
  row.all32 += all32 ? 1 : 0
  row.mrr += rr
  row.ms += ms
  allMs.push(ms)
  perType.set(type, row)
}
store.close()

const totalMs = Date.now() - t0
const rows = [...perType.entries()].sort((a, b) => b[1].n - a[1].n)
console.log(`题 ${n}（跳过无 gold ${skipped}），总耗时 ${(totalMs / 1000).toFixed(1)}s`)
console.log('源', SRC)
console.log('库', DB)
console.log(
  '题型'.padEnd(28) + 'n'.padStart(5) + 'any@8'.padStart(9) + 'all@8'.padStart(9)
  + 'any@32'.padStart(9) + 'all@32'.padStart(9) + 'MRR'.padStart(9) + 'ms/题'.padStart(9),
)

let N = 0
let A8 = 0
let L8 = 0
let A32 = 0
let L32 = 0
let MRR = 0
let MS = 0
for (const [type, r] of rows) {
  N += r.n
  A8 += r.any8
  L8 += r.all8
  A32 += r.any32
  L32 += r.all32
  MRR += r.mrr
  MS += r.ms
  console.log(
    type.padEnd(28) + String(r.n).padStart(5) + pct(r.any8, r.n).padStart(9)
    + pct(r.all8, r.n).padStart(9) + pct(r.any32, r.n).padStart(9) + pct(r.all32, r.n).padStart(9)
    + (r.mrr / r.n).toFixed(4).padStart(9) + String(Math.round(r.ms / r.n)).padStart(9),
  )
}
console.log(
  '加权'.padEnd(28) + String(N).padStart(5) + pct(A8, N).padStart(9) + pct(L8, N).padStart(9)
  + pct(A32, N).padStart(9) + pct(L32, N).padStart(9) + (MRR / N).toFixed(4).padStart(9)
  + String(Math.round(MS / N)).padStart(9),
)

// V1-16 的判据是 P95（不是均值）：均值会掩掉尾部。排序后就地取分位。
const sortedMs = [...allMs].sort((a, b) => a - b)
const percentile = (p) => {
  if (sortedMs.length === 0) return 0
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1))
  return sortedMs[idx]
}
const p50 = percentile(50)
const p95 = percentile(95)
console.log(`延迟分位（检索层，${sortedMs.length} 题）：p50 ${p50}ms / p95 ${p95}ms / max ${sortedMs[sortedMs.length - 1] ?? 0}ms`)

if (OUT !== null) {
  writeFileSync(OUT, JSON.stringify({
    src: SRC,
    db: DB,
    n: N,
    skipped,
    any8: A8 / N,
    all8: L8 / N,
    any32: A32 / N,
    all32: L32 / N,
    mrr: MRR / N,
    msPerQuestion: MS / N,
    latency: { p50, p95, max: sortedMs[sortedMs.length - 1] ?? 0 },
    totalMs,
    types: Object.fromEntries(rows),
  }, null, 2))
  console.log('saved', OUT)
}
