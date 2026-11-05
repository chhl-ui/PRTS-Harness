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
 * 本地端点（零 API key）：`LOCAL=1` 时被测模型与判分都走本机 NInfer
 * （`ninfer-kvmem-server`，同时提供 Anthropic `/v1/messages` 与 OpenAI
 * `/v1/chat/completions`，默认端口 18200）。地址与模型用 `LOCAL_BASE` / `LOCAL_MODEL`
 * 覆盖。2026-11-05 起本地端点由 Ollama 换为 NInfer——Ollama 变量不再读取。
 *
 * 断点续跑：每题完成即追加到 `<RUN_DIR>/progress.jsonl`；中断后用同一 `RUN_DIR`
 * 重跑会跳过已完成题（带 `error` 的题重试）。`hyp-<mode>.jsonl` 与判分器写出的
 * `eval-results-*` 都落在 RUN_DIR（不是临时目录），跑完不会被回收。
 *
 * 用法：
 *   LOCAL=1 N=3  node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs   # 冒烟
 *   LOCAL=1 N=100 RUN_DIR=C:/prts-benchmark/v1-18-n100-2026-11-05 \
 *     node --disable-warning=ExperimentalWarning scripts/eval-v1-18-ab.mjs
 *   OUT=... 覆盖 summary 路径（默认 <RUN_DIR>/summary.json）
 */
import {
  readFileSync, writeFileSync, appendFileSync, mkdtempSync, mkdirSync, copyFileSync,
  existsSync, readdirSync, statSync, rmSync,
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

/** LOCAL=1：被测模型与判分都走本机 NInfer（零 API key）。 */
const LOCAL = process.env.LOCAL === '1'
const LOCAL_BASE = process.env.LOCAL_BASE ?? 'http://127.0.0.1:18200'
const LOCAL_MODEL = process.env.LOCAL_MODEL ?? 'qwen3.8-27b-gsq-iq3s'

const today = new Date()
const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  + `-${String(today.getDate()).padStart(2, '0')}`
const RUN_DIR = process.env.RUN_DIR ?? join('C:/prts-benchmark', `v1-18-n${N}-${stamp}`)
const OUT = process.env.OUT ?? join(RUN_DIR, 'summary.json')
const PROGRESS_PATH = join(RUN_DIR, 'progress.jsonl')

const keyFile = 'C:/prts-data/secrets/deepseek.key'
const apiKey = LOCAL
  ? 'ninfer-local'
  : (process.env.DEEPSEEK_API_KEY
    ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : undefined))
if (apiKey === undefined || apiKey === '') {
  console.error('需要 DEEPSEEK_API_KEY 或 C:/prts-data/secrets/deepseek.key（或 LOCAL=1 走本机 NInfer）')
  process.exit(2)
}
if (LOCAL) {
  process.env.DEEPSEEK_BASE_URL = LOCAL_BASE
  process.env.PRTS_LLM_MODEL = LOCAL_MODEL
  process.env.DEEPSEEK_API_KEY = apiKey
  // 模型真实窗口 262144（/v1/models 的 context_length）；不设会让 PRTS 按配置默认
  // 1e6 算注入预算，超出模型能力。KVMem 的 KV 预算 36,864 token 是换页阈值，
  // 不是窗口上限——本轮每题输入约 9k token，不触发换页。
  process.env.DSH_CONTEXT_WINDOW = process.env.DSH_CONTEXT_WINDOW ?? '262144'
  console.log(`LOCAL 模式：base=${LOCAL_BASE} model=${LOCAL_MODEL} window=${process.env.DSH_CONTEXT_WINDOW}`)
}

mkdirSync(RUN_DIR, { recursive: true })
console.log(`RUN_DIR=${RUN_DIR}`)

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

/** 读回已完成题：`Map<mode, Map<qid, row>>`。 */
function loadProgress() {
  const byMode = new Map()
  if (!existsSync(PROGRESS_PATH)) return byMode
  for (const line of readFileSync(PROGRESS_PATH, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    const mode = entry?.mode
    const row = entry?.row
    if (typeof mode !== 'string' || typeof row?.qid !== 'string') continue
    if (!byMode.has(mode)) byMode.set(mode, new Map())
    byMode.get(mode).set(row.qid, row)
  }
  return byMode
}

function appendProgress(mode, row) {
  appendFileSync(PROGRESS_PATH, `${JSON.stringify({ mode, row })}\n`)
}

async function runMode(mode) {
  const doneMap = loadProgress().get(mode) ?? new Map()
  // 带 error 的行不算完成：重跑该题（多为端点临时抖动）。
  const pending = picks.filter((q) => {
    const done = doneMap.get(q.question_id)
    return done === undefined || done.error !== undefined
  })
  const results = new Map(doneMap)
  console.log(`[${mode}] 已完成 ${picks.length - pending.length}/${picks.length}，本次跑 ${pending.length} 题`)
  if (pending.length === 0) {
    return picks.map((q) => results.get(q.question_id)).filter((row) => row !== undefined)
  }
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
  // 端点崩溃时 runChat 不会抛错，只会把每道题跑成空回复（每题还要等一次超时）。
  // 连续 3 题无回复就中止本轮——已完成的题在 progress.jsonl 里，重启服务后续跑。
  let consecutiveErrors = 0
  try {
    for (const q of pending) {
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
        const row = {
          qid: q.question_id, type: q.question_type, question: q.question,
          hypothesis: '', recallCalls: 0, inputTokens: 0, outputTokens: 0,
          ms: Date.now() - t0, error: String(error),
        }
        results.set(row.qid, row)
        appendProgress(mode, row)
        consecutiveErrors += 1
        if (consecutiveErrors >= 3) {
          throw new Error('连续 3 题无回复（端点不可达？）——中止本轮，重启服务后用同一 RUN_DIR 续跑')
        }
        continue
      }
      const text = r.replies.join('\n').trim()
      const st = statsFor(dataRoot, sessionId)
      const row = {
        qid: q.question_id, type: q.question_type, question: q.question,
        hypothesis: text, recallCalls: st.recall,
        inputTokens: usageIn - inBefore, outputTokens: usageOut - outBefore,
        ms: Date.now() - t0,
        // 空回复 = 这轮没拿到答案（端点报错时 runChat 不抛，只记 agent error）。
        // 标 error 让续跑重试，也避免把「零回复」当成模型答错写进准确率。
        ...(text === '' ? { error: 'empty reply' } : {}),
      }
      results.set(row.qid, row)
      appendProgress(mode, row)
      // 空回复同样算「这一题没拿到结果」。它和直接抛错的区别只是 runChat 不抛，
      // 所以计数必须在这里也递增——否则端点崩了以后每道题都「成功」返回空串，
      // 计数器被重置，中止条件永远不会触发（实测白跑了 15 题，每题等 20s）。
      consecutiveErrors = row.error === undefined ? 0 : consecutiveErrors + 1
      if (consecutiveErrors >= 3) {
        throw new Error('连续 3 题无回复（端点不可达？）——中止本轮，重启服务后用同一 RUN_DIR 续跑')
      }
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
  return picks.map((q) => results.get(q.question_id)).filter((row) => row !== undefined)
}

/** 找判分器刚写出的逐题结果文件（文件名带 model / sample / ref 标签）。 */
function evalResultsPath(tag) {
  const prefix = `hyp-${tag}.jsonl.eval-results-`
  let found = null
  try {
    for (const e of readdirSync(RUN_DIR)) {
      if (e.startsWith(prefix)) found = join(RUN_DIR, e)
    }
  } catch { /* RUN_DIR 必然存在，读失败按没找到处理 */ }
  return found
}

function judge(rows, tag) {
  const hypPath = join(RUN_DIR, `hyp-${tag}.jsonl`)
  writeFileSync(hypPath, rows.map((r) => JSON.stringify({
    question_id: r.qid, hypothesis: r.hypothesis,
  })).join('\n') + '\n')
  const judgeArgs = ['scripts/eval-longmemeval.py', '--hyp', hypPath, '--ref', SRC]
  if (LOCAL) judgeArgs.push('--model', LOCAL_MODEL)
  const res = spawnSync('python', judgeArgs, {
    cwd: PROJECT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      ...(LOCAL ? { DEEPSEEK_API_BASE: `${LOCAL_BASE}/v1` } : {}),
    },
    // 每题一次判分调用：本地 27B 每题数秒，N=100 需要 20-50 分钟。
    timeout: Math.max(1800000, rows.length * 60000),
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const m = out.match(/Accuracy: ([\d.]+)/)
  return { acc: m ? Number(m[1]) : null, log: out.slice(-2000), evalResults: evalResultsPath(tag) }
}

const hostRows = await runMode('host')
const selfRows = await runMode('self')
const hostJudge = judge(hostRows, 'host')
const selfJudge = judge(selfRows, 'self')

const avg = (xs) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length)
const summary = {
  n: picks.length,
  route: LOCAL ? `local-ninfer:${LOCAL_MODEL}@${LOCAL_BASE}` : 'deepseek-official:deepseek-chat',
  judge: LOCAL ? `local-ninfer:${LOCAL_MODEL}` : 'deepseek-reasoner',
  runDir: RUN_DIR,
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
  evalResults: { host: hostJudge.evalResults, self: selfJudge.evalResults },
  rows: { host: hostRows, self: selfRows },
  judgeLogs: { host: hostJudge.log, self: selfJudge.log },
}
console.log(JSON.stringify({ n: summary.n, host: summary.host, self: summary.self }, null, 2))
writeFileSync(OUT, JSON.stringify(summary, null, 2))
console.log('saved', OUT)
rmSync(dataRoot, { recursive: true, force: true })
