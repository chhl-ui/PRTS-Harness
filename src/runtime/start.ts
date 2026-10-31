/** 运行时组装：boot('prts', configPath, patches, prepare) + 最小 credentials 服务 + K2a 守卫接线。 */
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { attachErrorReporter } from './error-report.ts'
import { Authority, classify } from '../authority/index.ts'
import { Ledger } from '../ledger/index.ts'
import { initCoreDb } from '../core/init.ts'

export interface StartRuntimeOptions {
  configPath: string
  dataRoot: string
  workspace: string
  mode: 'normal' | 'read-only'
  /** cordis-plugin-include 的 PatchOptions（overlay 禁用/追加条目）。 */
  patches?: unknown[]
  /** 内存中的密钥（不落 env）；resolve(ref) 按需返回。 */
  credentials?: { DEEPSEEK_API_KEY?: string }
  /** 账本/审计/授权共用的 SQLite 路径；缺省取 PRTS_DB 或 <dataRoot>/core.sqlite。 */
  dbPath?: string
}

/**
 * pre-execute 阶段算出、等审批时暂存的一次性能力快照。
 *
 * 存在的理由：`approval.request` 的载荷只有 agent/toolName/callId/reason/signal
 * （dsh-tools/lib/index.js:3535-3560），不含 capabilities；而
 * `Authority.recordOwnerDecision` 必须拿到 capabilities 才能写出 guard 认的
 * once 记录（authority.ts:162-172）。两侧唯一的交集是 callId，所以只能用
 * 进程内桥把 capabilities 从 pre-execute 传到 answerer。
 */
export interface PendingApproval {
  sessionId: string
  callId: string
  tool: string
  capabilities: string[]
}

/** E3 审批桥：answerer 按 callId 取走 pre-execute 暂存的 capabilities。取走即删。 */
export interface ApprovalBridge {
  take(callId: string): PendingApproval | undefined
}

const createAppReady = () => {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener: () => void) {
        if (ready) { listener(); return () => {} }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const l of listeners) l()
      listeners.clear()
    },
  }
}

export async function startRuntime(o: StartRuntimeOptions): Promise<{ ctx: Context; ledger: Ledger; authority: Authority; approvalBridge: ApprovalBridge; dispose(): Promise<void> }> {
  process.env.DSH_HOME = join(o.dataRoot, 'dsh-home')
  process.env.PRTS_WORKSPACE = o.workspace
  const appReady = createAppReady()
  const ctx = await boot('prts', o.configPath, (o.patches ?? []) as never, async (hostCtx: Context) => {
    provideCmdline(hostCtx as never, {
      args: [],
      exit: (code: number) => {
        void (async () => {
          try { await (hostCtx as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose() } finally { process.exit(code) }
        })()
      },
      ready: appReady.service,
    })
    // 最小 credentials：只实现 resolve(ref)。credentialRef() 返回品牌字符串
    // （dsh-credentials lib:21），ref 即 'DEEPSEEK_API_KEY' 本身。
    hostCtx.provide('credentials', {
      resolve: (ref: string) =>
        ref === 'DEEPSEEK_API_KEY' && o.credentials?.DEEPSEEK_API_KEY
          ? { value: o.credentials.DEEPSEEK_API_KEY }
          : undefined,
    })
  })

  // K2a 接线：DSH `tools.guard` 是唯一的单调拒绝点——返回理由串即拒绝，且没有
  // guard 能强制放行被另一个 guard 拒绝的调用（dsh-tools/lib/types/index.d.ts:515-517、:656）。
  //
  // 必须挂在 boot() 返回之后：`prepare` 在 config-tree 挂载前执行
  // （dsh-app-boot/lib/types/index.d.ts:335），那时 tools 服务尚不存在。
  // 实测确认 boot 返回后 ctx.get('tools').guard 是可调用函数。
  const dbPath = o.dbPath ?? process.env.PRTS_DB ?? join(o.dataRoot, 'core.sqlite')
  // 与守护进程用同一个库（supervisor.ts:62 `join(dataRoot,'core.sqlite')`，:158 以 PRTS_DB 传入），
  // 否则授权事实会落进 K1/K4/K5 都看不见的库。initCoreDb 的建表语句全是
  // CREATE TABLE IF NOT EXISTS（ledger.ts:28、audit.ts:15），重复调用幂等。
  initCoreDb(dbPath)
  // W0：账本句柄。与守护进程用同一个 core.sqlite（supervisor.ts:62 `join(dataRoot,'core.sqlite')`，
  // :158 以 PRTS_DB 传下来），否则任务事实会落进 K1/K4/K5 都看不见的库。
  // 上面已经 initCoreDb 幂等建过表，这里直接 open 即可。
  const ledger = Ledger.open(dbPath)
  const authority = Authority.open(dbPath, {
    workspaceRoots: [o.workspace],
    protectedRoots: [o.dataRoot],
  })

  const tools = ctx.get('tools') as
    | {
      guard(guard: (execution: unknown) => string | undefined): () => void
      register(definition: unknown): () => void
    }
    | undefined
  if (tools === undefined || typeof tools.guard !== 'function') {
    // fail closed：拿不到强制点就以无守卫状态启动，等于假装有授权层。
    throw new Error('prts: tools 服务缺失或不可用，无法挂载 K2a 守卫，拒绝以无守卫状态启动')
  }

  const detachGuard = tools.guard((execution) => {
    const exec = execution as {
      readonly callId: unknown
      readonly name: string
      readonly arguments: unknown
      readonly agent?: { session?: { id?: string } }
    }
    try {
      // 目前只判文件系统能力。exec / net / system / tool 暂不判：
      // K2a 对 pwsh 只能整体放行或整体拒绝（命令体内的写/删识别不了，见
      // src/authority/index.ts 头注释），整体拒绝会让 test/runtime/runtime.test.ts
      // 的 R2（pwsh 写区内文件并断言存在）必红，而且那不是真正的安全边界。
      // 这部分归 K2b 沙箱。此处显式过滤而非静默跳过。
      const capabilities = classify(exec.name, exec.arguments)
        .filter((c) => c.startsWith('fs.read:') || c.startsWith('fs.write:') || c.startsWith('fs.delete:'))
      if (capabilities.length === 0) return undefined
      return authority.guard({
        sessionId: exec.agent?.session?.id ?? '',
        callId: String(exec.callId),
        tool: exec.name,
        capabilities,
      })
    } catch (error) {
      // classify 对非法输入抛 INVALID_INPUT；DSH 对「抛异常的 guard」行为未核实，
      // 所以在这里转成拒绝理由，与 authority.ts:126 的 fail-closed 保持一致。
      return `prts authority: ${error instanceof Error ? error.message : String(error)}`
    }
  })

  // E3：越界操作先问人，而不是直接拒。
  //
  // 为什么挂 pre-execute 而不是 DSH 的 fs escalation：K2a 守卫在工具执行前就调
  // authority.guard，越界写在那里被拒并写 tool.denied（authority.ts:148-152），
  // 根本到不了 dsh-tool-fs 的 resolvePolicy。pre-execute 是异步 waterfall 且在
  // 同步的 guards 之前（dsh-tools/lib/index.js:3321 与 :3337），是唯一能在守卫之前
  // 问到人的钩子。
  //
  // 必须调 next()：cordis 的 waterfall 里不调 next 会 veto 整条链
  // （cordis/lib/index.js:310-316），连工具派发都会先被邸断。
  const pendingApprovals = new Map<string, PendingApproval>()
  const approvalBridge: ApprovalBridge = {
    take(callId) {
      const p = pendingApprovals.get(callId)
      if (p !== undefined) pendingApprovals.delete(callId)
      return p
    },
  }
  const offPreExecute = (ctx as unknown as {
    on(name: string, fn: (exec: unknown, next: () => unknown) => unknown): () => void
  }).on('tools/pre-execute', async (execution: unknown, next: () => unknown) => {
    try {
      const exec = execution as {
        readonly callId: unknown
        readonly name: string
        readonly arguments: unknown
        readonly agent?: { session?: { id?: string } }
      }
      const capabilities = classify(exec.name, exec.arguments)
        .filter((c) => c.startsWith('fs.read:') || c.startsWith('fs.write:') || c.startsWith('fs.delete:'))
      // 非文件能力不归 E3（exec/net/system 归 K2b），原样放行。
      if (capabilities.length === 0) return next()
      const sessionId = exec.agent?.session?.id ?? ''
      const callId = String(exec.callId)
      const decision = authority.decide({ sessionId, callId, tool: exec.name, capabilities })
      // 只有 ask 才问人：allow 原样放行，deny（如 protectedRoots）不可审批，
      // 交回同步守卫去拒并落 tool.denied——保持「守卫是唯一强制点」不变量。
      if (decision.kind !== 'ask') return next()
      pendingApprovals.set(callId, { sessionId, callId, tool: exec.name, capabilities })
      return { kind: 'ask', reason: decision.reason }
    } catch (error) {
      // 审批链路自身出错不能让工具静默放行，也不能把工具全邸断：
      // 记一笔并交回默认放行，由同步守卫兑现强制点。
      console.error(`[prts] approval gate failed: ${error instanceof Error ? error.message : String(error)}`)
      return next()
    }
  })

  // W3：回合记账。订阅 tools/result（emit 型，与 guard 同一条已验证可用的路径）。
  //
  // 已知权衡：begin/end 背靠背写，不留 started 中间态，所以 recoverOnStartup 不会
  // 看到本进程的孤儿 step。挂 tools/execute（waterfall，需 ctx.on 而非 events.on）
  // 能保留 started 态，但那套订阅方式尚未实测，留作改进项——记账正确性优先于
  // 崩溃观测粒度。
  //
  // 记账失败绝不否决工具执行：钩子内全程 try/catch，失败只写 stderr。
  const stepNumbers = new Map<string, number>()
  const events = (ctx as unknown as {
    events?: { on(name: string, fn: (...args: never[]) => void): () => void }
  }).events
  const offToolResult = events?.on('tools/result', ((execution: unknown, result: unknown) => {
    try {
      const exec = execution as {
        readonly callId: unknown
        readonly name: string
        readonly agent?: { session?: { id?: string } }
      }
      const sessionId = exec.agent?.session?.id
      if (sessionId === undefined || sessionId === '') return
      const task = ledger.taskForSession(sessionId)
      if (task === undefined) return
      // stepNo 用进程内缓存，首次从投影里的已完成数推得。这是可重建的缓存，不是事实。
      const next = stepNumbers.get(task.id) ?? ledger.steps(task.id).length
      const stepNo = next + 1
      stepNumbers.set(task.id, stepNo)
      const actor = { kind: 'model' as const, sessionId }
      ledger.beginStep(actor, task.id, {
        stepNo,
        name: exec.name,
        idempotent: false,
        toolCallRef: String(exec.callId),
      })
      ledger.endStep(actor, task.id, stepNo, {
        status: (result as { isError?: boolean }).isError === true ? 'failed' : 'succeeded',
      })
    } catch (error) {
      console.error(`[prts] ledger step record failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  // W4b：模型侧任务入口。只能产出 draft，且 acceptance 强制 owner-confirm——
  // 否则「建任务 → 写文件 → claimDone → verifier 全过」会从后门绕开
  // 「完成判定不来自模型」这条不变量。
  //
  // 注：本工具不经过 guard 的文件能力判定（prts_task_create 不产生 fs.* 能力），
  // 权限控制体现在三点：只能建 draft、只能 owner-confirm、不能自己 activate。
  const offTaskTool = tools.register({
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
        properties: { taskId: { type: 'string' }, phase: { type: 'string' } },
        required: ['taskId', 'phase'],
        additionalProperties: false,
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { taskId: string; phase: string }
        return [{ type: 'text', text: `已提交任务草案 ${v.taskId}（${v.phase}），等待博士批准。` }]
      },
    },
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = args as { title?: unknown; objective?: unknown }
      const sessionId = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
      const created = ledger.create(
        { kind: 'model', sessionId: sessionId ?? '' },
        {
          title: String(a.title ?? ''),
          objective: String(a.objective ?? ''),
          acceptance: { kind: 'owner-confirm' },
        },
      )
      return { taskId: created.id, phase: created.phase }
    },
  })

  // turn 内失败只经 agent/error 上报：dsh-agent-loop 的 throwError() emit 后 throw，
  // kick() 的 catch 吞掉异常传播。不订阅则失败完全静默。
  const detachErrorReporter = attachErrorReporter(ctx)
  if (ctx.get('loader') !== undefined) appReady.commit()
  return {
    ctx,
    ledger,
    authority,
    approvalBridge,
    dispose: async () => {
      detachGuard()
      offPreExecute()
      offToolResult?.()
      offTaskTool()
      // Ledger 与 Authority 各自持有 sqlite 连接，都不由 ctx 生命周期管理；
      // 不关会在 Windows 上锁住文件，临时目录清理报 EPERM。
      ledger.close()
      // Authority 自带 AuditLog 连接（authority.ts:44 close → audit.close）。
      authority.close()
      detachErrorReporter()
      await ctx.fiber.dispose()
    },
  }
}
