/**
 * W3 任务事件触发的主动提醒（设计见 `docs/design-superagent-fusion.md` §三 ③）。
 *
 * 原文：「任务 `blocked` 超过 N 小时、或 `claimDone` 后无人验收超过 N 小时，
 * 主动提醒一次。复用 `intent-trigger.ts` 的既有管道。」
 *
 * ## 为什么复用 `agent/pre-step` 而不是起定时器
 *
 * 与 V1-14 意图触发同一个理由：提醒必须有会话可投递。定时器到点时若没有正在
 * 进行的对话，注入无处可去。挂在 pre-step 上还有一个自然的好处——进程重启后
 * 第一次交互就会扫到停滞任务，「重启不丢失」因此不靠额外机制（跨进程的
 * 「已提醒」事实由 `src/reminders` 的留痕库承担）。
 *
 * ## 已知近似：`updatedAt` 不是「进入 blocked 的时刻」
 *
 * `TaskSnapshot` 没有记录「何时进入当前 phase」的字段（`src/ledger/types.ts`：
 * 只有 `createdAt` / `updatedAt`）。所以「blocked 已 5 小时」实际是
 * 「距上次更新已 5 小时」——只要阻塞期间任务被任何事件碰过（改预算、加步骤、
 * 记账 usage），计时就会被推后，提醒相应推迟。
 *
 * 方向是**保守**的：只会晚提醒，不会误报「停了很久」。要精确就得给账本加
 * `phase_since`（事件 `task.phase-changed` 里已有时间戳），那是账本契约的改动，
 * 不在本波次范围。等真出现「明明停了很久却没提醒」的反馈再动账本。
 *
 * ## 为什么标记范围是**全部命中项**，而不是只标记显示出来的
 *
 * 折叠只是为了不让 5 条停滞拼成一堵墙。若只标记展开的那几条，被折叠的下次
 * 还会再来——用户会看到同一条提醒反复出现在「另有 N 条」里，而永远看不到它
 * 本身。所以：**折叠只影响显示，不影响标记**（同 `intent-trigger.ts`）。
 */
import { randomUUID } from 'node:crypto'
import type { TaskSnapshot } from '../ledger/types.ts'
import type { ReminderStore } from '../reminders/types.ts'

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

/** 默认「停太久」阈值：2 小时。一个白天的阻塞通常还想再看一眼，跨夜就不该等。 */
export const DEFAULT_STALE_AFTER_MS = 2 * 3_600_000

export interface TaskReminderDeps {
  /** 任务账本（只用 `list()`；测试传 `{ list: () => tasks }` 就够）。 */
  ledger: { list(): TaskSnapshot[] }
  /** 「已提醒过」的跨进程留痕。 */
  store: ReminderStore
  /** 超过这个时长就提醒，默认 2 小时。0 = 立刻提醒所有停滞任务。 */
  staleAfterMs?: number
  /**
   * 一次最多展开几条，默认 3。
   *
   * 全展开会把多条停滞拼成一堵墙，读的人得先在墙里找最要紧的那条。
   */
  maxVisible?: number
  /** 覆盖当前时刻（测试用，默认 `Date.now`）。 */
  now?: () => number
}

export interface TaskReminder {
  /** 手动跑一次（测试用，也可绕开 hook 管道）。返回本次注入的正文数组。 */
  runOnce(): string[]
  dispose(): void
}

/** 提醒文本的识别前缀。测试与用户都靠它一眼分出「系统提醒」。 */
const MARK = '[任务提醒]'

const fmtElapsed = (ms: number): string => {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} 分钟`
  const hour = Math.round(min / 60)
  if (hour < 48) return `${hour} 小时`
  return `${Math.round(hour / 24)} 天`
}

/** 进程内去重键：任务 + 阶段，「同一任务从 blocked 变成 verifying」是两次提醒。 */
/**
 * 已提醒键。带上 `updatedAt` 是关键：同一任务 unblock 后再次 blocked（或重新提交验收）
 * 是一次**新的停滞**，`updatedAt` 会前进，旧键不该把新停滞压住。
 */
const keyOf = (taskId: string, kind: string, updatedAt: number): string => `${taskId}\u0000${kind}\u0000${updatedAt}`

/**
 * 压成一行。标题或阻塞原因里的换行会破坏「- 一条一行」的结构，
 * 使「另有 N 条」的计数与肉眼行数对不上。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * blocked 的原因文本。message 比 code 可读（「等博士确认」优于 `need-input`），
 * 但 code 永远存在、message 可能为空——所以有 message 用 message，否则退回 code。
 */
function blockedReasonText(task: TaskSnapshot): string {
  const reason = task.blockedReason
  if (reason === undefined) return ''
  const text = typeof reason.message === 'string' && reason.message !== '' ? reason.message : reason.code
  if (typeof text !== 'string' || text === '') return ''
  return `（原因：${oneLine(text)}）`
}

/** 单个任务一行。blocked 带阻塞原因（博士最需要的是「卡在哪」）。 */
function describeTask(task: TaskSnapshot, at: number): string {
  const title = oneLine(typeof task.title === 'string' && task.title !== '' ? task.title : task.id)
  const age = fmtElapsed(Math.max(0, at - task.updatedAt))
  if (task.phase === 'verifying') return `- 「${title}」等你验收，已 ${age}`
  return `- 「${title}」blocked 已 ${age}${blockedReasonText(task)}`
}

/** 停滞阶段：等外部输入的 blocked，和等验收的 verifying。 */
const isStalePhase = (task: TaskSnapshot): boolean =>
  task.phase === 'blocked' || task.phase === 'verifying'

export function attachTaskReminder(
  hookCtx: { on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void },
  deps: TaskReminderDeps,
): TaskReminder {
  const rawStale = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  // 0 是合法阈值（= 立刻提醒）；负数 / 非有限数是参数错误，回落默认而不是变成「永远提醒」。
  const staleAfterMs = typeof rawStale === 'number' && Number.isFinite(rawStale) && rawStale >= 0
    ? rawStale
    : DEFAULT_STALE_AFTER_MS
  const rawMax = deps.maxVisible ?? 3
  const maxVisible = Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : 3
  const rawNow = deps.now ?? Date.now
  /**
   * 时钟包一层校验：`now` 返回 NaN/Infinity 时 `at - updatedAt < staleAfterMs` 因
   * NaN 比较恒为 false，**所有**任务（含刚更新的）都会通过停滞筛选；随后 record
   * 拒绝非法 notifiedAtMs 被 catch 吞掉——既不落留痕也不进 fired，每个 step 重复注入。
   */
  const now = (): number => {
    const v = rawNow()
    return typeof v === 'number' && Number.isFinite(v) ? v : Date.now()
  }
  /**
   * 防同一 step 重放重复注入：waterfall 重试会对同一步触发多次，
   * 而留痕发生在 `runOnce` 内、`wasNotified` 查的是库——两次重放之间库里已经有行，
   * 这条集合只是把「同一进程内已知提醒过」的判断提前，少一次查询、也防库写失败时的重复。
   */
  const fired = new Set<string>()

  /**
   * 选停滞任务并渲染正文，**不写留痕**。
   *
   * 与 `markAll` 分开的理由：投递可能因为预算裁剪或上游 reject 而没真正发生，
   * 而留痕一旦先写就把「这一次停滞」永久标记成已提醒。顺序必须是
   * 「真的追加进 messages → 再留痕」。
   */
  const selectStale = (): { tasks: TaskSnapshot[]; body: string } | undefined => {
    const at = now()
    // 先按「阶段 + 时长」筛，再查留痕：留痕查询是 IO，能量小的先筛掉。
    const candidates = deps.ledger.list().filter((task) => {
      if (!isStalePhase(task)) return false
      if (typeof task.updatedAt !== 'number' || !Number.isFinite(task.updatedAt)) return false
      if (at - task.updatedAt < staleAfterMs) return false
      if (fired.has(keyOf(task.id, task.phase, task.updatedAt))) return false
      // 「这一次停滞」是否已提醒过：旧留痕只有在它**不早于**本轮 updatedAt 时才算数。
      // 任务 unblock 后再次 blocked，updatedAt 前进，旧留痕失效，会重新提醒。
      const last = deps.store.lastNotifiedAt(task.id, task.phase)
      return last === undefined || last < task.updatedAt
    })
    if (candidates.length === 0) return undefined

    // 最久的排前面。`updatedAt` 相同时按账本顺序（下标）定序——不依赖
    // Array#sort 的稳定性假设，让「先后」在任何引擎上都可复现。
    const ordered = candidates
      .map((task, index) => ({ task, index }))
      .sort((a, b) => (a.task.updatedAt - b.task.updatedAt) || (a.index - b.index))
      .map((entry) => entry.task)

    const visible = ordered.slice(0, maxVisible)
    const lines = visible.map((task) => describeTask(task, at))
    const hidden = ordered.length - visible.length
    // 折叠只改显示：提示里那句「另有 N 条」必须说清去哪儿看，否则等于没提醒。
    if (hidden > 0) lines.push(`另有 ${hidden} 条未展开（用 /task 查看）`)
    return {
      tasks: ordered,
      body: [`${MARK} 以下是系统自动整理的停滞任务，不是用户本轮发言：`, ...lines].join('\n'),
    }
  }

  /** 注入成功后再写留痕；`sessionId` 记下这次提醒念给了哪个会话。 */
  const markAll = (tasks: TaskSnapshot[], sessionId: string): void => {
    const at = now()
    for (const task of tasks) {
      try {
        deps.store.record({ taskId: task.id, kind: task.phase, notifiedAtMs: at, sessionId })
        fired.add(keyOf(task.id, task.phase, task.updatedAt))
      } catch (error) {
        console.error(
          `[prts] task reminder record failed (${task.id}/${task.phase}): ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /** 手动跑一次（测试入口）：算完即标记，复用旧语义。 */
  const runOnce = (): string[] => {
    const picked = selectStale()
    if (picked === undefined) return []
    markAll(picked.tasks, '')
    return [picked.body]
  }

  const off = hookCtx.on('agent/pre-step', async (payload, next) => {
    // `next()` 放在 try 外：它抛错时没有 decision 可「原样返回」，该由上游处理。
    // 类型放宽到 `| null | undefined` 是防上游插件返回非对象——`?.` 一并兜住，
    // 不让一个畸形 decision 把整个 pre-step 链路带崩。
    const decision = await next() as Decision | null | undefined
    try {
      if (decision?.kind !== 'enter') return decision
      if (!Array.isArray(decision.messages)) return decision
      const picked = selectStale()
      if (picked === undefined) return decision
      const p = payload as { agent?: { session?: { id?: string } } }
      const sessionId = p.agent?.session?.id ?? ''
      const out = {
        ...decision,
        messages: [
          ...decision.messages,
          {
            id: `task-reminder-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text: picked.body }],
            source: { kind: 'user' },
          },
        ],
      }
      // 注入成功后才留痕（与旧实现顺序相反，理由见 selectStale 注释）。
      markAll(picked.tasks, sessionId)
      return out
    } catch (error) {
      // 提醒失败绝不能阻断对话——它是增强，不是闸门。
      console.error(`[prts] task reminder failed: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return {
    runOnce,
    dispose: () => { off(); fired.clear() },
  }
}
