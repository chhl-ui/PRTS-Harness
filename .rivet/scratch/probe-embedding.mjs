/**
 * 语义检索可行性验证（Wave 0 的剩余一半）。
 *
 * 已确认的事实（v2.15）：画像闸门修好后，画像能进结果（0→3 条），但**选不中对的**。
 * 120 条画像里含 Sony 的正确画像只有 1 条且内容完全正确，可问题说
 * "accessories / photography setup"、画像说 "shoots with / flash / tripod"——
 * 字面几乎不重叠，bm25 排不上来。
 *
 * 本探针只回答一个问题：**换成向量余弦相似度，那条正确的画像能排到第几？**
 * 不碰生产代码（不做 schema 变更），先用现有 120 条画像 + 3 道题验证方向。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const DB = 'C:/prts-benchmark/profile-probe.sqlite'
const REF = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const OLLAMA = 'http://127.0.0.1:11434/api/embeddings'
const MODEL = process.env.EMBED_MODEL ?? 'bge-m3'

async function embed(text) {
  const res = await fetch(OLLAMA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: text }),
  })
  if (!res.ok) throw new Error(`embed HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const j = await res.json()
  if (!Array.isArray(j.embedding)) throw new Error('embed 返回缺 embedding 字段')
  return j.embedding
}

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

const db = new DatabaseSync(DB, { readOnly: true })
const profiles = db.prepare('SELECT profile_id, profile_body FROM mem_profiles').all()
    .map((r) => ({ id: r.profile_id, text: r.profile_body }))
db.close()
console.log(`画像 ${profiles.length} 条，模型 ${MODEL}`)

// 逐条生成向量（本地推理，无 API 成本）
const t0 = Date.now()
for (const p of profiles) p.vec = await embed(p.text)
console.log(`向量化完成 ${Date.now() - t0}ms（${((Date.now() - t0) / profiles.length).toFixed(0)}ms/条）`)

const data = JSON.parse(readFileSync(REF, 'utf8'))
const items = data.filter((q) => q.question_type === 'single-session-preference').slice(0, 3)

for (const q of items) {
  const qv = await embed(q.question)
  const ranked = profiles
    .map((p) => ({ ...p, sim: cosine(qv, p.vec) }))
    .sort((a, b) => b.sim - a.sim)

  console.log(`\nQ: ${q.question.slice(0, 70)}`)
  console.log(`GOLD 关键: ${String(q.answer).slice(55, 150)}`)
  console.log('  向量 top-3:')
  ranked.slice(0, 3).forEach((r, i) => {
    console.log(`   ${i + 1}. [${r.sim.toFixed(3)}] ${r.text.slice(0, 100)}`)
  })
  // 关键字命中检查：正确画像是否进入 top-K
  const keywords = q.question_type === 'single-session-preference'
    ? [String(q.answer).match(/[A-Z][a-zA-Z]{4,}/g)?.[0] ?? ''].filter(Boolean)
    : []
  if (keywords.length > 0) {
    const rank = ranked.findIndex((r) => keywords.some((k) => r.text.includes(k)))
    console.log(`  含 "${keywords[0]}" 的画像排名: ${rank === -1 ? '不在库中' : (rank + 1) + ' / ' + ranked.length}`)
  }
}
