/**
 * V1-08 验收：单次对话超过模型窗口 3 倍长度后，仍能正确回答开头确认过的 5 个约束。
 * 原文见 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §7 V1-08。
 *
 * ## 判据三段，缺一不算过
 *
 * A1 **确实超过 3 倍窗口**：最终 `tokenMeter.measure` >= 3 × 窗口。没有这一条，
 *    「答对了」可能只是窗口根本没满。
 * A2 **期间至少发生一次压缩**：会话日志里出现 `compaction/summary`。没有这一条，
 *    测的是「长上下文」，不是「超窗口」——V1-08 要的正是压缩之后还记得。
 * A3 **模型答出全部 5 个约束值**：逐字匹配，不用 LLM 判分（判分器自己会漂移）。
 *
 * ## 为什么窗口调小
 *
 * 真实窗口 1M，3 倍是 3M token——跑不起，也不需要：压缩与回填的机制与长度无关，
 * 用 `DSH_CONTEXT_WINDOW` 把窗口压到 8000，3 倍即 24K token，几分钟能跑完。
 * 这个值同时驱动注入预算（`start.ts` 的 `resolveTokenBudget`）与 adapter 的
 * `defaultContextWindow`（`config/prts.yml:20`），所以压缩基准也跟着变——
 * 正是验收需要的「窗口」。
 *
 * 用法：
 *   node --disable-warning=ExperimentalWarning scripts/verify-v1-08.mjs
 *   V108_WINDOW=4000 V108_MAX_ROUNDS=8 node ... scripts/verify-v1-08.mjs   # 冒烟
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime } from 'file:///C:/prts-system/src/runtime/start.ts'
import { runChat } from 'file:///C:/prts-system/src/cli/chat.ts'

const WINDOW = Number(process.env.V108_WINDOW ?? '8000')
const MAX_FILL_ROUNDS = Number(process.env.V108_MAX_ROUNDS ?? '60')
const FILL_CHARS = Number(process.env.V108_FILL_CHARS ?? '2000')
const SID = `v108-${Date.now()}`
const PROJECT = 'C:/prts-system'

/** 5 个约束：每个都有一个不会自然出现的标记值，便于逐字断言。 */
const CONSTRAINTS = ['代号 ALPHA-7391', '颜色 靛蓝', '日期 周四', '通道 备用管', '倍率 7.5']
const NEEDLES = ['ALPHA-7391', '靛蓝', '周四', '备用管', '7.5']

const keyPath = 'C:/prts-data/secrets/deepseek.key'
// 本地 Strata（V108_LOCAL=1）：`max_context` 由服务端配置决定（本次用 16384），
// 无需 key（`/health` 报 `api_key: false`）。这样 V1-08 能零 API 成本跑，
// 而且窗口是真的 16K——不像 deepseek 那样「配置窗口小、模型真窗口 1M」，
// 让「超窗口 3 倍」这条判据名不副实。
const LOCAL = process.env.V108_LOCAL === '1'
const LOCAL_BASE = process.env.V108_BASE ?? 'http://127.0.0.1:8080/v1'
const LOCAL_MODEL = process.env.V108_MODEL ?? 'qwen3.8-flash-next-iq3_xxs'
const apiKey = LOCAL ? 'strata-local' : readFileSync(keyPath, 'utf8').trim()
if (apiKey === '') {
  console.error(`需要 ${keyPath} 里的 API key（或用 V108_LOCAL=1 走本地 Strata）`)
  process.exit(2)
}
if (LOCAL) {
  process.env.DEEPSEEK_BASE_URL = LOCAL_BASE
  process.env.PRTS_LLM_MODEL = LOCAL_MODEL
  // 模型真实窗口与 PRTS 的计算窗口必须一致，否则压缩基准与注入预算都错位。
  if (process.env.DSH_CONTEXT_WINDOW === undefined) process.env.DSH_CONTEXT_WINDOW = '16384'
}

// 必须在 startRuntime 之前设：`config/prts.yml:20` 在装配时读它。
process.env.DSH_CONTEXT_WINDOW = String(WINDOW)

const dataRoot = mkdtempSync(join(tmpdir(), 'v108-'))
console.log(`窗口 ${WINDOW}，目标 ≥ ${3 * WINDOW} token；dataRoot=${dataRoot}`)

const app = await startRuntime({
  configPath: `${PROJECT}/config/prts.yml`,
  dataRoot,
  workspace: dataRoot,
  mode: 'normal',
  credentials: { DEEPSEEK_API_KEY: apiKey },
  // 必须覆盖 `headroomTokens`：DSH 的默认值是 **65536**（`dsh-compaction-basic/lib/index.js:63`
  // `config.headroomTokens ?? 65536`），窗口小于「输出预留 + 65536」时 `compactPressure` 会抛
  // `TargetPressureConfigError`，被自动压缩的 catch 吞掉且只 warn 一次——表现为「压缩永远不发生」。
  // 这是产品的真实限制（任何 ≤ 65K 窗口的模型都踩得到），不是本脚本的取巧；
  // 覆盖它只是为了让 32000 窗口的验收能走到压缩那一步。
  patches: [{ id: 'compaction-basic', config: { headroomTokens: 1024 } }],
})

/** 跑一轮并返回模型回复正文。 */
async function turn(text) {
  const r = await runChat({
    ctx: app.ctx,
    lines: (async function* () { yield text; yield '/exit' })(),
    out: () => {},
    cwd: dataRoot,
    dataRoot,
    sessionId: SID,
    authority: app.authority,
    approvalBridge: app.approvalBridge,
  })
  return r.replies.join('\n').trim()
}

/** 当前会话的 token 测量；拿不到按 0。 */
function measure() {
  try {
    const agents = app.ctx.get('agents')
    const agent = agents?.get?.(SID)
    const meter = app.ctx.get('tokenMeter')
    if (agent?.session === undefined || meter?.measure === undefined) return 0
    return meter.measure(agent.session).totalTokens ?? 0
  } catch {
    return 0
  }
}

/** 会话日志里是否出现过压缩事件。 */
function compactionHappened() {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const p = join(dir, name)
      try {
        if (statSync(p).isDirectory()) walk(p)
        else if (name === 'session.v4.jsonl') {
          const text = readFileSync(p, 'utf8')
          if (text.includes('compaction/summary')) found.push(p)
        }
      } catch { /* 遍历间隙 */ }
    }
  }
  walk(join(dataRoot, 'dsh-home', 'sessions'))
  return found
}

// ---------- 1) 开头确认 5 个约束 ----------
const ack = await turn(
  `请记住下面 5 个约束，稍后我会考你：${CONSTRAINTS.join('；')}。现在只回复「已记住」。`,
)
console.log(`确认轮回复：${ack.slice(0, 80) || '（空）'}`)

// ---------- 2) 填充到 3 倍窗口 ----------
let measured = measure()
let fillRounds = 0
for (; fillRounds < MAX_FILL_ROUNDS; fillRounds += 1) {
  if (measured >= 3 * WINDOW) break
  await turn(`以下是无关材料，请只回复「收到」：${'材料'.repeat(Math.ceil(FILL_CHARS / 2))}`)
  measured = measure()
  if (fillRounds % 5 === 0) console.log(`  填充 ${fillRounds + 1} 轮，已用 ${measured} token`)
}
console.log(`填充结束：${fillRounds} 轮，已用 ${measured} token（目标 ${3 * WINDOW}）`)

// ---------- 3) 考 5 个约束 ----------
const answer = await turn('开头我让你记住的 5 个约束，请逐条列出，只列内容，不要解释。')
const missing = NEEDLES.filter((n) => !answer.includes(n))
const compaction = compactionHappened()

const A1 = measured >= 3 * WINDOW
const A2 = compaction.length > 0
const A3 = missing.length === 0

console.log('\n=== 答案 ===')
console.log(answer.slice(0, 800) || '（空）')
console.log('\n=== 判据 ===')
console.log(`A1 超 3 倍窗口：${A1 ? 'PASS' : 'FAIL'}（${measured} / ${3 * WINDOW}）`)
console.log(`A2 发生过压缩：${A2 ? 'PASS' : 'FAIL'}（命中 ${compaction.length} 个会话文件）`)
console.log(`A3 5 个约束全答出：${A3 ? 'PASS' : 'FAIL'}（缺 ${missing.join(', ') || '无'}）`)

const passed = A1 && A2 && A3
console.log(`\nV1-08 ${passed ? 'PASS' : 'FAIL'}`)

try { await app.ctx.get('root')?.dispose?.() } catch { /* 收尾失败不影响结论 */ }
process.exit(passed ? 0 : 1)
