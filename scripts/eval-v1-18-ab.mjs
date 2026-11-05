/**
 * V1-18：宿主装配 vs 模型自管对比（LongMemEval s_cleaned 分层样本）。
 *
 * 两种模式，同一批题：
 * - `host`：默认宿主装配——memory-inject 每轮注入检索结果（top-k）。
 * - `self`：模型自管——`PRTS_MEMORY_INJECT_BUDGET=0` 关闭注入，模型用 `prts_memory_recall` 自行检索。
 *
 * 度量：QA 准确率（`scripts/eval-longmemeval.py` 判分，deepseek-reasoner）、
 * recall 调用次数、模型 token 用量、每题耗时。全部从**会话日志**读取，
 * 不靠内存计数（日志是落盘事实）。
 *
 * 库准备：复制 `memory-s.sqlite` 到临时 dataRoot 并把 `origin` 改成 `live`——
 * 生产检索只读 live（设计稿 §6.4），基准数据默认不进生产检索；这是探针的既有口径。
 *
 * 用法：
 *   N=3  node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs   # 冒烟
 *   N=10 node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs
 *   OUT=C:/prts-benchmark/v1-18-2026-11-05.json node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs
 */
import {
  readFileSync, writeFileSync, mkdtempSync, copyFileSync, existsSync, readdirSync, statSync, rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { startRuntime } from 'file:///C:/prts-system/src/runtime/start.ts'
import { runChat } from 'file:///C:/prts-system/src/cli/chat.ts'

const SRC = 'C:/prts-benchmark/longmemeval/longmemeval_s_cleaned.json'
const FULL_DB = 'C:/prts-benchmark/memory-s.sqlite'
const CONFIG = 'C:/prts-system/config/prts.yml'
const PROJECT = 'C:/prts-system'
const N = Number(process.env.N ?? '3')
const OUT = process.env.OUT ?? null

/** LOCAL=1：被测模型与判分都走本地 Ollama（零 API key）。 */
const LOCAL = process.env.LOCAL === '1'
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'q38-gsq-iq3s'

const keyFile = 'C:/prts-data/secrets/deepseek.key'
const apiKey = LOCAL
  ? 'ollama-local'
  : (process.env.DEEPSEEK_API_KEY
    ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined))
if (apiKey === undefined || apiKey === '') {
  console.error('需要 DEEPSEEK_API_KEY 或 C:/prts-data/secrets/deepseek.key（或 LOCAL=1 走本地 Ollama）')
  process.exit(2)
}
if (LOCAL) {
  process.env.DEEPSEEK_BASE_URL = OLLAMA_BASE
  process.env.PRTS_LLM_MODEL = OLLAMA_MODEL
  process.env.DEEPSEEK_API_KEY = apiKey
  // 本地模型实际窗口 32k（Ollama 默认 num_ctx）；不设会让 PRTS 按 1M 预算注入后被静默截断。
  process.env.DSH_CONTEXT_WINDOW = process.env.DSH_CONTEXT_WINDOW ?? '32768'
  console.log(`LOCAL 模式：base=${OLLAMA_BASE} model=${OLLAMA_MODEL}`)
}

const all = JSON.parse(readFileSync(SRC, 'utf8'))
const byType = new Map()
for (const q of all) {
  const t = q.question_type ?? 'unknown'
  if (!byType.has(t)) byType.set(t, [])
  byType.get(t).push(q)
}
const picks = []
const types = [...byType.keys()]
for (let i = 0; picks.length < N; i += 1) {
  let added = false
  for (const t of types) {
    const list = byType.get(t)
    if (i < list.length) {
      picks.push(list[i])
      added = true
      if (picks.length >= N) break
    }
  }
  if (!added) break
}
console.log(`抽样 ${picks.length} 题：${picks.map((q) => q.question_id).join(', ')}`)

const dataRoot = mkdtempSync(join(tmpdir(), 'v1-18-'))
const dbCopy = join(dataRoot, 'memory.sqlite')
console.log('复制基准库…')
copyFileSync(FULL_DB, dbCopy)
{
  const db = new DatabaseSync(dbCopy)
  db.exec("UPDATE mem_turns SET origin='live' WHERE origin='benchmark'")
  db.close()
}

async function* lines(...xs) {
  for (const x of xs) yield x
}

function findSessionFiles(root) {
  const out = []
  const walk = (d) => {
    let entries
    try { entries = readdirSync(d) } catch { return }
    for (const e of entries) {
      const p = join(d, e)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (e === 'session.v4.jsonl') out.push(p)
      } catch { /* 遍历间隙 */ }
    }
  }
  walk(root)
  return out
}

/** 从会话日志统计 recall 工具调用次数（usage 另走事件流，见 runMode）。 */
function statsFor(root, sessionId) {
  let recall = 0
  for (const f of findSessionFiles(join(root, 'dsh-home', 'sessions'))) {
    if (!f.includes(sessionId)) continue
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let r
      try { r = JSON.parse(line) } catch { continue }
      if (r.type !== 'assistant/message') continue
      for (const b of r.data?.message?.content ?? []) {
        if (b?.type === 'tool-call' && b.name === 'prts_memory_recall') recall += 1
      }
    }
  }
  return { recall }
}

async function runMode(mode) {
  const saved = process.env.PRTS_MEMORY_INJECT_BUDGET
  if (mode === 'self') process.env.PRTS_MEMORY_INJECT_BUDGET = '0'
  else delete process.env.PRTS_MEMORY_INJECT_BUDGET
  const app = await startRuntime({
    configPath: CONFIG,
    dataRoot,
    workspace: dataRoot,
    mode: 'normal',
    memoryDbPath: dbCopy,
    credentials: { DEEPSEEK_API_KEY: apiKey },
  })
  // usage 只走事件流：实测 DSH 不保证把 usage 写进 session 日志（部分回复没有该字段）。
  let usageIn = 0
  let usageOut = 0
  const offUsage = app.ctx.events?.on?.('agent/assistant-stream', (payload) => {
    const p = payload
    const chunk = p?.frame?.chunk
    if (p?.frame?.type !== 'chunk' || chunk?.type !== 'usage' || chunk.usage === undefined) return
    usageIn += chunk.usage.inputTokens ?? 0
    usageOut += chunk.usage.outputTokens ?? 0
  })
  const rows = []
  try {
    for (const q of picks) {
      const sessionId = `v18-${mode}-${q.question_id}`
      const t0 = Date.now()
      const inBefore = usageIn
      const outBefore = usageOut
      let r
      try {
        r = await runChat({
          ctx: app.ctx,
          lines: lines(q.question, '/exit'),
          out: () => {},
          cwd: dataRoot,
          dataRoot,
          sessionId,
          authority: app.authority,
          approvalBridge: app.approvalBridge,
        })
      } catch (error) {
        console.error(`[${mode}] ${q.question_id} 失败：${error instanceof Error ? error.message : String(error)}`)
        rows.push({
          qid: q.question_id, type: q.question_type, question: q.question,
          hypothesis: '', recallCalls: 0, inputTokens: 0, outputTokens: 0,
          ms: Date.now() - t0, error: String(error),
        })
        continue
      }
      const text = r.replies.join('\n').trim()
      const st = statsFor(dataRoot, sessionId)
      rows.push({
        qid: q.question_id, type: q.question_type, question: q.question,
        hypothesis: text, recallCalls: st.recall,
        inputTokens: usageIn - inBefore, outputTokens: usageOut - outBefore,
        ms: Date.now() - t0,
      })
      console.log(
        `[${mode}] ${q.question_id} ${q.question_type} turns=${r.turns}`
        + ` recall=${st.recall} in=${usageIn - inBefore} out=${usageOut - outBefore} ${Date.now() - t0}ms`,
      )
    }
  } finally {
    offUsage?.()
    await app.dispose()
  }
  if (saved === undefined) delete process.env.PRTS_MEMORY_INJECT_BUDGET
  else process.env.PRTS_MEMORY_INJECT_BUDGET = saved
  return rows
}

function judge(rows, tag) {
  const hypPath = join(dataRoot, `hyp-${tag}.jsonl`)
  writeFileSync(hypPath, rows.map((r) => JSON.stringify({
    question_id: r.qid, hypothesis: r.hypothesis,
  })).join('\n') + '\n')
  const judgeArgs = ['scripts/eval-longmemeval.py', '--hyp', hypPath, '--ref', SRC]
  if (LOCAL) judgeArgs.push('--model', OLLAMA_MODEL)
  const res = spawnSync('python', judgeArgs, {
    cwd: PROJECT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      ...(LOCAL ? { DEEPSEEK_API_BASE: `${OLLAMA_BASE}/v1` } : {}),
    },
    timeout: 1800000,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const m = out.match(/Accuracy: ([\d.]+)/)
  return { acc: m ? Number(m[1]) : null, log: out.slice(-1200) }
}

const hostRows = await runMode('host')
const selfRows = await runMode('self')
const hostJudge = judge(hostRows, 'host')
const selfJudge = judge(selfRows, 'self')

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length)
const summary = {
  n: picks.length,
  route: LOCAL ? `local:${OLLAMA_MODEL}@${OLLAMA_BASE}` : 'deepseek-official:deepseek-chat',
  judge: LOCAL ? `local:${OLLAMA_MODEL}` : 'deepseek-reasoner',
  host: {
    accuracy: hostJudge.acc,
    recallCalls: avg(hostRows.map((r) => r.recallCalls)),
    inputTokens: avg(hostRows.map((r) => r.inputTokens)),
    outputTokens: avg(hostRows.map((r) => r.outputTokens)),
    msPerQuestion: avg(hostRows.map((r) => r.ms)),
  },
  self: {
    accuracy: selfJudge.acc,
    recallCalls: avg(selfRows.map((r) => r.recallCalls)),
    inputTokens: avg(selfRows.map((r) => r.inputTokens)),
    outputTokens: avg(selfRows.map((r) => r.outputTokens)),
    msPerQuestion: avg(selfRows.map((r) => r.ms)),
  },
  rows: { host: hostRows, self: selfRows },
  judgeLogs: { host: hostJudge.log, self: selfJudge.log },
}
console.log(JSON.stringify({ n: summary.n, host: summary.host, self: summary.self }, null, 2))
if (OUT !== null) {
  writeFileSync(OUT, JSON.stringify(summary, null, 2))
  console.log('saved', OUT)
}
rmSync(dataRoot, { recursive: true, force: true })
