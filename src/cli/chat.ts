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
import type { MemoryStore } from '../memory/index.ts'
import { findForOwner, forgetFlow, correctFlow } from '../memory/forget-flow.ts'
import { probeSessions, purgeSessions } from '../memory/session-purge.ts'
import { AuditLog } from '../audit/audit.ts'
import type { Authority } from '../authority/index.ts'
import type { ApprovalBridge } from '../runtime/start.ts'

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

/**
 * D2：审批通道收到的询问（只带判定所需的事实，不带 UI 语义）。
 * capabilities 来自 pre-execute 的暂存（start.ts 的 PendingApproval），
 * 是「本次操作会动到哪些能力」，不是渲染好的句子——怎么显示由客户端决定。
 */
export interface ApprovalAsk {
  callId: string
  tool: string
  capabilities: string[]
  reason: string
}

/** D2：一轮结束的事实。text 与 replies 同源（最后一次 attempt 优先）。 */
export interface TurnEndInfo {
  sessionId: string
  /** 1 起的回合序号，等于本会话已产出的 replies 条数。 */
  turn: number
  text: string
  /** 回合是否在 waitIdle 的时限内收敛；false 表示等超时了。 */
  settled: boolean
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
  /** 记忆库句柄；未提供时 /memory /forget /correct 报不可用。 */
  memory?: MemoryStore
  /** core.sqlite 路径；forget 用它在同库记 K4 删除。 */
  dbPath?: string
  /**
   * E3 授权句柄（与运行时同库）。未提供时越界操作走 fail-closed：
   * pre-execute 仍会发起 ask，但没有 answerer 应答，结果是 'unavailable' → 拒绝。
   */
  authority?: Authority
  /** E3 审批桥：按 callId 取 pre-execute 暂存的 capabilities。 */
  approvalBridge?: ApprovalBridge
  /**
   * 本会话最近一次模型创建的 draft 任务（来自 startRuntime）。
   * 无参 /task-approve 靠它寻址——draft 不绑定会话，指针是唯一入口。
   * 未注入时 /task-approve 只接受显式 id，不崩。
   */
  draftTaskForSession?: (sessionId: string) => unknown
  /**
   * D2：模型文本增量分流口。只承载模型回复的 text-delta——审批提示、宿主命令
   * 回显、命令报错仍只走 out，两者不混。未提供时行为不变（out 照写）。
   */
  onAssistantDelta?: (text: string) => void
  /**
   * D2：审批应答通道（远端客户端/前端用它应答 pre-execute 的审批）。
   * 提供时**完全不碰 lines**——否则通道与主循环会抢同一行（e3-approval 的
   * inputs 顺序断言依赖它）。返回值即裁决：true → allowed-once，false → rejected。
   * 需要 approvalBridge（取 capabilities）与 authority（落记录）同时在场，
   * 否则 answerer 不注册，审批仍走下游默认的 fail-closed。
   */
  approvalChannel?: {
    ask(info: ApprovalAsk): Promise<boolean>
  }
  /** D2：每轮结束回调，在 onIdle 之前触发；缺省无副作用。 */
  onTurnEnd?: (info: TurnEndInfo) => void
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
async function runTaskApprove(deps: ChatDeps, id: string, sessionId: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/task-approve 不可用\n')
    deps.onIdle?.()
    return
  }
  // 无参：从 draft 指针取本会话最近一次模型草案。draft 不绑定会话，
  // 指针是唯一能「不先知道 taskId 就批准」的路径。
  let target = id
  if (target === '') {
    const pointed = deps.draftTaskForSession?.(sessionId)
    const ptr = typeof pointed === 'string'
      ? pointed
      : (pointed as { id?: unknown } | undefined)?.id
    if (typeof ptr !== 'string' || ptr === '') {
      deps.out('[prts] 本会话没有待批准的任务。用法：/task-approve <taskId>\n')
      deps.onIdle?.()
      return
    }
    target = ptr
  }
  try {
    const owner = { kind: 'owner' } as const
    const current = deps.ledger.get(target as never)
    if (current.phase !== 'draft') {
      throw new Error(`任务 ${current.id} 处于 '${current.phase}'，不是 draft，无需批准`)
    }
    // 顺序：先 bind 后 activate。
    // bindSession 允许 draft（ledger.ts:466-480），失败（如会话已绑其他任务）时
    // 任务仍停在 draft、无半途副作用；反序会在 bind 失败时留下「已 active 但无人
    // 推进」的状态，而 activate 要求 draft、无法回退。
    const bound = deps.ledger.bindSession(
      owner,
      { id: current.id, revision: current.revision },
      sessionId,
    )
    const active = deps.ledger.activate(owner, { id: bound.id, revision: bound.revision })
    deps.out(`[prts] 已批准任务 ${active.id}（${active.phase}），已绑定本会话\n`)
  } catch (error) {
    deps.out(`[prts] 批准失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

/** 取目标任务的 ref；省略 id 时取本会话绑定任务。每次现读，不缓存 revision。 */
function targetRef(deps: ChatDeps, id: string, sessionId: string): { id: never; revision: number } {
  const ledger = deps.ledger
  if (ledger === undefined) throw new Error('未配置 ledger')
  const taskId = id !== '' ? (id as never) : ledger.taskForSession(sessionId)?.id
  if (taskId === undefined) throw new Error('本会话没有进行中的任务，请显式给 taskId')
  const snap = ledger.get(taskId)
  return { id: snap.id as never, revision: snap.revision }
}

/**
 * /accept：所有者裁决。
 *
 * 先打印任务摘要再裁决——ownerAccept 不要求任何证据（fold.ts:104-108 的
 * claimDone→verifying 不校验证据，ownerAccept 只查 phase），所以博士可能在零证据
 * 下把任务推成 done。这是所有者判断权的合理代价（「查个资料」类任务本就没有文件
 * 产物），不在账本层设硬门槛；但必须让人在知情下决定，故无证据时额外提示。
 */
async function runAccept(deps: ChatDeps, id: string, sessionId: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/accept 不可用\n')
    deps.onIdle?.()
    return
  }
  try {
    const ref = targetRef(deps, id, sessionId)
    const snap = deps.ledger.get(ref.id)
    const steps = deps.ledger.steps(snap.id)
    const ok = steps.filter((s) => s.status === 'succeeded').length
    const bad = steps.filter((s) => s.status === 'failed').length
    const evidence = deps.ledger.evidence(snap.id)
    deps.out(
      `[prts] 任务 ${snap.id}（${snap.phase}）：步骤 ${steps.length}（成功 ${ok} / 失败 ${bad}），`
      + `证据 ${evidence.length} 条\n`,
    )
    if (evidence.length === 0) {
      deps.out('[prts] 注意：本任务无证据支撑，/accept 后即视为你已自行核实结果\n')
    }
    const accepted = deps.ledger.ownerAccept({ id: snap.id, revision: snap.revision })
    deps.out(`[prts] 已验收 ${accepted.id}（${accepted.phase}）\n`)
  } catch (error) {
    deps.out(`[prts] 验收失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

async function runReject(deps: ChatDeps, id: string, reason: string, sessionId: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/reject 不可用\n')
    deps.onIdle?.()
    return
  }
  if (reason.trim() === '') {
    deps.out('[prts] 用法：/reject <理由>\n')
    deps.onIdle?.()
    return
  }
  try {
    const ref = targetRef(deps, id, sessionId)
    const snap = deps.ledger.ownerReject(ref.id, reason.trim())
    deps.out(`[prts] 已驳回 ${snap.id}（${snap.phase}）：${reason.trim()}\n`)
  } catch (error) {
    deps.out(`[prts] 驳回失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

async function runCancel(deps: ChatDeps, id: string, sessionId: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/cancel 不可用\n')
    deps.onIdle?.()
    return
  }
  try {
    const ref = targetRef(deps, id, sessionId)
    const snap = deps.ledger.cancel({ kind: 'owner' } as const, ref as never)
    deps.out(`[prts] 已取消 ${snap.id}（${snap.phase}）\n`)
  } catch (error) {
    deps.out(`[prts] 取消失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

async function runBudget(deps: ChatDeps, id: string, json: string, sessionId: string): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/budget 不可用\n')
    deps.onIdle?.()
    return
  }
  try {
    const ref = targetRef(deps, id, sessionId)
    const parsed = json.trim() === '' ? {} : JSON.parse(json) as Record<string, unknown>
    const snap = deps.ledger.setBudget(ref, parsed as never)
    deps.out(`[prts] 预算已更新：${snap.id}\n`)
  } catch (error) {
    deps.out(`[prts] 设置预算失败：${error instanceof Error ? error.message : String(error)}\n`)
  }
  deps.onIdle?.()
}

// ---- P0-2a：所有者记忆命令。斜杠命令不发模型、不落记忆 turn（handler 在分发处直接 return）。 ----
async function runMemoryFind(deps: ChatDeps, query: string): Promise<void> {
  if (deps.memory === undefined) { deps.out('[prts] 未配置记忆库，/memory 不可用\n'); return }
  if (query === '') { deps.out('[prts] 用法：/memory <检索词>\n'); return }
  const hits = findForOwner(deps.memory, query)
  if (hits.length === 0) { deps.out('[prts] 无命中\n'); return }
  deps.out(hits.map(h => `${h.id}\t${h.kind}\t${h.time ?? '时间未知'}\t${h.text}`).join('\n') + '\n')
}

async function runForget(deps: ChatDeps, arg: string): Promise<void> {
  if (deps.memory === undefined) { deps.out('[prts] 未配置记忆库，/forget 不可用\n'); return }
  const yes = arg.endsWith('--yes') || arg.includes(' --yes')
  const ids = arg.replace(/--yes/g, '').split(',').map(x => x.trim()).filter(x => x !== '')
  if (ids.length === 0) { deps.out('[prts] 用法：/forget <id,...> [--yes]\n'); return }
  let audit: AuditLog | undefined
  try {
    if (yes && deps.dbPath !== undefined) audit = AuditLog.open(deps.dbPath)
    const r = forgetFlow({
      store: deps.memory, audit,
      sessionsRoot: join(deps.dataRoot, 'dsh-home', 'sessions'),
      ids, confirm: yes,
    })
    deps.out(r.message + '\n')
  } finally { audit?.close() }
}

async function runForgetSession(deps: ChatDeps, arg: string): Promise<void> {
  const yes = arg.endsWith('--yes') || arg.includes(' --yes')
  const ids = arg.replace(/--yes/g, '').split(',').map(x => x.trim()).filter(x => x !== '')
  if (ids.length === 0) { deps.out('[prts] 用法：/forget-session <sessionId,...> [--yes]\n'); return }
  const sessionsRoot = join(deps.dataRoot, 'dsh-home', 'sessions')
  if (!yes) {
    const probes = probeSessions(sessionsRoot, ids)
    const lines = ['删除计划（未执行）：']
    for (const p of probes) {
      lines.push(`  ${p.sessionId}  ${p.state}  ${p.jsonlBytes}B  ${p.dir === '' ? '（无目录）' : p.dir}`)
    }
    lines.push('注意：执行后**整个会话目录**（session.v4.jsonl 及附属文件）将被删除，不只是被删内容的部分。')
    lines.push('当前会话处于在用状态，会被自动拒删。加 --yes 执行。')
    deps.out(lines.join('\n') + '\n')
    return
  }
  let audit: AuditLog | undefined
  try {
    if (deps.dbPath !== undefined) audit = AuditLog.open(deps.dbPath)
    const r = purgeSessions({ sessionsRoot, sessionIds: ids, audit })
    deps.out(r.message + '\n')
  } finally { audit?.close() }
}

// ---- V1-14 前瞻记忆：所有者意图命令。取消是破坏性动作，模型面不注册（见 intent-tools.ts）。 ----
async function runIntent(deps: ChatDeps, arg: string): Promise<void> {
  if (deps.memory === undefined) { deps.out('[prts] 未配置记忆库，/intent 不可用\n'); return }
  const parts = arg.split(/\s+/).filter((x) => x !== '')
  // 裸 `--all` 等同 `list --all`：别让用户为了一个开关重打一次子命令。
  const sub = parts[0] === undefined || parts[0].startsWith('--') ? 'list' : parts[0]

  if (sub === 'cancel') {
    const keys = (parts[1] ?? '').split(',').map((x) => x.trim()).filter((x) => x !== '')
    if (keys.length === 0) { deps.out('[prts] 用法：/intent cancel <intentId 或前缀,...>\n'); return }
    const all = deps.memory.listIntents()
    for (const key of keys) {
      const hit = all.find((r) => r.intentId === key) ?? all.find((r) => r.intentId.startsWith(key))
      if (hit === undefined) { deps.out(`[prts] 未找到意图 ${key}\n`); continue }
      try {
        deps.memory.cancelIntent({ actor: 'owner', intentId: hit.intentId })
        deps.out(`[prts] 已取消 ${hit.intentId}：${hit.action}\n`)
      } catch (error) {
        deps.out(`[prts] 取消失败 ${hit.intentId}：${error instanceof Error ? error.message : String(error)}\n`)
      }
    }
    return
  }

  if (sub !== 'list') { deps.out('[prts] 用法：/intent [list [--all] | cancel <id,...>]\n'); return }
  const all = parts.includes('--all')
  const rows = all ? deps.memory.listIntents() : deps.memory.listIntents({ status: 'pending' })
  if (rows.length === 0) {
    deps.out(`[prts] 没有${all ? '' : '未触发的'}意图\n`)
    return
  }
  deps.out(rows.map((r) => {
    const planned = new Date(r.fireAtMs).toISOString()
    const fired = r.firedAtMs === null ? '' : `\t实触发 ${new Date(r.firedAtMs).toISOString()}`
    return `${r.intentId}\t${r.status}\t${planned}\t${r.action}\t「${r.conditionRaw}」${fired}`
  }).join('\n') + '\n')
}

async function runCorrect(deps: ChatDeps, arg: string): Promise<void> {
  if (deps.memory === undefined) { deps.out('[prts] 未配置记忆库，/correct 不可用\n'); return }
  const i = arg.indexOf(' ')
  if (i < 0) { deps.out('[prts] 用法：/correct <factId> <新内容>\n'); return }
  try {
    const r = correctFlow({ store: deps.memory, factId: arg.slice(0, i), object: arg.slice(i + 1) })
    deps.out(r.message + '\n')
  } catch (e) {
    deps.out(`[prts] ${e instanceof Error ? e.message : String(e)}\n`)
  }
}

async function runTasks(deps: ChatDeps): Promise<void> {
  if (deps.ledger === undefined) {
    deps.out('[prts] 未配置 ledger，/tasks 不可用\n')
    deps.onIdle?.()
    return
  }
  const tasks = deps.ledger.list()
  if (tasks.length === 0) {
    deps.out('[prts] 账本里还没有任务\n')
  } else {
    for (const t of tasks) deps.out(`  ${t.id}  ${t.phase}\n`)
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

  /*
   * 会话身份：主会话必须在跑到第一个模型回合之前就注册好。
   * 「谁是主会话」是后续权限收窄与审计归属的依据，缺登记就等于作用域空白。
   * 注册失败按 fail-closed：报错并退出，不进入主循环——静默继续会让整段会话
   * 在没有身份记录的前提下照常对话，失败被藏到最后才暴露。
   */
  try {
    deps.authority?.registerPrimarySession(sessionId)
  } catch (error) {
    deps.out(`[prts] 会话身份注册失败：${error instanceof Error ? error.message : String(error)}\n`)
    return { turns: 0, replies: [] }
  }

  const replies: string[] = []
  /** E3 审批应答的解绑器；在 try 内赋值、finally 里解绑，故声明在 try 外。 */
  let offApproval: (() => void) | undefined
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
    if (deps.onAssistantDelta !== undefined) deps.onAssistantDelta(delta)
    else deps.out(delta)
    // 模型文本出口见上：回调与 out 二选一，不可双写（否则 host 通道会混入模型文本）。
  })
  try {
    // E3：审批应答与主循环共用同一个输入迭代器。审批发生在回合内，此时主循环
    // 正阻塞等回合收敛，两者不会同时消费同一行。
    const lineIter = deps.lines[Symbol.asyncIterator]()
    const readLine = async (): Promise<string | undefined> => {
      const r = await lineIter.next()
      return r.done === true ? undefined : r.value
    }

    // E3：审批应答。只应答本运行时经 pre-execute 发起的请求（桥里能取到
    // capabilities）；取不到就交回下游默认行为（无 answerer 时是 fail-closed 的
    // 'unavailable'），不越权代答别的来源的审批。
    offApproval = (deps.authority === undefined || deps.approvalBridge === undefined)
      ? undefined
      : (ctx as unknown as {
        on(name: string, fn: (...a: never[]) => unknown): () => void
      }).on(
        'approval/request',
        (async (req: unknown, next: () => unknown) => {
          const r = req as { callId?: unknown; reason?: unknown }
          const p = deps.approvalBridge?.take(String(r.callId))
          if (p === undefined) return next()
          const reason = typeof r.reason === 'string' ? r.reason : ''
          let ok: boolean
          if (deps.approvalChannel !== undefined) {
            // D2：有通道就不读 lines。通道抛错按「没人应答」处理 → 拒绝，
            // 不因异常而默许（审批的缺省必须是 fail-closed）。
            const ask: ApprovalAsk = { callId: p.callId, tool: p.tool, capabilities: p.capabilities, reason }
            try {
              ok = await deps.approvalChannel.ask(ask)
            } catch (error) {
              deps.out(`[prts] 审批通道失败：${error instanceof Error ? error.message : String(error)}\n`)
              ok = false
            }
          } else {
            // 无通道：保持原来的本地 [y/N] 交互。
            deps.out(`\n[审批] 工具 ${p.tool} 请求越界操作：\n`)
            for (const c of p.capabilities) deps.out(`  · ${c}\n`)
            if (reason !== '') deps.out(`  理由：${reason}\n`)
            deps.out('  批准本次？[y/N] ')
            const answer = (await readLine()) ?? ''
            ok = /^y(es)?$/i.test(answer.trim())
          }
          try {
            deps.authority?.recordOwnerDecision({
              sessionId: p.sessionId,
              callId: p.callId,
              tool: p.tool,
              capabilities: p.capabilities,
              outcome: ok ? 'allowed-once' : 'denied',
            })
          } catch (error) {
            deps.out(`[prts] 审批结果记录失败：${error instanceof Error ? error.message : String(error)}\n`)
            // 写不进记录就等于没批准——必须按拒绝走，不能假装成功。
            return 'rejected'
          }
          deps.out(ok ? '[prts] 已批准本次\n' : '[prts] 已拒绝\n')
          return ok ? 'allowed-once' : 'rejected'
        }) as never,
      )

    for (;;) {
      const raw = await readLine()
      if (raw === undefined) break
      const line = raw.trim()
      if (line === '') continue
      if (line === '/exit' || line === '/quit') break
      // ---- 宿主命令：不触发模型回合，走 owner 通道 ----
      if (line === '/task' || line.startsWith('/task ')) {
        await runTaskCommand(deps, sessionId, line.slice('/task'.length).trim())
        continue
      }
      if (line.startsWith('/task-approve')) {
        await runTaskApprove(deps, line.slice('/task-approve'.length).trim(), sessionId)
        continue
      }
      // ---- P0-2a 所有者记忆命令：不触发模型回合 ----
      if (line === '/memory' || line.startsWith('/memory ')) {
        await runMemoryFind(deps, line.slice('/memory'.length).trim())
        continue
      }
      if (line === '/forget-session' || line.startsWith('/forget-session ')) {
        await runForgetSession(deps, line.slice('/forget-session'.length).trim())
        continue
      }
      if (line === '/forget' || line.startsWith('/forget ')) {
        await runForget(deps, line.slice('/forget'.length).trim())
        continue
      }
      if (line === '/correct' || line.startsWith('/correct ')) {
        await runCorrect(deps, line.slice('/correct'.length).trim())
        continue
      }
      if (line === '/intent' || line.startsWith('/intent ')) {
        await runIntent(deps, line.slice('/intent'.length).trim())
        continue
      }
      // 所有者裁决命令：全部走 owner 通道，不经模型工具层。
      if (line === '/accept' || line.startsWith('/accept ')) {
        await runAccept(deps, line.slice('/accept'.length).trim(), sessionId)
        continue
      }
      if (line.startsWith('/reject')) {
        await runReject(deps, '', line.slice('/reject'.length).trim(), sessionId)
        continue
      }
      if (line === '/cancel' || line.startsWith('/cancel ')) {
        await runCancel(deps, line.slice('/cancel'.length).trim(), sessionId)
        continue
      }
      if (line.startsWith('/budget')) {
        await runBudget(deps, '', line.slice('/budget'.length).trim(), sessionId)
        continue
      }
      if (line === '/tasks') {
        await runTasks(deps)
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
      // 仅当一个 delta 都没写出去时，才把日志文本交给同一个出口；否则日志兜底的
      // 模型文本会以 host 身份出现（chat-serve 把 out 接到 host 通道）。
      if (streamed === '' && fromLog.text.length > 0) {
        if (deps.onAssistantDelta !== undefined) deps.onAssistantDelta(fromLog.text)
        else deps.out(fromLog.text)
      }
      // replies 仍存整段（不是逐片）：最后一次 attempt 的文本优先，其次终端所见，再其次日志。
      const text = attemptText || streamed || fromLog.text
      replies.push(text)
      deps.onTurnEnd?.({ sessionId, turn: replies.length, text, settled })
      deps.onIdle?.()
    }
  } finally {
    off?.()
    offApproval?.()
  }
  return { turns: replies.length, replies }
}
