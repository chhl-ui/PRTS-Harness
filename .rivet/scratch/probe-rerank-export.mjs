/**
 * 导出 reranker 对照所需的候选池：每题 `store.search` 的前 32 条。
 *
 * 为什么单独导出：检索在 Node（MemoryStore），rerank 在 Python（CrossEncoder）。
 * 分两步跑，避免在 Node 里装 onnx/transformers。
 *
 * 输出 `/c/prts-benchmark/rerank-cands.json`：
 *   [{ id, type, question, golds: string[], cands: [{kind,id,text}] }]
 * 判定口径与其它探针一致：gold = has_answer turn 正文前 60 字。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { MemoryStore, OllamaEmbedder } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const OUT = 'C:/prts-benchmark/rerank-cands.json'
const N = Number(process.argv[2] ?? '250')
const POOL = 32

const store = MemoryStore.open(DB)
const emb = new OllamaEmbedder()
const all = JSON.parse(readFileSync(SRC, 'utf8')).slice(0, N)

const t0 = Date.now()
const size = store.warmVectorIndex()
console.log(`预热 ${size} 行 / ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const out = []
try {
  for (const q of all) {
    const golds = []
    ;(q.haystack_sessions ?? []).forEach((s) => s.forEach((t) => {
      if (t.has_answer === true && typeof t.content === 'string') golds.push(t.content.slice(0, 60))
    }))
    if (golds.length === 0) continue
    const [qv] = await emb.embed([q.question])
    const hits = store.search({
      text: q.question, limit: POOL, includeOrigin: ['live'],
      queryVector: qv, semanticTopK: POOL, semanticMinSim: 0.25,
    })
    out.push({
      id: q.question_id,
      type: q.question_type,
      question: q.question,
      golds,
      cands: hits.map((h) => ({ kind: h.kind, id: h.id, text: String(h.text ?? '').slice(0, 512) })),
    })
  }
} finally {
  store.close()
}

writeFileSync(OUT, JSON.stringify(out))
console.log(`导出 ${out.length} 题 → ${OUT}（${(JSON.stringify(out).length / 1024 / 1024).toFixed(2)} MB，${((Date.now() - t0) / 1000).toFixed(0)}s）`)
const pools = out.map((o) => o.cands.length)
console.log(`候选池大小：min ${Math.min(...pools)} / 中位 ${pools.slice().sort((a, b) => a - b)[Math.floor(pools.length / 2)]} / max ${Math.max(...pools)}`)
