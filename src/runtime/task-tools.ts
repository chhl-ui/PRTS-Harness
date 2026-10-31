/**
 * 模型侧账本工具集（D2）+ D1 的结构前置（stepNo 分配器、账本工具排除名单）。
 *
 * ## 权限边界
 *
 * 工具清单严格来自 `MODEL_OPS`（src/ledger/ledger.ts:122-125）——库里已经声明了
 * 「模型可调哪些方法」，这里只做翻译，不新增权限。`activate` / `cancel` /
 * `setBudget` / `resumeFromStop` / `verify` / `ownerAccept` / `ownerReject` 属于
 * 固定 actor 通道（AGENTS.md「固定 actor 通道契约」），不注册为工具。
 *
 * actor 在每次 execute 内现场构造 `{kind:'model', sessionId}`：注册发生在 boot 之后，
 * 那时没有会话上下文，捕获不到 sessionId。
 *
 * ## 归属校验
 *
 * `ledger.perm`（ledger.ts:303-312）只判 actor.kind，不判任务归属——模型传别人的
 * taskId 会被照做。所以工具层必须自己做：显式 taskId 必须等于本会话绑定的任务。
 *
 * ## 这些工具不经过 K2a guard
 *
 * `classify`（authority/classify.ts:39-41）对未登记的工具名走 default 分支返回
 * `tool:<name>`，而 start.ts 的 guard 与 pre-execute 只过滤 `fs.read:`/`fs.write:`/
 * `fs.delete:` 前缀。两者叠加的结果是「不经判定」，这是分类器的实现后果，不是授权
 * 设计——不能当成「已授权」来读。因此：
 *  - 新增任何**带文件路径参数**的工具，必须自建路径域收敛，不得假定这里是安全的；
 *  - `prts_task_add_evidence` 是唯一涉文件读取的工具，用
 *    `isWithin(realpathBestEffort(...))` 做「工作区包含 + protectedRoots 排除」双重硬判。
 *    不用 `authority.guard(cap.fsRead)`：guard 承载带状态的授权语义（grant / once），
 *    拿它做输入域校验会因一次工作区外批准永久扩大读取半径。
 */
import { isAbsolute, resolve } from 'node:path'
import { isWithin, normalizePath, realpathBestEffort } from '../authority/index.ts'
import type { Authority } from '../authority/index.ts'
import type { Actor, Ledger, TaskId, TaskSnapshot } from '../ledger/index.ts'

/** 只用到 register 这一个方法——不把整个 tools 服务拖进依赖。 */
export interface ToolRegistry {
  register(definition: unknown): () => void
}

interface ToolExec {
  readonly callId: unknown
  readonly agent?: { session?: { id?: string } }
}

/**
 * 账本写操作工具名清单：这些工具自身要写 K1 账本，它的调用不能再被 tools/execute
 * 钩子自动记账。不排除的后果：stepNo 序列被工具的自身写操作驱动，E8 的步骤断言
 * 会随「模型调了几次任务工具」漂移；prts_task_step_begin 的显式发号还会与钩子
 * 自动发号撞同一 stepNo（ledger.beginStep 对同号不同 name 抛 UNEXPECTED_STEP，
 * src/ledger/ledger.ts:663-665）。
 *
 * 名单是显式的而不是只靠前缀：新增工具必须在这里登记，否则会打一次 stderr。
 */
export const LEDGER_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'prts_task_create',
  'prts_task_list',
  'prts_task_get',
  'prts_task_note',
  'prts_task_set_resume',
  'prts_task_step_begin',
  'prts_task_step_end',
  'prts_task_add_evidence',
  'prts_task_claim_done',
  'prts_task_block',
  'prts_task_unblock',
  'prts_task_pause',
  'prts_task_resume',
])

/** 前缀兜底：漏登记的工具也不会自记账，但会打一次 stderr 让名单漂移可见。 */
const LEDGER_TOOL_PREFIX = 'prts_task_'
const warnedUnregistered = new Set<string>()

/**
 * 该工具调用是否属于「账本自身写操作」（因而不进自动记账）。
 *
 * 先查显式名单，命中即免记账；名字带 prts_task_ 前缀但未登记时仍然免记账
 * （宁可不记账也不能自记账），并对该名字首次出现打一条 stderr 提示补登记。
 */
export function isLedgerTool(name: string): boolean {
  if (LEDGER_TOOL_NAMES.has(name)) return true
  if (!name.startsWith(LEDGER_TOOL_PREFIX)) return false
  if (!warnedUnregistered.has(name)) {
    warnedUnregistered.add(name)
    console.warn(
      `[prts] 账本工具 '${name}' 未登记进 LEDGER_TOOL_NAMES，已按前缀排除自动记账；`
      + '请补登记，否则工具面与排除名单会静默漂移',
    )
  }
  return true
}

export interface StepAllocator {
  /** 为该任务分配下一个 step 号；进程内单点自增，永不回退。 */
  next(taskId: TaskId): number
}

/**
 * stepNo 单点分配器。
 *
 * 为什么需要：`beginStep` 要求调用方自带 stepNo（src/ledger/ledger.ts:648-651），
 * 而账本没有发号 API。自动记账钩子与模型侧 prts_task_step_begin 若各自推导
 * （钩子曾用 `steps().length + 1`），模型显式 beginStep 之后两条路径必然撞号。
 *
 * 取号规则：进程内 Map 优先；冷启动（或该任务首次发号）时用账本投影里的
 * **max(step_no) + 1**，不是 `steps().length + 1`——step_no 可以出现空洞
 * （owner retry unknown step、历史导入、上一进程在 beginStep 失败前已发号），
 * length+1 在空洞场景下会撞已有行。这是可重建的缓存，不是事实。
 *
 * 已知边界：跨进程（supervisor 重启）各自冷启动，若两个进程同时给同一任务发号
 * 仍可能撞号；当前写入路径单进程（chat/runtime 同进程），不引入跨进程协调。
 */
export function createStepAllocator(ledger: Ledger): StepAllocator {
  const cursors = new Map<string, number>()
  return {
    next(taskId: TaskId): number {
      const cached = cursors.get(taskId)
      let stepNo: number
      if (cached === undefined) {
        let max = 0
        for (const s of ledger.steps(taskId)) {
          if (s.stepNo > max) max = s.stepNo
        }
        stepNo = max + 1
      } else {
        stepNo = cached
      }
      cursors.set(taskId, stepNo + 1)
      return stepNo
    },
  }
}

export interface TaskToolDeps {
  ledger: Ledger
  allocator: StepAllocator
  /** 工作区根：addEvidence 的路径域上界，也是相对路径的解析基点。 */
  workspace: string
  /** 只用到 protectedRootPaths()——与 guard 判定同源的受保护根。 */
  authority: Pick<Authority, 'protectedRootPaths'>
}

export interface TaskTools {
  /** 本次实际注册的工具名（不是手写常量），用于「工具面 vs owner 通道」的静态断言。 */
  names: readonly string[]
  /** 本会话最近一次模型创建的 draft 任务；进程内易失提示，不是账本事实。 */
  draftTaskForSession(sessionId: string): TaskId | undefined
  dispose(): void
}

interface ToolContext {
  sessionId: string
  callId: string
  model: Actor
  /** 显式 taskId 原文（未解析）；undefined 表示按会话绑定取。 */
  explicitTaskId: unknown
}

const TASK_ID_PARAM = {
  taskId: {
    type: 'string',
    description: '任务 id。省略时取本会话当前绑定的任务。',
  },
} as const

function textRender(value: unknown): { type: 'text'; text: string }[] {
  const v = value as { message?: unknown }
  return [{ type: 'text', text: typeof v?.message === 'string' ? v.message : JSON.stringify(value) }]
}

/** 输出 schema 的统一形状：message 用于终端渲染，其余字段给模型看。 */
function outSchema(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: {
      type: 'object',
      properties: { message: { type: 'string' }, ...extra },
      required: ['message'],
      additionalProperties: true,
    },
    render: (_args: unknown, value: unknown) => textRender(value),
  }
}

function summarize(snap: TaskSnapshot): Record<string, unknown> {
  return { taskId: snap.id, phase: snap.phase, revision: snap.revision }
}

export function createTaskTools(tools: ToolRegistry, deps: TaskToolDeps): TaskTools {
  const { ledger } = deps
  const disposers: (() => void)[] = []
  const names: string[] = []
  const drafts = new Map<string, TaskId>()

  const sessionOf = (exec: unknown): string => {
    const id = (exec as ToolExec | undefined)?.agent?.session?.id
    if (typeof id !== 'string' || id === '') {
      throw new Error('prts: 账本工具必须在有会话的 agent 回合内调用')
    }
    return id
  }

  /**
   * 解析目标任务并做归属校验。
   *
   * ledger.perm 只判 actor.kind（ledger.ts:303-312），不判「这个任务是不是你的」。
   * 没有这一步，模型拿到任何一个 taskId 就能改写别人的任务。
   */
  const taskIdOf = (c: ToolContext): TaskId => {
    const bound = ledger.taskForSession(c.sessionId)
    if (c.explicitTaskId !== undefined && c.explicitTaskId !== null) {
      const id = String(c.explicitTaskId) as TaskId
      if (bound === undefined || bound.id !== id) {
        throw new Error(`prts: 任务 ${id} 不属于本会话，拒绝操作`)
      }
      return id
    }
    if (bound === undefined) {
      throw new Error('prts: 本会话还没有进行中的任务；先用 prts_task_create 提草案并等博士批准')
    }
    return bound.id
  }

  /** 每次操作前重读快照取 revision：自动记账钩子会推进 revision，缓存值发出即过期。 */
  const refOf = (taskId: TaskId): { id: TaskId; revision: number } => {
    const snap = ledger.get(taskId)
    return { id: snap.id, revision: snap.revision }
  }

  const register = (definition: Record<string, unknown>): void => {
    const off = tools.register(definition)
    disposers.push(off)
    names.push(String(definition.name))
  }

  /**
   * 证据路径域：工作区包含 + protectedRoots 排除。
   *
   * 返回交给账本的路径是**规范化后的绝对路径**（不是 realpath 结果）：账本会把
   * artifactPath 原样记进事件，保留调用方视角的路径更便于人读。
   */
  const evidencePath = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('prts: artifactPath 必须是非空字符串')
    }
    const abs = isAbsolute(raw) ? normalizePath(raw) : normalizePath(resolve(deps.workspace, raw))
    const root = realpathBestEffort(deps.workspace)
    const real = realpathBestEffort(abs)
    if (!isWithin(real, root)) {
      throw new Error(`prts: 证据必须位于工作区内：${abs}`)
    }
    for (const p of deps.authority.protectedRootPaths()) {
      if (isWithin(real, p)) {
        throw new Error(`prts: 证据不能来自受保护目录：${abs}`)
      }
    }
    return abs
  }

  /** 写类工具的统一外壳：取会话 → 解析任务 → 重读 revision → 交业务方法。 */
  const writeTool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    outputExtra: Record<string, unknown>,
    run: (c: ToolContext, args: Record<string, unknown>) => unknown,
  ): void => {
    register({
      name,
      description,
      parameters,
      output: outSchema(outputExtra),
      execute: async (args: unknown, exec: unknown): Promise<unknown> => {
        const a = (args ?? {}) as Record<string, unknown>
        const c: ToolContext = {
          sessionId: sessionOf(exec),
          callId: String((exec as ToolExec).callId),
          // actor 现场构造：注册时没有会话，捕获不到。
          model: { kind: 'model', sessionId: sessionOf(exec) },
          explicitTaskId: a.taskId,
        }
        return run(c, a)
      },
    })
  }

  // ---------- 创建与查询 ----------

  register({
    name: 'prts_task_create',
    description:
      '提出一个任务草案。草案进入 draft 状态，必须由博士用 /task-approve 批准后才生效；'
      + '你不能自己批准，也不能为草案指定自动化验收条件。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '简短标题' },
        objective: { type: 'string', description: '目标，写清楚要达成什么' },
      },
      required: ['title', 'objective'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          taskId: { type: 'string' },
          phase: { type: 'string' },
        },
        required: ['message', 'taskId', 'phase'],
        additionalProperties: true,
      },
      render: (_args: unknown, value: unknown) => textRender(value),
    },
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { title?: unknown; objective?: unknown }
      const sessionId = sessionOf(exec)
      const created = ledger.create(
        { kind: 'model', sessionId },
        {
          title: String(a.title ?? ''),
          objective: String(a.objective ?? ''),
          acceptance: { kind: 'owner-confirm' },
        },
      )
      // 指针不是绑定：draft 仍然不属于任何会话（task-tool.test.ts:70 钉住这条）。
      // 指针只为无参 /task-approve 提供寻址，重启丢失不影响显式 id 的路径。
      drafts.set(sessionId, created.id)
      return {
        message: `已提交任务草案 ${created.id}（${created.phase}），等待博士批准。`,
        taskId: created.id,
        phase: created.phase,
      }
    },
  })

  /** 本会话可见的任务：当前绑定 + 刚提的草案，不暴露全局任务表。 */
  const visibleIds = (sessionId: string): TaskId[] => {
    const out: TaskId[] = []
    const bound = ledger.taskForSession(sessionId)
    if (bound !== undefined) out.push(bound.id)
    const draft = drafts.get(sessionId)
    if (draft !== undefined && draft !== bound?.id) out.push(draft)
    return out
  }

  register({
    name: 'prts_task_list',
    description: '列出本会话可见的任务（当前绑定任务与刚提交的草案）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: outSchema({ tasks: { type: 'array', items: { type: 'object' } } }),
    execute: async (_args: unknown, exec: unknown): Promise<unknown> => {
      const sessionId = sessionOf(exec)
      const tasks = visibleIds(sessionId)
        .filter((id) => ledger.list().some((t) => t.id === id))
        .map((id) => summarize(ledger.get(id)))
      return { message: `本会话可见 ${tasks.length} 个任务：${JSON.stringify(tasks)}`, tasks }
    },
  })

  writeTool(
    'prts_task_get',
    '读取本会话某个任务的当前状态。省略 taskId 时取当前绑定任务。',
    { type: 'object', properties: { ...TASK_ID_PARAM }, additionalProperties: false },
    { task: { type: 'object' } },
    (c) => {
      const snap = ledger.get(taskIdOf(c))
      return { message: `任务 ${snap.id} 处于 ${snap.phase}`, task: summarize(snap) }
    },
  )

  // ---------- 推进 ----------

  writeTool(
    'prts_task_note',
    '往当前任务里写一条笔记（进展、判断、待办）。笔记只追加，不修改历史。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        text: { type: 'string', description: '笔记内容' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    { task: { type: 'object' } },
    (c, a) => {
      const snap = ledger.note(c.model, refOf(taskIdOf(c)), String(a.text ?? ''))
      return { message: '笔记已记录', task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_set_resume',
    '登记「下次从这里继续」与尚未关闭的待办，供下一次会话接手。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        next: { type: 'string', description: '下一步要做什么；传空串表示清空' },
        open: { type: 'array', items: { type: 'string' }, description: '仍未关闭的待办' },
      },
      additionalProperties: false,
    },
    { task: { type: 'object' } },
    (c, a) => {
      const next = typeof a.next === 'string' && a.next !== '' ? a.next : null
      const open = Array.isArray(a.open) ? a.open.map((x) => String(x)) : []
      const snap = ledger.setResume(c.model, refOf(taskIdOf(c)), { next, open })
      return { message: '接手信息已登记', task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_claim_done',
    '声明任务已完成。任务进入 verifying，等待博士 /accept 裁决；你不能自己判定完成。',
    { type: 'object', properties: { ...TASK_ID_PARAM }, additionalProperties: false },
    { task: { type: 'object' } },
    (c) => {
      const snap = ledger.claimDone(c.model, refOf(taskIdOf(c)))
      return { message: `已声明完成（${snap.phase}），等待博士裁决`, task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_block',
    '标记当前任务被阻塞，写明原因。阻塞由你造成时也只能由你或博士解除。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        code: { type: 'string', description: '阻塞原因的机器可读代号' },
        message: { type: 'string', description: '阻塞原因的人读说明' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
    { task: { type: 'object' } },
    (c, a) => {
      const required = String(a.code ?? '')
      if (required.trim() === '') throw new Error('prts: code 必须是非空字符串')
      const why = String(a.message ?? '')
      if (why.trim() === '') throw new Error('prts: message 必须是非空字符串')
      const snap = ledger.block(c.model, refOf(taskIdOf(c)), { code: required, message: why })
      return { message: `已标记阻塞：${why}`, task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_unblock',
    '解除当前任务的阻塞。你只能解除自己造成的阻塞；博士加的阻塞需博士解除。',
    { type: 'object', properties: { ...TASK_ID_PARAM }, additionalProperties: false },
    { task: { type: 'object' } },
    (c) => {
      const snap = ledger.unblock(c.model, refOf(taskIdOf(c)))
      return { message: '阻塞已解除', task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_pause',
    '暂停当前任务，暂停期间不能登记新步骤。',
    { type: 'object', properties: { ...TASK_ID_PARAM }, additionalProperties: false },
    { task: { type: 'object' } },
    (c) => {
      const snap = ledger.pause(c.model, refOf(taskIdOf(c)))
      return { message: '任务已暂停', task: summarize(snap) }
    },
  )

  writeTool(
    'prts_task_resume',
    '恢复被暂停的当前任务。',
    { type: 'object', properties: { ...TASK_ID_PARAM }, additionalProperties: false },
    { task: { type: 'object' } },
    (c) => {
      const snap = ledger.resume(c.model, refOf(taskIdOf(c)))
      return { message: '任务已恢复', task: summarize(snap) }
    },
  )

  // ---------- 步骤 ----------

  writeTool(
    'prts_task_step_begin',
    '声明一个执行步骤并开始。步骤编号由运行时统一发号，不要自己指定；'
    + '返回的 stepNo 在 step_end 时原样传回。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        name: { type: 'string', description: '步骤名（同一编号内必须一致）' },
        idempotent: { type: 'boolean', description: '重跑是否安全，默认 false' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    { stepNo: { type: 'number' } },
    (c, a) => {
      const name = String(a.name ?? '')
      if (name.trim() === '') throw new Error('prts: name 必须是非空字符串')
      const taskId = taskIdOf(c)
      // 与自动记账共用同一个分配器：两条路径各自推导必然撞号。
      const stepNo = deps.allocator.next(taskId)
      const result = ledger.beginStep(c.model, taskId, {
        stepNo,
        name,
        idempotent: a.idempotent === true,
      })
      return { message: `步骤 ${stepNo}（${name}）已开始：${result.kind}`, stepNo }
    },
  )

  writeTool(
    'prts_task_step_end',
    '结束一个已开始的步骤，标记成功或失败。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        stepNo: { type: 'number', description: 'step_begin 返回的编号' },
        status: { type: 'string', enum: ['succeeded', 'failed'] },
        outputRef: { type: 'string', description: '产物引用（可选）' },
      },
      required: ['stepNo', 'status'],
      additionalProperties: false,
    },
    { task: { type: 'object' } },
    (c, a) => {
      const stepNo = Number(a.stepNo)
      if (!Number.isInteger(stepNo) || stepNo <= 0) throw new Error('prts: stepNo 必须是正整数')
      const status = String(a.status ?? '')
      if (status !== 'succeeded' && status !== 'failed') {
        throw new Error("prts: status 必须是 'succeeded' 或 'failed'")
      }
      const taskId = taskIdOf(c)
      ledger.endStep(c.model, taskId, stepNo, {
        status,
        outputRef: typeof a.outputRef === 'string' && a.outputRef !== '' ? a.outputRef : undefined,
      })
      return { message: `步骤 ${stepNo} 已结束（${status}）`, task: summarize(ledger.get(taskId)) }
    },
  )

  // ---------- 证据 ----------

  writeTool(
    'prts_task_add_evidence',
    '把一个工作区内文件的哈希登记为任务证据。路径必须在工作区内，且不能落在受保护目录。',
    {
      type: 'object',
      properties: {
        ...TASK_ID_PARAM,
        artifactPath: { type: 'string', description: '工作区内的文件路径（绝对或相对）' },
        producedBy: { type: 'string', description: '谁产出的，默认 model' },
      },
      required: ['artifactPath'],
      additionalProperties: false,
    },
    { task: { type: 'object' } },
    (c, a) => {
      // 先过路径域，再交账本——账本会真的 readFileSync 算 sha256，
      // 放行一个越界路径等于开一条任意文件读取通道。
      const abs = evidencePath(a.artifactPath)
      const producedBy = typeof a.producedBy === 'string' && a.producedBy !== '' ? a.producedBy : 'model'
      const snap = ledger.addEvidence(c.model, refOf(taskIdOf(c)), {
        artifactPath: abs,
        producedBy,
      })
      return { message: `证据已登记：${abs}`, task: summarize(snap) }
    },
  )

  return {
    names,
    draftTaskForSession(sessionId: string): TaskId | undefined {
      return drafts.get(sessionId)
    },
    dispose(): void {
      for (const off of disposers) {
        try { off() } catch { /* 卸载失败不阻断其余卸载 */ }
      }
      disposers.length = 0
    },
  }
}
