#!/usr/bin/env node
/**
 * 记忆检索基线：LongMemEval → 检索 → 生成 hypothesis → 交判分器。
 *
 * ## 这条回路补的是什么
 *
 * 到 2026-11-01 为止，记忆模块已经有：导入（LoCoMo 5882 turn / LongMemEval 10960 turn）、
 * 检索（turn 级定位）、判分器（校准 88/88）。缺的是中间那段——
 * **把检索结果变成可判分的答案**。没有它，V1-17 的基线跑不出来。
 *
 * ## 三个刻意的选择
 *
 * 1. **检索按 question 文本做 LIKE**，不是按语义。这是设计稿 §6.5 的第一版约定，
 *    基线数字必须与它绑定——换检索后端时基线要重测。
 * 2. **答案由模型生成，不是直接抄 top-1**。LongMemEval 判的是 QA 准确率，
 *    抄片段测的是检索准确率，两者不能混。
 * 3. **模型说不知道就让它说**。abstention 题（30 道）的正确行为就是拒答，
 *    提示词里明确允许。
 *
 * ## 用法
 *
 *   export DEEPSEEK_API_KEY=$(cat /c/prts-data/secrets/deepseek.key)
 *   node scripts/eval-memory-baseline.mjs --ref <longmemeval_oracle.json> --out hyp.jsonl [--sample 10] [--limit 8]
 *
 * 输出 `{question_id, hypothesis}` jsonl，可直接交给 `scripts/eval-longmemeval.py` 判分。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { MemoryStore } from 'file:///C:/prts-system/src/memory/index.ts'

const API_BASE = 'https://api.deepseek.com/v1'
const MODEL = 'deepseek-chat'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const refPath = arg('ref')
const outPath = arg('out')
const sample = Number(arg('sample', '0'))
const limit = Number(arg('limit', '8'))
if (!refPath || !outPath) {
  console.error('用法: node eval-memory-baseline.mjs --ref <ref.json> --out <hyp.jsonl> [--sample N] [--limit K]')
  process.exit(2)
}

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) {
  console.error('错误：需要 DEEPSEEK_API_KEY')
  process.exit(2)
}

async function callModel(prompt) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      n: 1,
      temperature: 0,
      max_tokens: 256,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  return body.choices[0].message.content ?? ''
}

/** 时间怎么呈现：原始串优先（`2023/04/10 (Mon) 17:50` 带星期与精度），退回毫秒。 */
function fmtWhen(h) {
  if (typeof h.occurredRaw === 'string' && h.occurredRaw !== '') return h.occurredRaw
  if (typeof h.occurredAtMs === 'number') return new Date(h.occurredAtMs).toISOString().slice(0, 16).replace('T', ' ')
  return null
}

function buildPrompt(question, hits, questionDate) {
  const excerpts = hits.length === 0
    ? '(none)'
    : hits.map((h, i) => {
      const when = fmtWhen(h)
      return `[${i + 1}]${when === null ? '' : ` (${when})`} ${h.text}`
    }).join('\n')
  return `Answer the question using ONLY the retrieved memory excerpts below.
Each excerpt may carry the date/time it was said in parentheses — use those timestamps for any question about when something happened, how many days between events, or which came first.
Be concise — a short phrase or sentence. If the excerpts do not contain the answer, reply exactly: I don't know.
${questionDate ? `\nThe current date is ${questionDate}.` : ''}
Question: ${question}

Retrieved excerpts:
${excerpts}

Answer:`
}

const data = JSON.parse(readFileSync(refPath, 'utf8'))
// 分层抽样：数据集按 question_type 排列（前 10 题全是 temporal-reasoning），
// 直接 slice 会得到高度偏斜的样本。--stratified N 表示每型取 N 题。
const stratified = Number(arg('stratified', '0'))
let items
if (stratified > 0) {
  const byType = new Map()
  for (const x of data) {
    const t = x.question_type ?? 'unknown'
    if (!byType.has(t)) byType.set(t, [])
    byType.get(t).push(x)
  }
  items = []
  for (const [, arr] of byType) items.push(...arr.slice(0, stratified))
  console.log(`分层抽样：${byType.size} 型 × ${stratified} = ${items.length} 题`)
} else {
  items = sample > 0 ? data.slice(0, sample) : data
}
console.log(`题数: ${items.length}，每题检索 top-${limit}`)

const dbPath = arg('db', 'C:/prts-benchmark/memory-baseline.sqlite')
const store = MemoryStore.open(dbPath)
const tImport = Date.now()
const stats = store.importLongMemEval(data)
console.log(`导入: ${JSON.stringify(stats)}  (${Date.now() - tImport}ms)`)

const rows = []
const t0 = Date.now()
let noHits = 0
for (let i = 0; i < items.length; i++) {
  const q = items[i]
  const hits = store.search({
    text: q.question,
    includeOrigin: ['benchmark'],
    limit,
  })
  if (hits.length === 0) noHits++
  const hypothesis = await callModel(buildPrompt(q.question, hits, q.question_date))
  rows.push({ question_id: q.question_id, hypothesis: hypothesis.trim() })
  if ((i + 1) % 25 === 0 || i === items.length - 1) {
    console.log(`  [${i + 1}/${items.length}] 零命中累计 ${noHits}，耗时 ${Date.now() - t0}ms`)
  }
}

writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`\n写出 ${rows.length} 条 → ${outPath}`)
console.log(`零命中题数: ${noHits}/${items.length}（检索完全没召回到任何 turn）`)
store.close()
