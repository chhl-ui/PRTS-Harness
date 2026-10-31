/**
 * 所有者终端：进程内 REPL（设计 02 第 4 步的进程内版本）。
 *
 * 不做命名管道——那是「终端与运行时分离」和后续网页界面复用的基础设施，
 * 本轮先把「能人手对话」这件事兑现。
 *
 * 关于审批（E3）：本组合下审批**不会**被触发，原因已核实——
 * `dsh-tool-fs/lib/index.js:1134-1150` 的 `resolvePolicy` 在
 * `args.sandbox_permissions === void 0 || args.justification === void 0` 时
 * 直接 `return standingPolicy`（不发审批）；带参数重试则要求
 * `this.escalationModes.length > 0`，即组合里必须有 confining fs backend。
 * `config/prts.yml:27` 用的是 `@deepseek-ai/dsh-fs-local`，不是 confining 后端。
 * 所以终端不提供审批提示；等接入 confining fs backend 后再补。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Ledger } from '../ledger/index.ts'

const NL = String.fromCharCode(10)

/**
 * `agent/assistant-stream` 的 payload 契约：`{ agent, frame: AssistantStreamFrame }`
 * （node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:107-140，
 *   事件声明同文件 :366-369；类型入口 index.d.ts:11 `export * from './runtime-types.ts'`）。
 * frame.type ∈ {start, chunk, end}；文本增量在 chunk 帧的 `chunk: StreamChunk`
 * （dsh-llm/lib/types/types.d.ts:434-441）里以 `{ type: 'text-delta', index, text }` 到达。
 */
function streamFrame(payload: unknown): AssistantStreamFrame | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  return (payload as { frame?: AssistantStreamFrame }).frame
}

/**
 * 取一帧的增量文本：只认 chunk 帧里的 text-delta。
 * 特意不放宽到 block-end 的 `block: { type: 'text', text }`——那样同一次回复会被算两遍
 * （text-delta 一遍 + 组装后的 block 又一遍），终端上就是重复输出。
 */
function extractStreamText(payload: unknown): string {
  const frame = streamFrame(payload)
  if (frame === undefined || frame.type !== 'chunk') return ''
  const chunk = frame.chunk
  if (chunk.type !== 'text-delta') return ''
  return chunk.text
}

function sessionFiles(dataRoot: string, sessionId: string): string[] {
  const root = join(dataRoot, 'dsh-home', 'sessions')
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.jsonl') && p.includes(sessionId)) out.push(p)
    }
  }
  walk(root)
  return out
}

/** 读 seq 之后的 assistant 文本；事件不带文本时用它兜底。 */
function assistantAfterSeq(dataRoot: string, sessionId: string, afterSeq: number): { text: string; seq: number } {
  let text = ''
  let seq = afterSeq
  for (const f of sessionFiles(dataRoot, sessionId)) {
    for (const line of readFileSync(f, 'utf8').split(NL)) {
      if (!line.trim()) continue
      let rec: { type?: string; seq?: number; data?: { message?: { content?: { type?: string; text?: string }[] } } }
      try { rec = JSON.parse(line) } catch { continue }
      const recSeq = typeof rec.seq === 'number' ? rec.seq : 0
      if (recSeq > seq) seq = recSeq
      if (rec.type !== 'assistant/message' || recSeq <= afterSeq) continue
      const t = (rec.data?.message?.content ?? [])
        .filter((b) => b?.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (t.length > 0) text += t
    }
  }
  return { text, seq }
}

/** 等回合收敛：followup 后 status 仍可能是 idle，必须给 kick 留时间。 */
async function waitIdle(agent: { status: string }, ms = 120000): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 150))
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (agent.status === 'idle' && Date.now() - t0 > 200) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

export interface ChatDeps {
  ctx: Context
  /** 逐行输入；EOF 或 '/exit' 结束。 */
  lines: AsyncIterable<string>
  /** 输出一段文本（不带换行）。 */
  out: (text: string) => void
  sessionId?: string
  cwd: string
  /** 数据根：回合结束后从会话日志兜底取文本。 */
  dataRoot: string
  /** 每轮结束后的回调，CLI 用来打提示符。 */
  onIdle?: () => void
  /** 任务账本；未提供时 /task 系列命令不可用（明确报错，不静默忽略）。 */
  ledger?: Ledger
}

export interface ChatResult {
  turns: number
  replies: string[]
}

/**
 * 跑一次 REPL 会话。返回后调用方负责 dispose。
 * 不含审批应答：本组合下审批不可达（见文件头）。
 */
/**
 * 列出未结任务作为启动线索：draft（待批准）、active、blocked。
 * **只列出，不自动恢复**——恢复必须由博士显式动作（对应前瞻记忆的线索触发，
 * 而不是后台轮询）。已终结的（done / cancelled / stopped-by-owner）不出现。
 */
export function describeOpenTasks(ledger: Ledger): string {
  const phases = ['draft', 'active', 'blocked'] as const
  const open = phases.flatMap((phase) => ledger.list({ phase }))
  if (open.length === 0) return ''
  const lines = [`[prts] 未结任务 ${open.length} 个：`]
  for (const t of open) {
    lines.push(`  ${t.phase.padEnd(8)} ${t.id}  ${t.title}`)
  }
  lines.push('  用 /task-approve <id> 批准草案；恢复执行请显式操作。')
  return lines.join('\n') + '\n'
}

/** `/task <目标>`：建任务 → 激活 → 绑定当前会话，全程 owner 通道。 */
async function runTaskCommand(deps: ChatDeps, sessionId: string, objective: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/task 不可用\n')
    deps.onIdle?.()
    return
  }
  if (objective === '') {
    deps.out('[prts] 用法：/task <目标>\n')
    deps.onIdle?.()
    return
  }
  try {
    const owner = { kind: 'owner' } as const
    const created = deps.ledger.create(owner, {
      title: objective.length > 60 ? `${objective.slice(0, 60)}…` : objective,
      objective,
      acceptance: { kind: 'owner-confirm' },
    })
    const active = deps.ledger.activate(owner, { id: created.id, revision: created.revision })
    deps.ledger.bindSession(owner, { id: active.id, revision: active.revision }, sessionId)
    deps.out(`[prts] 已开任务 ${active.id}（active，已绑定本会话）\n`)
  } catch (error) {
    deps.out(`[prts] 开任务失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

/** `/task-approve <id>`：把模型建的 draft 激活。owner 通道，模型无权调用。 */
async function runTaskApprove(deps: ChatDeps, id: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/task-approve 不可用\n')
    deps.onIdle?.()
    return
  }
  if (id === '') {
    deps.out('[prts] 用法：/task-approve <taskId>\n')
    deps.onIdle?.()
    return
  }
  try {
    const owner = { kind: 'owner' } as const
    const current = deps.ledger.get(id as never)
    const active = deps.ledger.activate(owner, { id: current.id, revision: current.revision })
    deps.out(`[prts] 已批准任务 ${active.id}（${active.phase}）\n`)
  } catch (error) {
    deps.out(`[prts] 批准失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

export async function runChat(deps: ChatDeps): Promise<ChatResult> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx = deps.ctx as any
  const agents = ctx.get('agents') as {
    create(o: unknown): Promise<{ agent: { status: string; followup(m: unknown): void } }>
  }
  const events = ctx.events as { on(name: string, fn: (e: unknown) => void): () => void } | undefined
  // agent/error 已由 startRuntime 挂的 error-report 写 stderr，不重复订阅。

  const sessionId = deps.sessionId ?? `prts-chat-${Date.now()}`
  const { agent } = await agents.create({
    sessionId,
    meta: { cwd: deps.cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-chat' },
  })

  const replies: string[] = []
  /** 本回合已写到终端的流式文本（跨 attempt 只增不减，用来判断要不要走日志兜底）。 */
  let streamed = ''
  /** 当前 attempt 累积到的完整文本；换 attempt 即重置（重试会从头重发 delta）。 */
  let attemptText = ''
  let attemptId: AssistantStreamFrame['attemptId'] | undefined
  let seenSeq = 0
  // 增量直写终端：文本按 delta 到达即 out，不等回合收敛。
  // 已知限制：重试会起新 attempt 从头重发 delta，而已写入的终端内容撤不回来，
  // 此时终端上可能看到重复片段——本轮不做终端回滚。
  const off = events?.on('agent/assistant-stream', (e: unknown) => {
    const frame = streamFrame(e)
    if (frame === undefined) return
    if (frame.attemptId !== attemptId) {
      attemptId = frame.attemptId
      attemptText = ''
    }
    const delta = extractStreamText(e)
    if (delta === '') return
    attemptText += delta
    streamed += delta
    deps.out(delta)
  })
  try {
    for await (const raw of deps.lines) {
      const line = raw.trim()
      if (line === '') continue
      if (line === '/exit' || line === '/quit') break
      // ---- 宿主命令：不触发模型回合，走 owner 通道 ----
      if (line === '/task' || line.startsWith('/task ')) {
        await runTaskCommand(deps, sessionId, line.slice('/task'.length).trim())
        continue
      }
      if (line.startsWith('/task-approve')) {
        await runTaskApprove(deps, line.slice('/task-approve'.length).trim())
        continue
      }
      streamed = ''
      attemptText = ''
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: line }],
        source: { kind: 'user' },
      }))
      const settled = await waitIdle(agent)
      if (!settled) deps.out('[prts] 回合未在时限内收敛，已放弃等待')
      // 日志兜底：某 provider 只发完整 block 不发 text-delta 时全靠它。
      // 会话日志的 assistant/message 可能晚于 status 变 idle 落盘，所以要多试几次；
      // 但已经流式写过终端就不空等（原来无条件等满 3 秒，是纯延迟）。
      let fromLog = assistantAfterSeq(deps.dataRoot, sessionId, seenSeq)
      for (let i = 0; i < 30 && streamed === '' && fromLog.text === ''; i++) {
        await new Promise((r) => setTimeout(r, 100))
        fromLog = assistantAfterSeq(deps.dataRoot, sessionId, seenSeq)
      }
      seenSeq = fromLog.seq
      // 仅当一个 delta 都没写出去时，才把日志文本打到终端；两者都空就不输出空行。
      if (streamed === '' && fromLog.text.length > 0) deps.out(fromLog.text)
      // replies 仍存整段（不是逐片）：最后一次 attempt 的文本优先，其次终端所见，再其次日志。
      const text = attemptText || streamed || fromLog.text
      replies.push(text)
      deps.onIdle?.()
    }
  } finally {
    off?.()
  }
  return { turns: replies.length, replies }
}
