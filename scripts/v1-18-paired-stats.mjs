/**
 * V1-18 配对统计：把「宿主装配 vs 模型自管」的逐题判定做成可判读的差异检验。
 *
 * 为什么需要独立脚本：`eval-longmemeval.py` 只报各模式的总准确率。总准确率差
 * 1-2 题在 n=30 时是噪声；只有把**同一题的两种结果配对**再做 McNemar，
 * 才能回答「差异是否超出抽样噪声」。同时给 Wilson 区间——单看一个百分数
 * 无法知道它有多稳。
 *
 * 输入：一个 RUN_DIR（`scripts/eval-v1-18-ab.mjs` 的输出目录），内含
 * `hyp-host.jsonl.eval-results-*` 与 `hyp-self.jsonl.eval-results-*`。
 *
 * 输出：控制台表格 + `<RUN_DIR>/paired-stats.json`。
 *
 * 用法：
 *   node scripts/v1-18-paired-stats.mjs RUN_DIR=C:/prts-benchmark/v1-18-n100-2026-11-05
 *   node scripts/v1-18-paired-stats.mjs C:/prts-benchmark/v1-18-n100-2026-11-05
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const runDir = process.argv[2] ?? process.env.RUN_DIR
if (runDir === undefined || runDir === '') {
  console.error('用法：node scripts/v1-18-paired-stats.mjs <RUN_DIR>')
  process.exit(2)
}
if (!existsSync(runDir)) {
  console.error(`RUN_DIR 不存在：${runDir}`)
  process.exit(2)
}

/** 找某个模式的逐题判分文件。 */
function findResults(tag) {
  const prefix = `hyp-${tag}.jsonl.eval-results-`
  for (const entry of readdirSync(runDir)) {
    if (entry.startsWith(prefix)) return join(runDir, entry)
  }
  return null
}

function loadJudged(tag) {
  const path = findResults(tag)
  if (path === null) return { path: null, map: new Map() }
  const map = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    const label = row?.autoeval_label?.label
    if (typeof row?.question_id !== 'string') continue
    // label 三态：true/false/null(invalid)。invalid 不进任何分母，单独计数。
    map.set(row.question_id, label === true || label === false ? label : null)
  }
  return { path, map }
}

const host = loadJudged('host')
const self = loadJudged('self')
const qids = [...host.map.keys()].filter((id) => self.map.has(id))

/** Wilson 95% 区间：比正态近似更稳，不会在 0%/100% 处给出负区间。 */
function wilson(successes, n) {
  if (n === 0) return { low: 0, high: 0 }
  const z = 1.959963984540054
  const p = successes / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/** 二项精确双尾 p（McNemar 的精确版）：X ~ Binom(n, 0.5)。 */
function binomialTwoSided(k, n) {
  if (n === 0) return 1
  const logFact = (x) => {
    let s = 0
    for (let i = 2; i <= x; i += 1) s += Math.log(i)
    return s
  }
  const logPmf = (x) => logFact(n) - logFact(x) - logFact(n - x) - n * Math.log(2)
  const kMin = Math.min(k, n - k)
  let tail = 0
  for (let x = 0; x <= kMin; x += 1) tail += Math.exp(logPmf(x))
  return Math.min(1, 2 * tail)
}

const cells = { bothCorrect: 0, hostOnly: 0, selfOnly: 0, bothWrong: 0 }
const invalid = { host: 0, self: 0 }
const perType = new Map()

for (const qid of qids) {
  const h = host.map.get(qid)
  const s = self.map.get(qid)
  if (h === null) { invalid.host += 1; continue }
  if (s === null) { invalid.self += 1; continue }
  if (h && s) cells.bothCorrect += 1
  else if (h && !s) cells.hostOnly += 1
  else if (!h && s) cells.selfOnly += 1
  else cells.bothWrong += 1
}

// 题型分层：从 summary.json 的 rows 取题面类型（判分文件里没有 type）。
let summaryRows = null
const summaryPath = join(runDir, 'summary.json')
if (existsSync(summaryPath)) {
  try { summaryRows = JSON.parse(readFileSync(summaryPath, 'utf8')).rows } catch { summaryRows = null }
}
if (summaryRows !== null) {
  const typeOf = new Map()
  for (const row of [...(summaryRows.host ?? []), ...(summaryRows.self ?? [])]) {
    if (typeof row?.qid === 'string' && typeof row?.type === 'string') typeOf.set(row.qid, row.type)
  }
  for (const qid of qids) {
    const h = host.map.get(qid)
    const s = self.map.get(qid)
    if (h === null || s === null || h === undefined || s === undefined) continue
    const type = typeOf.get(qid) ?? 'unknown'
    if (!perType.has(type)) perType.set(type, { n: 0, host: 0, self: 0, hostOnly: 0, selfOnly: 0 })
    const bucket = perType.get(type)
    bucket.n += 1
    if (h) bucket.host += 1
    if (s) bucket.self += 1
    if (h && !s) bucket.hostOnly += 1
    if (!h && s) bucket.selfOnly += 1
  }
}

const valid = qids.length - invalid.host - invalid.self
const hostCorrect = cells.bothCorrect + cells.hostOnly
const selfCorrect = cells.bothCorrect + cells.selfOnly
const discordant = cells.hostOnly + cells.selfOnly
const p = binomialTwoSided(cells.hostOnly, discordant)

const report = {
  runDir,
  files: { host: host.path, self: self.path },
  paired: qids.length,
  valid,
  invalid,
  accuracy: {
    host: { rate: valid === 0 ? null : hostCorrect / valid, correct: hostCorrect, ci95: wilson(hostCorrect, valid) },
    self: { rate: valid === 0 ? null : selfCorrect / valid, correct: selfCorrect, ci95: wilson(selfCorrect, valid) },
    diff: valid === 0 ? null : (hostCorrect - selfCorrect) / valid,
    diffCi95: null,
  },
  mcnemar: { ...cells, discordant, exactTwoSidedP: p },
  byType: Object.fromEntries([...perType.entries()].sort(([a], [b]) => a.localeCompare(b))),
}
// 差值的 95% 区间用配对比例的 Newcombe 近似（不一致对只有两格，不需要正态）。
{
  const n = valid
  if (n > 0) {
    const a = cells.bothCorrect
    const b = cells.hostOnly
    const c = cells.selfOnly
    const d = cells.bothWrong
    const diff = (b - c) / n
    const varTerm = ((b + c) / (n * n)) - ((b - c) ** 2 / (n ** 3))
    const se = Math.sqrt(Math.max(varTerm, 0))
    const z = 1.959963984540054
    report.accuracy.diffCi95 = { low: Math.max(-1, diff - z * se), high: Math.min(1, diff + z * se) }
  }
}

const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`)
console.log(`RUN_DIR ${runDir}`)
console.log(`配对题数 ${qids.length}，有效 ${valid}（host invalid ${invalid.host} / self invalid ${invalid.self}）`)
console.log('')
console.log('| 模式 | 正确 | 准确率 | Wilson 95% |')
console.log('|---|---|---|---|')
console.log(`| 宿主装配 | ${hostCorrect}/${valid} | ${pct(report.accuracy.host.rate)} | ${pct(report.accuracy.host.ci95.low)}–${pct(report.accuracy.host.ci95.high)} |`)
console.log(`| 模型自管 | ${selfCorrect}/${valid} | ${pct(report.accuracy.self.rate)} | ${pct(report.accuracy.self.ci95.low)}–${pct(report.accuracy.self.ci95.high)} |`)
console.log('')
console.log(`配对差 ${hostCorrect - selfCorrect} 题（${pct(report.accuracy.diff)}，95% CI ${pct(report.accuracy.diffCi95?.low ?? null)}–${pct(report.accuracy.diffCi95?.high ?? null)}）`)
console.log(`2x2：都对 ${cells.bothCorrect} / 仅宿主对 ${cells.hostOnly} / 仅自管对 ${cells.selfOnly} / 都错 ${cells.bothWrong}`)
console.log(`McNemar 精确双尾 p = ${p.toFixed(4)}（不一致对 ${discordant} 条）`)
if (perType.size > 0) {
  console.log('')
  console.log('| 题型 | n | 宿主 | 自管 | 仅宿主对 | 仅自管对 |')
  console.log('|---|---|---|---|---|---|')
  for (const [type, b] of [...perType.entries()].sort(([a], [c]) => a.localeCompare(c))) {
    console.log(`| ${type} | ${b.n} | ${b.host}/${b.n} | ${b.self}/${b.n} | ${b.hostOnly} | ${b.selfOnly} |`)
  }
}
writeFileSync(join(runDir, 'paired-stats.json'), JSON.stringify(report, null, 2))
console.log('')
console.log(`saved ${join(runDir, 'paired-stats.json')}`)
