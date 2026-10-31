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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'

const NL = String.fromCharCode(10)

/** 从 assistant-stream 的 payload 里递归捞可见文本（形状未在类型里固定）。 */
function collectText(value: unknown, sink: string[]): void {
  if (typeof value === 'string') { sink.push(value); return }
  if (Array.isArray(value)) { for (const v of value) collectText(v, sink); return }
  if (value === null || typeof value !== 'object') return
  const rec = value as Record<string, unknown>
  if (rec.type === 'reasoning' || rec.type === 'thinking' || rec.type === 'signature_delta') return
  if (rec.type === 'text' && typeof rec.text === 'string') { sink.push(rec.text); return }
  for (const key of ['chunks', 'delta', 'message', 'content']) {
    if (key in rec) collectText(rec[key], sink)
  }
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
}

export interface ChatResult {
  turns: number
  replies: string[]
}

/**
 * 跑一次 REPL 会话。返回后调用方负责 dispose。
 * 不含审批应答：本组合下审批不可达（见文件头）。
 */
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
  let buf: string[] = []
  let seenSeq = 0
  const off = events?.on('agent/assistant-stream', (e: unknown) => collectText(e, buf))
  try {
    for await (const raw of deps.lines) {
      const line = raw.trim()
      if (line === '') continue
      if (line === '/exit' || line === '/quit') break
      buf = []
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: line }],
        source: { kind: 'user' },
      }))
      const settled = await waitIdle(agent)
      if (!settled) deps.out('[prts] 回合未在时限内收敛，已放弃等待')
      // 事件有文本就用事件，否则从会话日志兜底
      // 会话日志的 assistant/message 可能晚于 status 变 idle 落盘：重试到拿到文本或超时
      let fromLog = assistantAfterSeq(deps.dataRoot, sessionId, seenSeq)
      for (let i = 0; i < 30 && buf.length === 0 && fromLog.text === ''; i++) {
        await new Promise((r) => setTimeout(r, 100))
        fromLog = assistantAfterSeq(deps.dataRoot, sessionId, seenSeq)
      }
      seenSeq = fromLog.seq
      const text = buf.join('') || fromLog.text
      replies.push(text)
      if (text.length > 0) deps.out(text)
      deps.onIdle?.()
    }
  } finally {
    off?.()
  }
  return { turns: replies.length, replies }
}
