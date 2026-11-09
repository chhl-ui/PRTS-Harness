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
import { listSessions, renderSessionLine } from '../runtime/session-table.ts'
import { dispatchTasks } from '../runtime/dispatcher.ts'
import { probeSessions, purgeSessions } from '../memory/session-purge.ts'
import { AuditLog } from '../audit/audit.ts'
import { PersonaStore } from '../persona/index.ts'
import { SkillStore } from '../skills/index.ts'
import { EmotionStore } from '../emotion/index.ts'
import { createEmotionSignals } from '../runtime/emotion-signals.ts'
import type { SkillPhase, SkillSnapshot, SkillVerdict } from '../skills/index.ts'
import { listProfiles, readProfile, writeProfile } from '../runtime/model-profile.ts'
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
export function assistantAfterSeq(dataRoot: string, sessionId: string, afterSeq: number): { text: string; seq: number } {
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

/**
 * 查会话日志里有没有模型发出的归档请求。
 *
 * 与 `assistantAfterSeq` 同源：都逐行读 `session.v4.jsonl`，只是过滤的事件类型不同。
 * 走日志而不是进程内变量，是因为事件会落盘——进程崩了重启还能看到「上一轮请求过归档」；
 * 内存标记丢了就没了，模型会以为切过了。
 *
 * 返回命中的最大 seq（调用方据此推进游标，避免同一事件反复触发），没有则 null。
 */
export function findArchiveRequest(dataRoot: string, sessionId: string, afterSeq: number): number | null {
  let hit: number | null = null
  for (const f of sessionFiles(dataRoot, sessionId)) {
    let content: string
    try { content = readFileSync(f, 'utf8') } catch { continue }
    for (const line of content.split(NL)) {
      if (!line.trim()) continue
      let rec: { type?: string; seq?: number }
      try { rec = JSON.parse(line) } catch { continue }
      if (rec.type !== 'archive/requested') continue
      const seq = typeof rec.seq === 'number' ? rec.seq : 0
      if (seq > afterSeq && (hit === null || seq > hit)) hit = seq
    }
  }
  return hit
}

/**
 * 回合收敛的墙钟预算。
 *
 * 为什么可配：120s 对云端模型够用，对本地模型（实测 59–71 t/s）在多工具调用时不宽裕——
 * S10 那次 123.47s 正好撞线，回了个空。`PRTS_TURN_TIMEOUT_MS` 让本地场景调到 300s，
 * 而不必改代码；默认值保持 120s 不变，不动既有行为。
 *
 * 非法值（非数字、0、负数）一律回落默认：超时配成 0 会让每个回合都「没收敛」，
 * 那是比不配更危险的静默失败。
 */
export function resolveTurnTimeoutMs(): number {
  const raw = process.env.PRTS_TURN_TIMEOUT_MS
  if (raw === undefined || raw.trim() === '') return 120_000
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return 120_000
  return Math.floor(n)
}

/** 等回合收敛：followup 后 status 仍可能是 idle，必须给 kick 留时间。 */
export async function waitIdle(agent: { status: string }, ms = resolveTurnTimeoutMs()): Promise<boolean> {
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
   * `/dispatch` 的分派参数（Router 侧一次性分派，worker 只回摘要）。
   * 未提供时该命令明确报不可用——不静默忽略，也不猜 provider/model。
   */
  dispatch?: {
    /** 子会话派生目录的根（workspace 根）。 */
    workspace: string
    provider: string
    model: string
  }
  /**
   * 本会话最近一次模型创建的 draft 任务（来自 startRuntime）。
   * 无参 /task-approve 靠它寻址——draft 不绑定会话，指针是唯一入口。
   * 未注入时 /task-approve 只接受显式 id，不崩。
   */
  draftTaskForSession?: (sessionId: string) => unknown
  /**
   * 会话切换通知（`/switch` `/new`，两者共用 applySwitch）。
   *
   * `sessionId` 是 runChat 的局部可变量，切换会整体替换它；宿主（chat-serve 的只读查询）
   * 要跟踪「当前是哪个会话」只能靠回调——启动时传进来的值是死的。
   */
  onSessionChange?: (sessionId: string) => void
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
/**
 * 博士反馈 → 情绪（架构需求 §5.1 四类事件里的「博士的反馈」）。
 *
 * 与 `/persona` 同层：自开一次短连接写同一 `emotion.sqlite`，写完即关。
 * 失败一律吞掉——验收/驳回的结果是账本事实，不能因为情绪库打不开就改变裁决。
 */
function recordOwnerFeedback(deps: ChatDeps, kind: 'accept' | 'reject', reason: string): void {
  let store: EmotionStore | undefined
  try {
    store = EmotionStore.open(process.env.PRTS_EMOTION_DB ?? join(deps.dataRoot, 'emotion.sqlite'))
    const signals = createEmotionSignals({ store })
    if (kind === 'accept') signals.onOwnerAccept(reason)
    else signals.onOwnerReject(reason)
  } catch { /* 情绪写失败不影响裁决 */ } finally { store?.close() }
}

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
    recordOwnerFeedback(deps, 'accept', `任务 ${accepted.id} 验收通过`)
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
    recordOwnerFeedback(deps, 'reject', reason.trim())
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

/** `/sandbox` 三档别名 → 上游 `dsh-sandbox-policy` 的 SandboxMode；中文档名与界面一致。 */
const SANDBOX_MODE_ALIAS: Record<string, 'read-only' | 'workspace-write' | 'danger-full-access'> = {
  view: 'read-only',
  read: 'read-only',
  'read-only': 'read-only',
  '仅可查看': 'read-only',
  edit: 'workspace-write',
  workspace: 'workspace-write',
  'workspace-write': 'workspace-write',
  '工作区内修改': 'workspace-write',
  full: 'danger-full-access',
  danger: 'danger-full-access',
  'danger-full-access': 'danger-full-access',
  '完全权限': 'danger-full-access',
}

const SANDBOX_MODE_LABEL: Record<string, string> = {
  'read-only': '仅可查看（read-only）',
  'workspace-write': '工作区内修改（workspace-write）',
  'danger-full-access': '完全权限（danger-full-access）',
}

/**
 * `/sandbox [档]`：三档文件沙箱切换，写 `sandbox/mode` 会话事件（owner 通道）。
 *
 * 生效机制（上游 dsh-sandbox-policy + dsh-terminal-bash）：
 * - 档位存会话日志里的 `sandbox/mode` 事件，per-session、回放可重建；
 *   `ctx.sandboxPolicy.resolve({session})` 在每次 shell spawn / fs 调用时
 *   解析——fs 工具切完立即生效；
 * - 持久 pwsh 只在**起 shell 那一刻** confine 一次，所以切档前必须先杀掉
 *   活 PTY：上游 sandboxModeFence 在有活终端时会拒收 mode 事件，留着旧
 *   shell 档位也不会生效；
 * - `danger-full-access` 上游 spawnArgv 直接绕过 confine（shell 不受限、
 *   密钥可读）；`read-only` 由 runner 建容器时不授 workspace 写来落实；
 * - K2a 授权判定不受档影响：fs.* 能力仍走 Authority 审批/授权链，档位只
 *   管 OS 沙箱这一层。
 * 模型没有入口：session 对象不在工具面，事件只能经 owner 通道写。
 */
async function runSandbox(
  deps: ChatDeps,
  ctx: {
    get?(name: string): unknown
    sandboxPolicy?: { resolve?(req: unknown): { mode?: string } }
  },
  agent: { session?: { append?(type: string, data: unknown): void } },
  arg: string,
): Promise<void> {
  const label = (m: string | undefined): string => SANDBOX_MODE_LABEL[m ?? ''] ?? `未知（${String(m)}）`
  const session = agent.session
  const sandboxPolicy = (ctx.sandboxPolicy ?? ctx.get?.('sandboxPolicy')) as
    { resolve?(req: unknown): { mode?: string } } | undefined
  const current = ((): string | undefined => {
    try { return sandboxPolicy?.resolve?.({ session })?.mode } catch { return undefined }
  })()

  if (session?.append === undefined) {
    deps.out('[prts] 当前会话对象不支持 mode 事件，/sandbox 不可用\n')
    deps.onIdle?.()
    return
  }
  if (arg === '') {
    deps.out(`[prts] 当前沙箱档位：${label(current)}\n`)
    deps.out('[prts] 用法：/sandbox <view|edit|full>（仅可查看 / 工作区内修改 / 完全权限）\n')
    deps.onIdle?.()
    return
  }
  const target = SANDBOX_MODE_ALIAS[arg.toLowerCase()] ?? SANDBOX_MODE_ALIAS[arg]
  if (target === undefined) {
    deps.out(`[prts] 未知档位 ${arg}；用法：/sandbox <view|edit|full>\n`)
    deps.onIdle?.()
    return
  }
  if (target === current) {
    deps.out(`[prts] 已是 ${label(target)}\n`)
    deps.onIdle?.()
    return
  }

  // 先杀活 PTY：fence 有活终端时拒收 mode 事件；留着旧 shell，切了也不生效。
  const terminals = ctx.get?.('terminals') as {
    list?(owner: unknown): Array<{ sessionId?: unknown }>
    kill?(owner: unknown, id: string, reason: string): Promise<unknown>
  } | undefined
  for (const s of terminals?.list?.(agent) ?? []) {
    if (typeof s.sessionId !== 'string') continue
    try {
      await terminals?.kill?.(agent, s.sessionId, `sandbox mode switch to ${target}`)
    } catch (error) {
      deps.out(`[prts] 杀旧 shell 失败（${s.sessionId}）：${error instanceof Error ? error.message : String(error)}\n`)
      deps.onIdle?.()
      return
    }
  }
  try {
    session.append('sandbox/mode', { mode: target })
  } catch (error) {
    deps.out(`[prts] 切换失败：${error instanceof Error ? error.message : String(error)}\n`)
    deps.onIdle?.()
    return
  }
  deps.out(`[prts] 已切到 ${label(target)}：fs 工具立即生效，pwsh 下次调用起新受限 shell\n`)
  if (target === 'danger-full-access') {
    deps.out('[prts] 警告：完全权限下 shell 不再进容器，密钥与全盘文件对模型可见\n')
  }
  deps.onIdle?.()
}

/**
 * `/model [预设名]`：查看 / 切换模型后端预设（owner 通道；重启 serve 后生效）。
 *
 * 为什么必须重启而不是热切：`dsh-llm-deepseek-api-key` 把 provider id 硬编码为
 * `deepseek-official`（`lib/index.js:47`），同一进程注册两个会互相覆盖；上下文窗口
 * 也在启动期求值（`config/prts.yml:20` + `start.ts:1027`，`agentOptions` 里没有该字段）。
 *
 * 所以这里只写 `<dataRoot>/model-profile.json`，由 `chat-serve` 下次启动时读
 * （`readProfileIfPresent`）并落进环境变量。**换后端连带换 256K/1M 的装配预算**，
 * 这正是这个按钮存在的理由——不重启就没有真正切过去。
 */
async function runModel(deps: ChatDeps, arg: string): Promise<void> {
  const current = readProfile(deps.dataRoot)
  if (arg === '') {
    deps.out(`[prts] 当前模型预设：${current.label}（窗口 ${current.contextWindow}）\n`)
    for (const p of listProfiles()) {
      deps.out(`[prts]   ${p.id === current.id ? '*' : ' '} ${p.id} — ${p.label}\n`)
    }
    deps.out('[prts] 用法：/model <预设名>；切换后需重启 serve 才生效（窗口在启动期定）\n')
    deps.onIdle?.()
    return
  }
  try {
    const next = writeProfile(deps.dataRoot, arg)
    deps.out(`[prts] 已切换模型预设：${next.label}（窗口 ${next.contextWindow}）\n`)
    deps.out('[prts] 需要重启 serve 才生效——provider 与上下文窗口都是启动期定的。\n')
  } catch (error) {
    deps.out(`[prts] ${error instanceof Error ? error.message : String(error)}\n`)
    deps.out('[prts] 用法：/model <预设名>\n')
  }
  deps.onIdle?.()
}

/**
 * `/persona [预设名]`：查看 / 切换当前人格预设（owner 通道）。
 *
 * 为什么需要它：切换能力在库层已有（`PersonaStore.switchTo`，`persona/store.ts:185`），
 * 但 chat 侧此前零入口——「每次启动都是普瑞赛斯，想换回 prts 却没有现成的入口」
 * 就是这么来的，而 V1-03 盲评的前置正是「先切回 prts 预设」。
 *
 * 生效边界必须说清：`renderPrefix()` 只在 `start.ts:292` 启动时调一次，装配进
 * DSH 的 `personaPrefix` section（`dsh-system-prompt/lib/index.js:236` 在构造时读入），
 * 所以运行中切换**不改变当前会话的 system prompt**，必须重启 `prts chat`。
 * 输出里明写这一点，否则用户会以为切坏了。
 */
async function runPersona(deps: ChatDeps, arg: string): Promise<void> {
  const dbPath = process.env.PRTS_PERSONA_DB ?? join(deps.dataRoot, 'persona.sqlite')
  let store: PersonaStore | undefined
  try {
    store = PersonaStore.open(dbPath)
    const current = store.activePreset()
    if (arg === '') {
      deps.out(`[prts] 当前人格预设：${current ?? '（无，沿用 config 的 personaPrefix）'}\n`)
      deps.out('[prts] 用法：/persona <预设名>；切换后需重启 prts chat 才生效\n')
      return
    }
    if (arg === current) {
      deps.out(`[prts] 已经是 ${arg}，无需切换\n`)
      return
    }
    const now = store.switchTo({ kind: 'owner' }, arg)
    deps.out(`[prts] 已切到 ${now}（原：${current ?? '无'}）\n`)
    deps.out('[prts] 人格在启动时装配，**重启 prts chat 后生效**\n')
  } catch (error) {
    deps.out(`[prts] 人格切换失败：${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    store?.close()
    deps.onIdle?.()
  }
}

/*
 * ---- V1-09 技能库：owner 通道（评估 / 采用 / 拒绝 / 退役 / 恢复）----
 *
 * 为什么需要它：全生命周期在库层已完整（`src/skills/store.ts`），模型侧刻意只拿到
 * `prts_skill_propose` / `prts_skill_list`（`src/runtime/skill-tools.ts` 头注释：
 * 「模型能自己采用经验，等于能自己给自己加能力」）。但 evaluate/adopt 的 owner
 * 入口此前一处都没有——`grep -rn "\.adopt(\|\.evaluate(" src` 除 skills 模块自身外
 * 零命中，于是生产库里那条候选（`C:\prts-data\skills.sqlite`，phase=candidate，
 * evaluations=[]）从提出起永远停在原地。这条命令补的就是那个缺失的执行者位。
 *
 * 生效边界与 `/persona` 相反：技能注入是 `attachSkillInjection` 每轮
 * `list({ phase: 'active' })`（`src/runtime/skill-inject.ts`），不是启动期装配，
 * 所以采用后**下一轮就生效**，不需要重启。输出里不要提示重启，那是错的。
 *
 * 为什么命令自开连接而不是复用运行时的 store：`ChatDeps` 不带 skills 句柄，且
 * 技能库与 `/persona` 同层（owner 直连 SQLite）。两条连接读同一文件不冲突——
 * 写只发生在 REPL 空闲时，注入层只读；跨连接可见性由 `test/cli/skill-command.test.ts`
 * 的 K3 守着。
 */
const SKILL_PHASES: readonly string[] = ['candidate', 'active', 'retired', 'rejected']
const SKILL_VERDICTS: readonly string[] = ['adopt', 'reject', 'needs-work']

/** 短 id：12 字符足够唯一（`sk-` + uuid 前 9 位），且能直接粘回命令。 */
function skillShortId(id: string): string {
  return id.slice(0, 12)
}

function skillLine(s: SkillSnapshot): string {
  const next = s.phase === 'candidate'
    ? `\n      下一步：/skill eval ${skillShortId(s.id)} adopt|reject|needs-work <依据>`
    : ''
  return `  ${skillShortId(s.id)}  ${s.phase.padEnd(9)}  ${s.title}${next}\n`
}

/**
 * id 解析：精确 → 唯一前缀 → 报错。
 *
 * 歧义**不猜**：采用是能力扩张决策，选错一条的代价大于让博士多打几位。
 */
function resolveSkill(store: SkillStore, ref: string): SkillSnapshot {
  if (ref === '') throw new Error('缺少技能 id（先跑 /skill 看候选）')
  const all = store.list()
  const exact = all.find((s) => s.id === ref)
  if (exact !== undefined) return exact
  const hits = all.filter((s) => s.id.startsWith(ref))
  const first = hits[0]
  if (first === undefined) throw new Error(`没有匹配 ${ref} 的技能（/skill list --all 查看全部）`)
  if (hits.length > 1) {
    throw new Error(`${ref} 匹配到 ${hits.length} 条，请多写几位：${hits.map((s) => skillShortId(s.id)).join(', ')}`)
  }
  return first
}

async function runSkill(deps: ChatDeps, arg: string): Promise<void> {
  const dbPath = process.env.PRTS_SKILLS_DB ?? join(deps.dataRoot, 'skills.sqlite')
  const parts = arg.split(/\s+/).filter((x) => x !== '')
  const head = parts[0]
  // 裸 `/skill` 与 `/skill --all` 都按 list 处理：别让一个开关逼人多打一次子命令。
  const sub = head === undefined || head.startsWith('-') ? 'list' : head
  const owner = { kind: 'owner' } as const
  let store: SkillStore | undefined
  try {
    store = SkillStore.open(dbPath)

    if (sub === 'list') {
      const rest = parts.slice(1)
      const all = rest.includes('--all')
      const wanted = rest.find((x) => SKILL_PHASES.includes(x)) as SkillPhase | undefined
      if (!all && wanted === undefined) {
        // 默认只看候选：采用与否是博士的动作，待办队列才是该被看见的东西。
        const queue = store.list({ phase: 'candidate' })
        if (queue.length === 0) {
          const active = store.list({ phase: 'active' }).length
          deps.out(`[prts] 没有待评估的候选（已采用 ${active} 条）。/skill list --all 看全部\n`)
          return
        }
        deps.out(`[prts] 待评估候选 ${queue.length} 条：\n`)
        for (const s of queue) deps.out(skillLine(s))
        // 采用要求「最近一次评估是 adopt」（store.ts:adopt），所以 eval 在 adopt 之前；
        // 两行并列写出来，免得博士对着候选找采用命令。
        deps.out('[prts] /skill show <id> 看全文；/skill eval <id> <结论> <依据> → /skill adopt <id> 才生效\n')
        return
      }
      const rows = all ? store.list() : store.list({ phase: wanted as SkillPhase })
      if (rows.length === 0) { deps.out('[prts] 技能库为空\n'); return }
      deps.out(`[prts] 技能 ${rows.length} 条：\n`)
      for (const s of rows) deps.out(skillLine(s))
      return
    }

    if (sub === 'show') {
      const s = resolveSkill(store, parts[1] ?? '')
      deps.out(`[prts] ${s.title}\n`)
      deps.out(`   id：${s.id}\n   相位：${s.phase}   提议者：${s.proposedBy.kind}\n`)
      deps.out(`   何时用：${s.trigger}\n`)
      s.steps.forEach((step, i) => deps.out(`   ${i + 1}) ${step}\n`))
      const pitfalls = s.pitfalls ?? []
      if (pitfalls.length > 0) deps.out(`   注意：${pitfalls.join('；')}\n`)
      const sourceRefs = s.sourceRefs ?? []
      if (sourceRefs.length > 0) deps.out(`   来源：${sourceRefs.join(', ')}\n`)
      // 使用信号：采用之后到底有没有被用起来。这是观测，不是效果证明——
      // 「提供过 N 次」不等于「每次都有用」，效果归因需要任务级埋点。
      const usage = store.usageStats(s.id)
      deps.out(`   提供过：${usage.offered} 次`
        + (usage.lastOfferedAt === null ? '\n' : `（最近 ${new Date(usage.lastOfferedAt).toISOString().slice(0, 16).replace('T', ' ')}）\n`))
      if (s.evaluations.length === 0) deps.out('   评估：尚无\n')
      else for (const e of s.evaluations) deps.out(`   评估：${e.verdict}——${e.basis}\n`)
      if (s.retireReason !== undefined) deps.out(`   退役理由：${s.retireReason}\n`)
      return
    }

    if (sub === 'eval') {
      const ref = parts[1] ?? ''
      const verdict = parts[2] ?? ''
      if (!SKILL_VERDICTS.includes(verdict)) {
        deps.out('[prts] 用法：/skill eval <id> adopt|reject|needs-work <依据>\n')
        return
      }
      const basis = parts.slice(3).join(' ').trim()
      if (basis === '') {
        deps.out('[prts] 评估必须给依据：/skill eval <id> <结论> <为什么>\n')
        return
      }
      const s = resolveSkill(store, ref)
      const after = store.evaluate(owner, { id: s.id, revision: s.revision }, {
        verdict: verdict as SkillVerdict,
        basis,
      })
      deps.out(`[prts] 已记录评估「${after.title}」→ ${verdict}（相位仍是 ${after.phase}）\n`)
      if (verdict === 'adopt') deps.out(`[prts] 采用它：/skill adopt ${skillShortId(after.id)}\n`)
      return
    }

    if (sub === 'adopt') {
      const s = resolveSkill(store, parts[1] ?? '')
      const after = store.adopt(owner, { id: s.id, revision: s.revision })
      deps.out(`[prts] 已采用「${after.title}」（${skillShortId(after.id)}）——下一轮对话起会注入到相关问题上\n`)
      return
    }

    if (sub === 'reject' || sub === 'retire' || sub === 'restore') {
      const s = resolveSkill(store, parts[1] ?? '')
      const reason = parts.slice(2).join(' ').trim()
      if (reason === '') {
        deps.out(`[prts] 用法：/skill ${sub} <id> <理由>（理由必填：退掉却不记为什么，下次还会被重新提出）\n`)
        return
      }
      const ref = { id: s.id, revision: s.revision }
      const after = sub === 'reject'
        ? store.reject(owner, ref, reason)
        : sub === 'retire'
          ? store.retire(owner, ref, reason)
          : store.restore(owner, ref, reason)
      const verb = sub === 'reject' ? '已拒绝' : sub === 'retire' ? '已退役' : '已恢复'
      deps.out(`[prts] ${verb}「${after.title}」（${after.phase}）：${reason}\n`)
      return
    }

    deps.out('[prts] 用法：/skill [list [--all|active|retired|rejected] | show <id> | '
      + 'eval <id> adopt|reject|needs-work <依据> | adopt|reject|retire|restore <id> [理由]]\n')
  } catch (error) {
    deps.out(`[prts] 技能命令失败：${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    store?.close()
    deps.onIdle?.()
  }
}

export async function runChat(deps: ChatDeps): Promise<ChatResult> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const ctx = deps.ctx as any
  const agents = ctx.get('agents') as {
    create(o: unknown): Promise<{ agent: { status: string; followup(m: unknown): void } }>
    /** `/switch` 用：返回 bare Agent（不可 dispose，见 dsh-agent/lib/types/index.d.ts:138）。 */
    get?(id: string): { status: string; followup(m: unknown): void } | undefined
  }
  const events = ctx.events as { on(name: string, fn: (e: unknown) => void): () => void } | undefined
  // agent/error 已由 startRuntime 挂的 error-report 写 stderr，不重复订阅。

  let sessionId = deps.sessionId ?? `prts-chat-${Date.now()}`
  // 续接（重连或显式复用同一 sessionId）：已有 live agent 时直接接管，不重复 create——
  // 同一 sessionId 再 create 会与 registry 里的旧条目冲突，新 agent 也接不上原会话上下文。
  const existing = agents.get?.(sessionId)
  // `/switch` 会替换目标：agent 与 sessionId 都必须是可重新赋值的绑定。
  const { agent: createdAgent } = existing === undefined
    ? await agents.create({
      sessionId,
      meta: { cwd: deps.cwd },
      agentOptions: {
        provider: 'deepseek-official',
        // 模型路由可覆盖：本地 Ollama（q38-gsq-iq3s）等通过 PRTS_LLM_MODEL 指定；
        // provider 名保持 deepseek-official（DSH 的 provider id），baseURL 由 DEEPSEEK_BASE_URL 覆盖。
        model: process.env.PRTS_LLM_MODEL ?? 'deepseek-chat',
      },
    })
    : { agent: existing }
  let agent = createdAgent

  /*
   * 会话身份：主会话必须在跑到第一个模型回合之前就注册好。
   * 「谁是主会话」是后续权限收窄与审计归属的依据，缺登记就等于作用域空白。
   * 注册失败按 fail-closed：报错并退出，不进入主循环——静默继续会让整段会话
   * 在没有身份记录的前提下照常对话，失败被藏到最后才暴露。
   */
  try {
    // 未注册才注册：重复注册会往审计链写重复的 session.registered 事件
    //（投影是幂等 upsert，事件不是）。重连续接同一会话时走的就是这条。
    if (deps.authority !== undefined && !deps.authority.hasSessionScope(sessionId)) {
      deps.authority.registerPrimarySession(sessionId)
    }
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
  // 续接已有会话时，日志里已有历史 assistant 消息；seenSeq 必须从当前最大 seq 起，
  // 否则重连后的第一轮会把旧回复当成新回复再打一遍。
  let seenSeq = existing === undefined ? 0 : assistantAfterSeq(deps.dataRoot, sessionId, 0).seq
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
  /**
   * 切换/新建会话后的公共状态复位：替换 agent/sessionId，清掉属于旧会话的中间态
   * （流式文本、attempt、日志 seq），并丢弃旧会话的待审批请求。
   */
  const applySwitch = (next: { status: string; followup(m: unknown): void }, target: string): void => {
    // 旧会话的待审批请求必须丢弃：终端是同一个，切走后读到的 [y/N] 会应答错会话。
    deps.approvalBridge?.dropSession(sessionId)
    agent = next
    sessionId = target
    deps.onSessionChange?.(target)
    // 上一条回复的中间态与旧日志 seq 都属于旧会话，不能带进新会话。
    streamed = ''
    attemptText = ''
    attemptId = undefined
    seenSeq = 0
  }

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

    // 归档事件游标：独立于 seenSeq（后者在切换时清零），只用于事件去重。
    let archiveCursor = 0
    for (;;) {
      // 模型请求归档：回合结束后在这里执行切换，下一次对话就落在新会话里。
      // 放在 readLine 之前——否则用户不输入，归档永远不执行（readLine 是阻塞的）。
      // 游标独立于 seenSeq：seenSeq 在切换时会被清零，不能拿它当事件去重依据。
      const archiveSeq = findArchiveRequest(deps.dataRoot, sessionId, archiveCursor)
      if (archiveSeq !== null) {
        archiveCursor = archiveSeq
        const newId = `prts-chat-${Date.now()}`
        let registered = true
        // 先注册身份再 create：与 /new、spawnSubtask 同一顺序，消除「已创建但未注册」的窗口。
        if (deps.authority !== undefined) {
          try {
            deps.authority.registerPrimarySession(newId)
          } catch (error) {
            registered = false
            deps.out(`[prts] 归档中止：新会话身份注册失败 ${error instanceof Error ? error.message : String(error)}\n`)
          }
        }
        if (registered) {
          try {
            const archived = await agents.create({
              sessionId: newId,
              meta: { cwd: deps.cwd },
              agentOptions: {
                provider: 'deepseek-official',
                model: process.env.PRTS_LLM_MODEL ?? 'deepseek-chat',
              },
            })
            applySwitch(archived.agent, newId)
            archiveCursor = 0
            deps.out(`[prts] 已归档上一段，新会话 ${newId}\n`)
          } catch (error) {
            // create 失败要释放刚注册的身份，不留幽灵会话；原会话保持不变。
            try { deps.authority?.releaseSession(newId) } catch { /* 释放失败不掩盖主错误 */ }
            deps.out(`[prts] 归档失败，留在当前会话：${error instanceof Error ? error.message : String(error)}\n`)
          }
        }
        deps.onIdle?.()
      }

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
      // ---- Wave 3：会话表（live ∪ disk），只读 ----
      if (line === '/sessions') {
        const rows = listSessions({
          sessionsRoot: join(deps.dataRoot, 'dsh-home', 'sessions'),
          agents: (ctx.get('agents') as unknown as { list?(): Array<{ session?: { id?: string } }> } | undefined),
        })
        if (rows.length === 0) {
          deps.out('[prts] 还没有会话记录\n')
        } else {
          for (const r of rows) deps.out(renderSessionLine(r) + '\n')
        }
        deps.onIdle?.()
        continue
      }
      // ---- 人格预设查看/切换（owner 通道；重启后生效）----
      if (line === '/persona' || line.startsWith('/persona ')) {
        await runPersona(deps, line.slice('/persona'.length).trim())
        continue
      }
      // ---- V1-09 技能库：评估 / 采用 / 拒绝 / 退役 / 恢复（owner 通道；下一轮生效）----
      if (line === '/skill' || line.startsWith('/skill ')) {
        await runSkill(deps, line.slice('/skill'.length).trim())
        continue
      }
      // ---- 模型后端预设（owner 通道；重启 serve 后生效）----
      if (line === '/model' || line.startsWith('/model ')) {
        await runModel(deps, line.slice('/model'.length).trim())
        continue
      }
      // ---- 沙箱三档切换（仅可查看 / 工作区内修改 / 完全权限）----
      if (line === '/sandbox' || line.startsWith('/sandbox ')) {
        await runSandbox(deps, ctx, agent as { session?: { append?(type: string, data: unknown): void } }, line.slice('/sandbox'.length).trim())
        continue
      }
      // ---- Wave 3 第二步：会话切换（设计 docs/design-switch-session.md）----
      // 只切到**已存在**的 live 会话；恢复历史会话是 resume，不走这条命令。
      if (line === '/switch' || line.startsWith('/switch ')) {
        const target = line.slice('/switch'.length).trim()
        if (target === '') {
          deps.out('[prts] 用法：/switch <sessionId>（/sessions 查看可用会话）\n')
          deps.onIdle?.()
          continue
        }
        if (target === sessionId) {
          deps.out(`[prts] 已经在这个会话（${target}）\n`)
          deps.onIdle?.()
          continue
        }
        const next = agents.get?.(target)
        if (next === undefined) {
          deps.out(`[prts] 没有活跃会话 ${target}；/sessions 查看可用会话\n`)
          deps.onIdle?.()
          continue
        }
        // 先补身份再改状态：注册失败时保持原会话，不留下「已切换但无身份」的半截状态。
        if (deps.authority !== undefined && !deps.authority.hasSessionScope(target)) {
          try {
            deps.authority.registerPrimarySession(target)
          } catch (error) {
            deps.out(`[prts] 会话身份注册失败，未切换：${error instanceof Error ? error.message : String(error)}\n`)
            deps.onIdle?.()
            continue
          }
        }
        applySwitch(next, target)
        deps.out(`[prts] 已切到 ${target}\n`)
        deps.onIdle?.()
        continue
      }
      // ---- Wave 3 第二步：新建会话（设计 Q3 最小入口的 `/new`）----
      if (line === '/new') {
        const newId = `prts-chat-${Date.now()}`
        // 先注册身份再 create：与 spawnSubtask 同一顺序，消除「已创建但未注册」的窗口。
        if (deps.authority !== undefined) {
          try {
            deps.authority.registerPrimarySession(newId)
          } catch (error) {
            deps.out(`[prts] 新会话身份注册失败：${error instanceof Error ? error.message : String(error)}\n`)
            deps.onIdle?.()
            continue
          }
        }
        let created: { agent: { status: string; followup(m: unknown): void } }
        try {
          created = await agents.create({
            sessionId: newId,
            meta: { cwd: deps.cwd },
            agentOptions: {
        provider: 'deepseek-official',
        // 模型路由可覆盖：本地 Ollama（q38-gsq-iq3s）等通过 PRTS_LLM_MODEL 指定；
        // provider 名保持 deepseek-official（DSH 的 provider id），baseURL 由 DEEPSEEK_BASE_URL 覆盖。
        model: process.env.PRTS_LLM_MODEL ?? 'deepseek-chat',
      },
          })
        } catch (error) {
          // create 失败要释放刚注册的身份，不留幽灵会话；原会话保持不变。
          try { deps.authority?.releaseSession(newId) } catch { /* 释放失败不掩盖主错误 */ }
          deps.out(`[prts] 新建会话失败：${error instanceof Error ? error.message : String(error)}\n`)
          deps.onIdle?.()
          continue
        }
        applySwitch(created.agent, newId)
        deps.out(`[prts] 已新建会话 ${newId}\n`)
        deps.onIdle?.()
        continue
      }
      // ---- Wave 3 分派器：Router 侧把任务交给 worker，只回摘要 ----
      if (line === '/dispatch' || line.startsWith('/dispatch ')) {
        const task = line.slice('/dispatch'.length).trim()
        if (task === '') {
          deps.out('[prts] 用法：/dispatch <任务>（worker 只回摘要）\n')
          deps.onIdle?.()
          continue
        }
        if (deps.dispatch === undefined || deps.authority === undefined) {
          deps.out('[prts] 未配置分派器（需要 dispatch 配置与 authority），/dispatch 不可用\n')
          deps.onIdle?.()
          continue
        }
        const results = await dispatchTasks({
          ctx: deps.ctx,
          authority: deps.authority,
          workspace: deps.dispatch.workspace,
          dataRoot: deps.dataRoot,
          parentSessionId: sessionId,
          provider: deps.dispatch.provider,
          model: deps.dispatch.model,
        }, [{ task }])
        const r = results[0]
        if (r === undefined) {
          deps.out('[prts] 分派失败：没有返回结果\n')
        } else if (!r.ok) {
          deps.out(`[prts] 分派失败：${r.error ?? '未知错误'}\n`)
        } else if (r.summary.trim() === '') {
          deps.out(`[prts] 分派完成（${r.sessionId}），子会话没有产出文本\n`)
        } else {
          deps.out(`[prts] 分派完成（${r.sessionId}）：\n${r.summary}\n`)
        }
        deps.onIdle?.()
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
      const turnText = attemptText || streamed || fromLog.text
      // 超时（settled=false）且三路都没内容时**不许 push 空串**：上游会把空串当成
      // 「模型无话可说」，而不是「回合没跑完」——V1-18 正是这样白跑掉 15 题的
      // （端点崩了，runChat 不抛错，只把每题跑成空回复）。
      const text = turnText === "" && !settled ? "[回合未收敛：等待超时且无任何输出]" : turnText
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
