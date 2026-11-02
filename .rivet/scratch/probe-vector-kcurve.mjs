/**
 * 向量路 k 曲线：@8 / @32 / @64 分型对照。
 *
 * 用途：判断「换更强的 embedding 模型」有没有提升空间。
 *  - 若 vec@32 远高于 vec@8 → 答案在候选池里但排不进前 8 = **排序精度**问题，
 *    更强的模型（更好的相似度）有机会改善。
 *  - 若 vec@32 也不高 → 池子里根本没有答案 = **召回覆盖**问题，换模型无效，
 *    要改的是索引结构（chunk 粒度/摘要层/多向量）。
 *
 * 与 probe-recall-weighted.mjs 同一加载与判分口径（gold = has_answer turn 正文前 60 字）。
 *
 * 用法：node --max-old-space-size=8192 --disable-warning=ExperimentalWarning \
 *   .rivet/scratch/probe-vector-kcurve.mjs [N]
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, OllamaEmbedder, decodeVector } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const N = Number(process.argv[2] ?? '250')
const POOL = 64

const dbRO = new DatabaseSync(DB, { readOnly: true })
console.log('加载 turn 正文与向量…')
const t0 = Date.now()
const bodies = new Map()
for (const r of dbRO.prepare(
  `SELECT t.turn_id AS tid, b.body AS body
     FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
    WHERE b.body IS NOT NULL`,
).all()) bodies.set(r.tid, String(r.body).slice(0, 60))
console.log(`  正文 ${bodies.size} 条 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

const rows = dbRO.prepare("SELECT owner_id, vector FROM mem_vectors WHERE owner_kind = 'turn'").all()
let DIM = 0
for (const r of rows) { DIM = decodeVector(r.vector).length; break }
if (DIM === 0) { console.log('没有 turn 向量'); process.exit(1) }
const ids = []
const flat = new Float32Array(rows.length * DIM)
for (let i = 0; i < rows.length; i++) {
  const v = decodeVector(rows[i].vector)
  let n = 0
  for (let d = 0; d < DIM; d++) n += v[d] * v[d]
  n = Math.sqrt(n) || 1
  const base = i * DIM
  for (let d = 0; d < DIM; d++) flat[base + d] = v[d] / n
  ids.push(rows[i].owner_id)
}
dbRO.close()
console.log(`  向量 ${ids.length} 条，维度 ${DIM}，累计 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const store = MemoryStore.open(DB)
const emb = new OllamaEmbedder()
const scores = new Float32Array(ids.length)
const all = JSON.parse(readFileSync(SRC, 'utf8')).slice(0, N)

function topKIds(K) {
  const top = []
  let kth = -Infinity
  for (let i = 0; i < ids.length; i++) {
    const s = scores[i]
    if (top.length < K) {
      top.push([i, s])
      if (top.length === K) { top.sort((a, b) => b[1] - a[1]); kth = top[K - 1][1] }
    } else if (s > kth) {
      top[K - 1] = [i, s]
      for (let j = K - 1; j > 0 && top[j][1] > top[j - 1][1]; j--) {
        const tmp = top[j]; top[j] = top[j - 1]; top[j - 1] = tmp
      }
      kth = top[K - 1][1]
    }
  }
  if (top.length < K) top.sort((a, b) => b[1] - a[1])
  return top.map(([i]) => ids[i])
}

const out = []
try {
  for (const q of all) {
    const golds = []
    ;(q.haystack_sessions ?? []).forEach((s) => s.forEach((t) => {
      if (t.has_answer === true && typeof t.content === 'string') golds.push(t.content.slice(0, 60))
    }))
    if (golds.length === 0) continue

    const bm = store.search({ text: q.question, limit: POOL, includeOrigin: ['live'] })
      .filter((h) => h.kind === 'turn').map((h) => h.id)
    const [qv] = await emb.embed([q.question])
    let qn = 0
    for (let d = 0; d < DIM; d++) qn += qv[d] * qv[d]
    qn = Math.sqrt(qn) || 1
    for (let i = 0; i < ids.length; i++) {
      const base = i * DIM
      let s = 0
      for (let d = 0; d < DIM; d++) s += flat[base + d] * (qv[d] / qn)
      scores[i] = s
    }
    const vec = topKIds(POOL)

    const rankOf = (list) => {
      for (let i = 0; i < list.length; i++) {
        const b = bodies.get(list[i])
        if (b !== undefined && golds.includes(b)) return i + 1
      }
      return -1
    }
    out.push({ type: q.question_type, bm: rankOf(bm), vec: rankOf(vec) })
  }
} finally {
  store.close()
}

const inK = (v, k) => v > 0 && v <= k
const pct = (a, b) => (a / b * 100).toFixed(1)
const types = [...new Set(out.map((r) => r.type))]
const n = out.length

console.log(`\n=== k 曲线分型对照（${n} 题，全库 ${ids.length} turn）===`)
console.log(`  ${'类型'.padEnd(26)}${'n'.padStart(4)}   ${['bm@8', 'bm@32', 'bm@64'].map((h) => h.padStart(7)).join('')} | ${['vec@8', 'vec@32', 'vec@64'].map((h) => h.padStart(8)).join('')}`)
const line = (label, sub) => {
  const cells = [8, 32, 64].map((k) => `${pct(sub.filter((r) => inK(r.bm, k)).length, sub.length)}%`.padStart(7))
  const vcells = [8, 32, 64].map((k) => `${pct(sub.filter((r) => inK(r.vec, k)).length, sub.length)}%`.padStart(8))
  console.log(`  ${label.padEnd(26)}${String(sub.length).padStart(4)}   ${cells.join('')} | ${vcells.join('')}`)
}
line('（全部）', out)
for (const t of types) line(t, out.filter((r) => r.type === t))

// 关键判据：向量路 @8 → @32 的增益倍数。>2 倍说明是排序问题，模型有空间。
console.log('\n=== 判据：vec@32 / vec@8 增益 ===')
for (const t of ['（全部）', ...types]) {
  const sub = t === '（全部）' ? out : out.filter((r) => r.type === t)
  const v8 = sub.filter((r) => inK(r.vec, 8)).length
  const v32 = sub.filter((r) => inK(r.vec, 32)).length
  if (v8 === 0) { console.log(`  ${t.padEnd(26)} vec@8=0，无法计算（n=${sub.length}）`); continue }
  const ratio = v32 / v8
  const verdict = ratio >= 2 ? '排序精度问题 → 更强模型有空间' : ratio >= 1.3 ? '混合' : '覆盖问题 → 换模型难改善'
  console.log(`  ${t.padEnd(26)} vec@8 ${v8} → vec@32 ${v32}（×${ratio.toFixed(2)}）  ${verdict}`)
}

// 未命中题的诊断：向量 top-64 里连一条 gold 都没有的比例
const miss = out.filter((r) => r.vec <= 0).length
console.log(`\n向量路前 64 完全无 gold 的题：${miss}/${n} = ${pct(miss, n)}%（这些题换什么模型都救不回，必须先改索引）`)
