/**
 * 加权 RRF 混合召回：回答「bm25 : 向量 取什么权重，能在不牺牲 temporal 的前提下拿到混合收益」。
 *
 * 为什么要有这个探针：等权 RRF 实测 @8 34.7%（bm25 31.8%），但 temporal 从 64.7 → 52.9（−11.8pp），
 * 不能直接上线。roadmap 的判据是「@8 ≥ 34.7% 且 temporal ≥ 60%」。
 *
 * 设计要点：
 *  - 每题的 bm25 排名与向量排名只算一次（向量全量余弦 0.25 s/题），权重扫描在内存里做，
 *    六组权重不增加任何推理成本。
 *  - 组 [1, 0] 应复现 bm25 基线（31.8%），组 [1, 1] 应复现等权混合基线（34.7%）——
 *    两组落在基线附近才说明探针与历史口径一致，否则全部数字作废。
 *  - 额外测「时间词门控」：查询含时间词时只走 bm25，否则用加权混合。
 *
 * 用法：node --max-old-space-size=8192 --disable-warning=ExperimentalWarning \
 *   .rivet/scratch/probe-recall-weighted.mjs [N]
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore, OllamaEmbedder, decodeVector } from 'file:///C:/prts-system/src/memory/index.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const DB = 'C:/prts-benchmark/memory-s-vec.sqlite'
const N = Number(process.argv[2] ?? '250')
const RRF_K = 60
const POOL = 64

// [bm25 权重, 向量权重]
const WEIGHTS = [
  [1, 0],
  [1, 0.15],
  [1, 0.25],
  [1, 0.4],
  [1, 0.5],
  [1, 0.75],
  [1, 1],
  [0.5, 1],
  [0.25, 1],
]
const weightKey = (w) => `${w[0]}:${w[1]}`

// 时间/序数线索词：这类查询靠词面精确匹配，向量路会稀释名次
const TIME_QUERY = /(when|what year|what month|how long ago|how many (days|weeks|months|years)|first|last|latest|earliest|before|after|哪一?年|哪一?月|什么时候|何时|多久|几天|几个月|几年前|上次|上一次|最近|最早|最晚|之前|之后|先后)/i

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

// 模拟产品现状的扫描上限。store.ts 里 `SEMANTIC_SCAN_CAP = 50_000`，查询是
// `ORDER BY owner_kind, owner_id LIMIT 50000`——库里 833 条 profile 排在 turn 前，
// 于是 turn 只覆盖按 owner_id 升序的前 49,167 条，占全量 20%。若收益依赖全量扫描，
// 产品化就必须同时改掉这个上限，否则本次结论不成立。
const SCAN_CAP = Number(process.env.SCAN_CAP ?? '0')
const capIds = SCAN_CAP > 0
  ? new Set([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, SCAN_CAP))
  : null
if (capIds !== null) console.log(`  [对照] 向量扫描上限 ${SCAN_CAP} 条（全量 ${ids.length}，覆盖 ${(SCAN_CAP / ids.length * 100).toFixed(1)}%）`)

function topKIds(K) {
  // 部分选择：维护一个长度 K 的降序小数组。
  // 关键：阈值必须取自「已排序」的第 K 名。先填满再排序一次，之后用插入排序维持有序——
  // 若像旧探针那样在填充阶段就反复整数组 sort，246k 次会比较出上亿次；若只在填满时排一次，
  // 后续阈值判断会拿未排序的末元素当门槛，选出错误集合。
  const top = []
  let kth = -Infinity
  for (let i = 0; i < ids.length; i++) {
    const s = scores[i]
    if (top.length < K) {
      top.push([i, s])
      if (top.length === K) {
        top.sort((a, b) => b[1] - a[1])
        kth = top[K - 1][1]
      }
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
const tq = Date.now()
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
      if (capIds !== null && !capIds.has(ids[i])) { scores[i] = -Infinity; continue }
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

    const fused = {}
    for (const w of WEIGHTS) {
      const m = new Map()
      bm.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w[0] / (RRF_K + i + 1)))
      vec.forEach((id, i) => m.set(id, (m.get(id) ?? 0) + w[1] / (RRF_K + i + 1)))
      const order = [...m.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 32)
      fused[weightKey(w)] = rankOf(order)
    }

    const bmRank = rankOf(bm)
    const gated = {}
    for (const w of WEIGHTS) {
      const key = weightKey(w)
      gated[key] = TIME_QUERY.test(q.question) ? bmRank : fused[key]
    }

    out.push({
      type: q.question_type,
      timeQuery: TIME_QUERY.test(q.question),
      bm: bmRank,
      vec: rankOf(vec),
      fused,
      gated,
    })
  }
} finally {
  store.close()
}

const n = out.length
const hitK = (rowsIn, key, k) => rowsIn.filter((r) => {
  const v = key === 'fused' ? r.fused[key] : r[key]
  return v > 0 && v <= k
}).length

const pct = (a, b) => (a / b * 100).toFixed(1)

console.log(`\n=== 加权 RRF 扫描（${n} 题，全库 ${ids.length} turn，${((Date.now() - tq) / n / 1000).toFixed(2)} s/题）===`)
console.log('配置            @5      @8     @32')
const rowLine = (label, rowsIn) => {
  const nn = rowsIn.length
  const cells = [5, 8, 32].map((k) => `${pct(hitK(rowsIn, 'fused', k), nn)}%`.padStart(7))
  console.log(`${label.padEnd(14)}${cells.join(' ')}`)
}
console.log(`${'bm25 单路'.padEnd(14)}${[5, 8, 32].map((k) => `${pct(hitK(out, 'bm', k), n)}%`.padStart(7)).join(' ')}`)
console.log(`${'向量单路'.padEnd(14)}${[5, 8, 32].map((k) => `${pct(hitK(out, 'vec', k), n)}%`.padStart(7)).join(' ')}`)
for (const w of WEIGHTS) {
  const rowsIn = out
  const key = weightKey(w)
  const cells = [5, 8, 32].map((k) => `${pct(rowsIn.filter((r) => r.fused[key] > 0 && r.fused[key] <= k).length, n)}%`.padStart(7))
  console.log(`${`w ${key}`.padEnd(14)}${cells.join(' ')}`)
}

const types = [...new Set(out.map((r) => r.type))]
console.log('\n分型 @8（每格：bm25 / 向量 / 各权重）')
const head = ['bm25', 'vec', ...WEIGHTS.map((w) => weightKey(w))]
console.log(`  ${'类型'.padEnd(24)}n    ${head.map((h) => h.padStart(7)).join(' ')}`)
for (const t of types) {
  const sub = out.filter((r) => r.type === t)
  const cells = [
    pct(sub.filter((r) => r.bm > 0 && r.bm <= 8).length, sub.length) + '%',
    pct(sub.filter((r) => r.vec > 0 && r.vec <= 8).length, sub.length) + '%',
    ...WEIGHTS.map((w) => {
      const k = weightKey(w)
      return pct(sub.filter((r) => r.fused[k] > 0 && r.fused[k] <= 8).length, sub.length) + '%'
    }),
  ]
  console.log(`  ${t.padEnd(24)}${String(sub.length).padStart(3)}   ${cells.map((c) => c.padStart(7)).join(' ')}`)
}

// 时间词门控：含时间词的查询只走 bm25
console.log('\n=== 时间词门控（含时间词查询只走 bm25）===')
const tqCount = out.filter((r) => r.timeQuery).length
console.log(`  触发 ${tqCount}/${n} 题`)
for (const w of WEIGHTS) {
  const k = weightKey(w)
  if (k === '1:0') continue
  const gated = out.map((r) => ({ ...r, g: r.timeQuery ? r.bm : r.fused[k] }))
  const cells = [5, 8, 32].map((kk) => `${pct(gated.filter((r) => r.g > 0 && r.g <= kk).length, n)}%`.padStart(7))
  const temporal = gated.filter((r) => r.type === 'temporal-reasoning')
  const tCell = temporal.length === 0 ? 'n/a'
    : pct(temporal.filter((r) => r.g > 0 && r.g <= 8).length, temporal.length) + '%'
  console.log(`  门控 w ${k.padEnd(8)}${cells.join(' ')}   temporal@8 ${tCell}`)
}

// 分型差异显著性辅助：给出 @8 命中题数的绝对变化，便于判断是否只是噪声
console.log('\n=== @8 命中题数（绝对量，便于判断 ±1 题噪声）===')
for (const w of WEIGHTS) {
  const k = weightKey(w)
  const c = out.filter((r) => r.fused[k] > 0 && r.fused[k] <= 8).length
  console.log(`  w ${k.padEnd(8)} ${c}/${n}  (bm25 ${hitK(out, 'bm', 8)}/${n}，向量 ${hitK(out, 'vec', 8)}/${n})`)
}

// ---------------------------------------------------------------------------
// 配对显著性：McNemar 精确检验。
// 为什么必须做：这轮样本 236 题，±1 题的差异历史上完全不可解读（前序会话教训）。
// 不配对的百分比差无法区分「真的多命中」与「换了几道题命中」，只有配对表能分开。
// 判读：双向不一致数 (b + c) 越少、p 越小；p < 0.05 才算真实增益。
// ---------------------------------------------------------------------------
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
  tail /= Math.pow(2, total)
  return Math.min(1, 2 * tail)
}

const inK = (v, k) => v > 0 && v <= k

function paired(labelA, getA, getB, k) {
  let both = 0; let onlyA = 0; let onlyB = 0; let neither = 0
  for (const r of out) {
    const a = inK(getA(r), k)
    const b = inK(getB(r), k)
    if (a && b) both++
    else if (a) onlyA++
    else if (b) onlyB++
    else neither++
  }
  const p = mcnemarExact(onlyA, onlyB)
  const verdict = p < 0.01 ? '强烈' : p < 0.05 ? '显著' : p < 0.1 ? '边缘' : '不显著'
  console.log(`  ${labelA.padEnd(30)}@{k=${k}} 都中 ${both} | 只前 ${onlyA} | 只后 ${onlyB} | 都无 ${neither}`)
  console.log(`  ${''.padEnd(30)}       双向不一致 ${onlyA + onlyB}，McNemar p = ${p.toFixed(4)} → ${verdict}`)
  return { onlyA, onlyB, p }
}

console.log('\n=== 配对显著性（McNemar 精确检验）===')
const gatedGetter = (key) => (r) => r.gated[key]
console.log('A = bm25 单路，B = 候选方案')
paired('bm25 vs 门控 w 1:0.5', (r) => r.bm, gatedGetter('1:0.5'), 8)
paired('bm25 vs 门控 w 1:1', (r) => r.bm, gatedGetter('1:1'), 8)
paired('bm25 vs 门控 w 1:0.25', (r) => r.bm, gatedGetter('1:0.25'), 8)
paired('bm25 vs 等权混合(无门控)', (r) => r.bm, (r) => r.fused['1:1'], 8)
console.log('A = 等权混合(无门控)，B = 门控加权（检验门控是否真的修好了 temporal 损失）')
paired('等权混合 vs 门控 w 1:0.5', (r) => r.fused['1:1'], gatedGetter('1:0.5'), 8)
paired('等权混合 vs 门控 w 1:1', (r) => r.fused['1:1'], gatedGetter('1:1'), 8)
console.log('@32 视角（候选池大小对后续「阅读阶段」重要）')
paired('bm25 vs 门控 w 1:0.5', (r) => r.bm, gatedGetter('1:0.5'), 32)
paired('bm25 vs 等权混合(无门控)', (r) => r.bm, (r) => r.fused['1:1'], 32)

// ---------------------------------------------------------------------------
// 门控组分析：门控是否过宽？
// 时间词正则命中 52/236，但 temporal-reasoning 只有 17 题——另外 35 题是「问句里带时间词
// 但题型不是时间推理」。如果这 35 题在 bm25 下比在加权混合下更差，说明门控把有用的语义路挡掉了，
// 规则应收窄（例如只在问句同时含序数/时长才拦）。
// ---------------------------------------------------------------------------
console.log('\n=== 门控组分析（@8）：被拦进 bm25 的题，混合路本来能否命中 ===')
const g = (r) => r.gated['1:0.5']
for (const [label, pred] of [
  ['含时间词（被门控拦下）', (r) => r.timeQuery],
  ['不含时间词（走加权混合）', (r) => !r.timeQuery],
]) {
  const sub = out.filter(pred)
  const bmHits = sub.filter((r) => inK(r.bm, 8)).length
  const mixHits = sub.filter((r) => inK(r.fused['1:0.5'], 8)).length
  const gHits = sub.filter((r) => inK(g(r), 8)).length
  const types = {}
  for (const r of sub) types[r.type] = (types[r.type] ?? 0) + 1
  console.log(`  ${label} n=${sub.length}  bm25 ${bmHits}  加权混合 ${mixHits}  门控后 ${gHits}`)
  console.log(`      组成：${Object.entries(types).map(([k2, v]) => `${k2} ${v}`).join(' · ')}`)
}

// 门控后的分型：决定产品默认权重，不能只看总数。
// 总数相同但分型不同意味着「救哪一类」不同；preference 是当前最短板（3.3%），
// 在总数不变的前提下优先救它。
console.log('\n=== 门控后分型 @8（每格：总命中 / 分型命中）===')
const head2 = WEIGHTS.filter((w) => w[1] !== 0).map((w) => weightKey(w))
console.log(`  ${'类型'.padEnd(26)}n    ${head2.map((h) => h.padStart(10)).join(' ')}`)
console.log(`  ${'（总）'.padEnd(26)}${String(n).padStart(3)}   ${head2.map((h) => `${pct(out.filter((r) => inK(r.gated[h], 8)).length, n)}%`.padStart(10)).join(' ')}`)
for (const t of types) {
  const sub = out.filter((r) => r.type === t)
  const cells = head2.map((h) => `${pct(sub.filter((r) => inK(r.gated[h], 8)).length, sub.length)}%`.padStart(10))
  console.log(`  ${t.padEnd(26)}${String(sub.length).padStart(3)}   ${cells.join(' ')}`)
}
