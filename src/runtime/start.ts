/** 运行时组装：boot('prts', configPath, patches, prepare) + 最小 credentials 服务 + K2a 守卫接线。 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { attachErrorReporter } from './error-report.ts'
import { AppContainerSandboxProvider, appContainerProfileName } from '../sandbox/provider.ts'
import { ensureWorkspaceWriteOwner, protectSubpathLocal, protectSubpathAppContainer } from '../sandbox/workspace-acl.ts'
import { deriveAppContainerSid } from '../sandbox/appcontainer.ts'
import { DEFAULT_READ_ONLY_SUBPATHS } from '../authority/index.ts'
import { createStepAllocator, createTaskTools, isLedgerTool } from './task-tools.ts'
import { createMemoryTools } from './memory-tools.ts'
import { createIntentTools } from './intent-tools.ts'
import { createSkillTools } from './skill-tools.ts'
import { attachIntentTrigger } from './intent-trigger.ts'
import { attachMemoryInjection } from './memory-inject.ts'
import { attachAssembly } from './assembly.ts'
import { attachSkillInjection } from './skill-inject.ts'
import { attachEmotionInjection } from './emotion-inject.ts'
import { attachSessionRecall } from './session-recall.ts'
import { attachProactiveRecall } from './proactive-recall.ts'
import { attachTaskReminder } from './task-reminder.ts'
import { createSubtaskTool } from './subtask.ts'
import { resolveTokenBudget } from './token-budget.ts'
import { ToolLoopGuard } from './tool-loop-guard.ts'
import { attachToolLoopAudit } from './tool-loop-audit.ts'
import { attachMemoryScheduler, createOllamaProbe, type MemoryScheduler } from './memory-scheduler.ts'
import { Authority, classify } from '../authority/index.ts'
import { openProactiveStore, type ProactiveStore } from '../proactive/index.ts'
import { openReminderStore, type ReminderStore } from '../reminders/index.ts'
import { openCostStore, priceFromEnv, priceOf, type CostStore } from '../cost/index.ts'
import { Ledger } from '../ledger/index.ts'
import type { TaskId } from '../ledger/index.ts'
import { initCoreDb } from '../core/init.ts'
import { MemoryStore, OllamaEmbedder, OpenAiCompatibleEmbedder, OllamaGenerator } from '../memory/index.ts'
import { SkillStore } from '../skills/index.ts'
import { PersonaStore } from '../persona/index.ts'
import { EmotionStore } from '../emotion/index.ts'
import { PythonReranker } from '../memory/rerank.ts'
import { attachSpill, resolveSpillRoot } from '../spill/wiring.ts'

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
  /**
   * 记忆库路径。显式参数优先于 `PRTS_MEMORY_DB` 环境变量——测试里改环境变量
   * 会污染同进程并行跑的其它用例（`node --test` 共享 process.env），
   * 曾导致一次不可重现的失败。
   */
  memoryDbPath?: string
  /**
   * 测试注入点：替换 workspace-acl 的三步实现（默认真执行 icacls/PowerShell）。
   * 失败注入用于验证「protect 抛错 → 启动拒绝」的 fail-closed 接线。
   */
  aclOps?: {
    ensureWO?: typeof ensureWorkspaceWriteOwner
    protectLocal?: typeof protectSubpathLocal
    protectAC?: typeof protectSubpathAppContainer
  }
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
  /**
   * 会话切换：丢弃属于该会话的待审批请求，返回丢弃条数。
   * 切走后这些请求若仍留在桥里，会被**新会话的输入流**应答（终端是同一个），
   * 等于把旧会话的越界动作记到错误的上下文里。其他会话的 pending 不受影响。
   */
  dropSession(sessionId: string): number
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

/**
 * boot 失败时把 `cause.errors` 里的插件明细挪到顶层 message。
 *
 * 为什么需要：DSH 抛的顶层错误只有一句 `1 required plugin did not activate`——用户
 * 看到这句只知道「有插件没起来」，不知道改 config 的哪一行。而真正的明细就在
 * `cause.errors`（`AggregateError`）里，逐条带包名与失败原因：
 *
 * ```
 * Failed plugins (1):
 *   include (required)
 *     Package: cordis:i
 * ```
 *
 * 只在 `cause.errors` 非空时包装；其他错误原样抛出，不改变既有错误类型与调用方判断。
 */
async function bootWithDiagnostics<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error))
    const items = (err as { cause?: { errors?: unknown[] } }).cause?.errors
    if (!Array.isArray(items) || items.length === 0) throw err
    const lines = items.slice(0, 5).map((x) => {
      const msg = String((x as { message?: unknown })?.message ?? x)
      return `  - ${msg.split('\n')[0]}`
    })
    const more = items.length > 5 ? `\n  …另有 ${items.length - 5} 条` : ''
    const wrapped = new Error(`${err.message}\n失败插件（${items.length}）：\n${lines.join('\n')}${more}`)
    ;(wrapped as { cause?: unknown }).cause = err
    throw wrapped
  }
}

export async function startRuntime(o: StartRuntimeOptions): Promise<{
  /** 记忆库句柄（打不开时为 undefined）。 */
  memory?: MemoryStore
  /** Authority/Ledger 共用的 core.sqlite 路径。 */
  dbPath: string
  ctx: Context
  ledger: Ledger
  authority: Authority
  approvalBridge: ApprovalBridge
  /** 本次实际注册的 prts_task_* 工具名（注册回执，不是手写常量）。 */
  toolNames: readonly string[]
  /** 本会话最近一次模型创建的 draft；进程内易失提示，不是账本事实。 */
  draftTaskForSession(sessionId: string): TaskId | undefined
  /** 后台巩固调度器（`PRTS_CONSOLIDATE=off` 或记忆库不可用时为 undefined）。 */
  memoryScheduler?: MemoryScheduler
  /** 本次实际生效的 shell 沙箱后端（`PRTS_SANDBOX_BACKEND` 的解析结果）。 */
  sandboxBackend: 'local' | 'appcontainer'
  dispose(): Promise<void>
}> {
  // 沙箱后端开关：默认仍是 dsh-sandbox-local（既有行为不变）。切到 appcontainer
  // 时必须先禁用配置里的 `sandbox` 条目——两者都注册成 ctx.sandbox，会同名冲突。
  // 用开关而不是直接替换，是为了出问题能一行改回去。
  const backend = process.env.PRTS_SANDBOX_BACKEND === 'appcontainer' ? 'appcontainer' : 'local'
  // AppContainer profile 名只解析一次：ACL 授权的容器 SID 与 provider 实际用的
  // profile 必须是同一个名字。两处不同步会出现「ACL 授给 A 容器、进程却跑在 B
  // 容器里」——权限判定静默错位，比并发冲突更严重的形态。
  // 生产（没有覆盖、没有 NODE_TEST_CONTEXT）解析结果仍是 `PRTS.Sandbox`。
  const appContainerProfile = appContainerProfileName()
  // local 是默认后端；C:\ 下 workspace 的 shell 故障根因是 WRITE_OWNER（实测：
  // grantWrite 设 Low 标签需要 WO，UAC 未提权下 C:\ 自建目录只有继承 ACL）。
  // 启动时自动授 WO——失败不 throw（shell 不可用是功能降级，不是安全问题），
  // 但 warn 出管理员要执行的确切命令。
  const aclOps = {
    ensureWO: o.aclOps?.ensureWO ?? ensureWorkspaceWriteOwner,
    protectLocal: o.aclOps?.protectLocal ?? protectSubpathLocal,
    protectAC: o.aclOps?.protectAC ?? protectSubpathAppContainer,
  }
  if (backend === 'local') {
    try {
      await aclOps.ensureWO(o.workspace)
    } catch (error) {
      console.warn(
        `[prts] workspace WRITE_OWNER 授权失败：${error instanceof Error ? error.message : String(error)}`
        + `——shell 在该 workspace 上可能起不来。管理员可执行：`
        + `icacls "${o.workspace}" /grant "%USERNAME%:(OI)(CI)(WO)"`
        + `（或换用 PRTS_SANDBOX_BACKEND=appcontainer）。`,
      )
    }
  }
  // .git 对 shell 只读（K2a readOnlySubpaths 只管 fs 工具，pwsh 不受管）——
  // local 用显式 DENY，appcontainer 用断继承+去写+授 RX（容器 SID 的 DENY
  // 被内核忽略，allow-only 模型）。protect 失败必须 throw：保护不上意味着
  // 模型可以改写 git 历史，fail-closed 拒绝启动。
  // 规范名（`PRTS.Sandbox`）的容器 SID 一并授只读：profile 名可以跨启动漂移
  // （显式覆盖、测试上下文按 pid 隔离），旧 ACE 会留在 `.git` 上，而「保护落在
  // 一个再也不会用到的 SID 上」正是这条修复最容易留下的形态。两个 SID 都**只授
  // RX、不加任何写允许**，属于收紧而不是放宽；生产下两个名字相同，去重后只调用
  // 一次，与今天完全一致。派生是 Win32 调用，只在 appcontainer 后端做。
  // 只授「本次真正会用的那个 profile」的 SID。曾经为迁就按规范名断言的旧测试，
  // 这里把规范名也一并授了 RX——那会让测试失去「ACL 与 provider 不同源」的检测能力，
  // 还会在 `.git` 上留下一条没有进程使用的 ACE。正确做法是让测试跟着同源。
  const aclContainerSids = backend === 'appcontainer'
    ? [deriveAppContainerSid(appContainerProfile)]
    : []
  for (const sub of DEFAULT_READ_ONLY_SUBPATHS) {
    if (backend === 'local') await aclOps.protectLocal(o.workspace, sub)
    else for (const sid of aclContainerSids) await aclOps.protectAC(o.workspace, sub, sid)
  }
  // 人格（V1-03/04/05/09 的底座）：启动时从 persona 库读当前预设，覆盖 DSH 的
  // personaPrefix。库不存在或没有任何预设时**不动 config**——沿用 config/prts.yml
  // 里那一段，不凭空捏一个人格出来。
  //
  // ⚠️ patches 是**顶层键整体覆盖**，不是深合并（`dsh-app-boot/lib/index.js:96`
  // 的 `target[key] = value`）。只给 `config.personaPrefix` 会把
  // `includeHarnessIdentity` / `includeRuntimeContext` 一起抹掉——所以三个字段写全。
  let persona: PersonaStore | undefined
  let personaPrefix = ''
  try {
    mkdirSync(o.dataRoot, { recursive: true })
    persona = PersonaStore.open(process.env.PRTS_PERSONA_DB ?? join(o.dataRoot, 'persona.sqlite'))
    const chain = persona.verifyChain()
    if (!chain.ok) {
      // 链断 = 人格历史被改过。此时渲染「当前人格」等于把可能被篡改的底线装进
      // system prompt，所以回落配置值并留痕。
      console.error(`[prts] persona chain broken at seq ${chain.brokenAtSeq} — 回落到 config 的 personaPrefix`)
      persona.close()
      persona = undefined
    } else {
      personaPrefix = persona.renderPrefix()
    }
  } catch (error) {
    console.error(`[prts] persona store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  const bootPatches = [...(o.patches ?? [])]
  if (personaPrefix !== '') {
    bootPatches.push({
      id: 'system-prompt',
      config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix },
    })
  }
  if (backend === 'appcontainer') bootPatches.push({ id: 'sandbox', disabled: true })
  process.env.DSH_HOME = join(o.dataRoot, 'dsh-home')
  process.env.PRTS_WORKSPACE = o.workspace
  const appReady = createAppReady()
  const ctx = await bootWithDiagnostics(() => boot('prts', o.configPath, bootPatches as never, async (hostCtx: Context) => {
    provideCmdline(hostCtx as never, {
      args: [],
      exit: (code: number) => {
        void (async () => {
          try { await (hostCtx as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose() } finally { process.exit(code) }
        })()
      },
      ready: appReady.service,
    })
    // AppContainer 后端：在这里注册，因为 prepare 早于 config-tree 挂载，此时
    // `sandbox` 条目已被上面的 patch 禁用，不会与 dsh-sandbox-local 抢同一个
    // 服务名。Service 构造会自动注册为 ctx.sandbox。
    // spill 根必须在容器授权之前就存在：icacls 对不存在的目录会 exit 2，而
    // AppContainer 的读权限授权就发生在下面几行里。建不出来不阻断——降级为
    // 「沙箱里没有该读权限」，spill 自己写入时会再报一次。
    try {
      mkdirSync(resolveSpillRoot(o.dataRoot), { recursive: true })
    } catch { /* 交给 spill 写入时报错 */ }
    if (backend === 'appcontainer') {
      void new AppContainerSandboxProvider(hostCtx, {
        profile: appContainerProfile,
        runnerPath: fileURLToPath(new URL('../sandbox/runner.ts', import.meta.url)),
        // spill 根要给沙箱读权限：不给的话卸载的文件在 shell 里 `Test-Path`
        // 返回 Access is denied（真机实测），卸载了却读不回来。
        // 这里重算一次是因为 provider 早于 spillRoot 的定义；resolveSpillRoot
        // 是只读 env 的纯函数，两处结果必然一致。
        readPaths: [resolveSpillRoot(o.dataRoot)],
      })
    }
    // 最小 credentials：只实现 resolve(ref)。credentialRef() 返回品牌字符串
    // （dsh-credentials lib:21），ref 即 'DEEPSEEK_API_KEY' 本身。
    hostCtx.provide('credentials', {
      resolve: (ref: string) =>
        ref === 'DEEPSEEK_API_KEY' && o.credentials?.DEEPSEEK_API_KEY
          ? { value: o.credentials.DEEPSEEK_API_KEY }
          : undefined,
    })
  }))

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

  // 记忆库：独立文件，不与 core.sqlite 混（K1/K4/K5 的库是护栏事实，
  // 记忆是对话内容，两者的保留与删除策略不同——设计稿 §6.6 的删除流程
  // 只作用于记忆库，不该波及账本链）。
  // 打开失败不阻止运行时启动：记忆不可用是功能降级，不是安全问题；
  // 但必须留下明确痕迹，否则会变成「记不住也查不出原因」的静默失效。
  let memory: MemoryStore | undefined
  try {
    mkdirSync(o.dataRoot, { recursive: true })
    memory = MemoryStore.open(o.memoryDbPath ?? process.env.PRTS_MEMORY_DB ?? join(o.dataRoot, 'memory.sqlite'))
    // P2-1：启动即校验记忆事件链。链断说明事件被改/被截——投影可能来自
    // 被篡改的历史，注入它比没有记忆更糟，所以整条记忆面停用（fail-closed：
    // 对话仍能进行，只是没有记忆，且 stderr 留下明确痕迹）。
    const chain = memory.verifyChain()
    if (!chain.ok) {
      console.error(`[prts] memory chain broken at seq ${chain.brokenAtSeq} — memory disabled for this run`)
      memory.close()
      memory = undefined
    }
  } catch (error) {
    console.error(`[prts] memory store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // V1-09 技能库：独立 DB、独立链。与记忆面互不牵连——记忆挂了不该连带让
  // 「上次学到的做法」也消失，反之亦然。链断与记忆同一取舍：fail-closed 停用
  // 技能面（对话仍可进行），并在 stderr 留下痕迹，不静默。
  let skills: SkillStore | undefined
  try {
    skills = SkillStore.open(process.env.PRTS_SKILLS_DB ?? join(o.dataRoot, 'skills.sqlite'))
    const chain = skills.verifyChain()
    if (!chain.ok) {
      console.error(`[prts] skills chain broken at seq ${chain.brokenAtSeq} — skills disabled for this run`)
      skills.close()
      skills = undefined
    }
  } catch (error) {
    console.error(`[prts] skills store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // V1-05 情感状态：与 persona / skills 同构的独立库 + 独立链。链断同样 fail-closed
  // —— 情绪历史被改过时，按被篡改的值决定「该用什么语气说话」比不注入更糟。
  let emotion: EmotionStore | undefined
  try {
    emotion = EmotionStore.open(process.env.PRTS_EMOTION_DB ?? join(o.dataRoot, 'emotion.sqlite'))
    const chain = emotion.verifyChain()
    if (!chain.ok) {
      console.error(`[prts] emotion chain broken at seq ${chain.brokenAtSeq} — 情感面停用`)
      emotion.close()
      emotion = undefined
    }
  } catch (error) {
    console.error(`[prts] emotion store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // V1-07 主动回忆的留痕库：与 memory 分库——记忆模块明确不做主动回忆
  //（`docs/design-memory-v1.md:1077`），留痕是评价「恰当率」的抽样源，
  // 不属于记忆事实。打不开时整条线缺席：没有留痕就没有冷却与上限，宁可不提。
  let proactiveMentions: ProactiveStore | undefined
  try {
    proactiveMentions = openProactiveStore(process.env.PRTS_PROACTIVE_DB ?? join(o.dataRoot, 'proactive.sqlite'))
  } catch (error) {
    console.error(`[prts] proactive store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // W3 任务提醒的留痕库：独立库，与 proactive 同构（都是「主动行为留痕」）。
  // 打不开时整条线缺席——没有留痕就无法保证「只提醒一次」，宁可不提。
  let reminders: ReminderStore | undefined
  try {
    reminders = openReminderStore(process.env.PRTS_REMINDER_DB ?? join(o.dataRoot, 'reminders.sqlite'))
  } catch (error) {
    console.error(`[prts] reminder store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  // V1-16 费用计量：独立库，只记录不阻断（模型 vs 巩固分开计）。
  // 单价从 `PRTS_PRICE_*_PER_M` 读，未配置时只记 token、金额记 0（不编造）。
  let cost: CostStore | undefined
  try {
    cost = openCostStore(process.env.PRTS_COST_DB ?? join(o.dataRoot, 'cost.sqlite'))
  } catch (error) {
    console.error(`[prts] cost store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  // 工具结果卸载的存储根：默认与 dataRoot 平级，**不嵌在受保护根里**——
  // 嵌进去会被 `fs.read` 的 protectedRoots 判定拒掉，卸载的内容模型就永远读不回来
  // （见 docs/design-tool-output-spill.md §5.1 与议事会指出的 v1 硬伤）。
  const spillRoot = resolveSpillRoot(o.dataRoot)
  // 联网白名单：`PRTS_NET_ALLOW=api.deepseek.com,*.githubusercontent.com`。
  // 不配 = 所有联网动作都要人点头（与改动前一致）。支持 *.host 通配子域。
  const netAllowHosts = (process.env.PRTS_NET_ALLOW ?? '')
    .split(',').map((h) => h.trim()).filter((h) => h !== '')

  const authority = Authority.open(dbPath, {
    workspaceRoots: [o.workspace],
    protectedRoots: [o.dataRoot],
    spillRoots: [spillRoot],
    ...(netAllowHosts.length === 0 ? {} : { netAllowHosts }),
  })
  if (netAllowHosts.length > 0) {
    console.error(`[prts] net 白名单已启用（${netAllowHosts.length} 项）：这些域名下的联网动作不再逐次审批`)
  }

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
      // K2a + K2b(net)：目前判文件系统与联网能力。exec / system / tool 仍不判：
      // K2a 对 pwsh 只能整体放行或整体拒绝（命令体内的写/删识别不了，见
      // src/authority/index.ts 头注释），整体拒绝会让 test/runtime/runtime.test.ts
      // 的 R2（pwsh 写区内文件并断言存在）必红，而且那不是真正的安全边界。
      // K2b 的 net 之所以能单独纳入：它是**数据出境**动作，一次 fetch 就能把记忆里的
      // 对话带走，而 `Authority.evalCap` 对 net 的默认策略是 ask（按 host 授权才 allow），
      // 不会像整体拒绝 exec 那样一刀切掉现有能力。此处显式过滤而非静默跳过。
      const capabilities = classify(exec.name, exec.arguments)
        .filter((c) => c.startsWith('fs.read:') || c.startsWith('fs.write:')
          || c.startsWith('fs.delete:') || c.startsWith('net:'))
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
    dropSession(sessionId) {
      let dropped = 0
      for (const [callId, p] of pendingApprovals) {
        if (p.sessionId === sessionId) {
          pendingApprovals.delete(callId)
          dropped += 1
        }
      }
      return dropped
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
  /** T2：stepNo 单点分配器——自动记账与模型侧 prts_task_begin_step 共用，避免撞号。 */
  const stepAllocator = createStepAllocator(ledger)
  /** 非 active 相位跳过自动记账的告警去重键（taskId:phase）：只提示一次，不刷屏。 */
  const warnedPhaseSkips = new Set<string>()
  /** callId → 本进程已 begin 的 step；被守卫拒绝的调用不会进这张表。 */
  const startedSteps = new Map<string, { taskId: TaskId; stepNo: number }>()
  const events = (ctx as unknown as {
    events?: { on(name: string, fn: (...args: never[]) => void): () => void }
  }).events

  // U4：beginStep 挂 tools/execute——waterfall 型，位置在 guards 之后、工具真正执行之前
  // （dsh-tools/lib/index.js:3427 晚于 :3337 的 guardReason）。
  //
  // 比原来「begin/end 都挂 tools/result 背靠背」多保留一个 started 中间态：
  // 进程在工具执行中途崩溃时，账本里留着孤儿 step，recoverOnStartup 才看得见它。
  // 代价：被守卫拒绝的调用走不到 execute，因此不再产生 step——这是更准确的语义，
  // 拒绝不是「执行失败」，它压根没执行。
  //
  // 必须调 next()：cordis 的 waterfall 里不调 next 会 veto 整条链（cordis/lib/index.js:310-316）。
  //
  // 三道门，顺序即语义：
  //  T1 账本工具自身的调用不记账——否则 stepNo 序列被工具自己的写操作驱动；
  //  T2 stepNo 由分配器单点发号，与模型侧显式 beginStep 共用同一号源；
  //  T3 只有 active 相位才记账——bindSession 允许 draft/paused/blocked（ledger.ts:466），
  //     而 beginStep 的 checkStepGate 只放行 active（ledger.ts:328-337），
  //     不挡这道门，表现就是每次工具调用一行 stderr 噪音。
  const offToolExecute = (ctx as unknown as {
    on(name: string, fn: (exec: unknown, next: () => unknown) => unknown): () => void
  }).on('tools/execute', async (execution: unknown, next: () => unknown) => {
    const exec = execution as {
      readonly callId: unknown
      readonly name: string
      readonly agent?: { session?: { id?: string } }
    }
    // T1：判定在 try 之外，但只读名字、带类型防御——「记账失败绝不否决执行」这条
    // 不变量不能因为一次 name 类型漂移被打破。
    if (typeof exec.name === 'string' && isLedgerTool(exec.name)) return next()
    try {
      const sessionId = exec.agent?.session?.id
      if (sessionId !== undefined && sessionId !== '') {
        const task = ledger.taskForSession(sessionId)
        if (task !== undefined && task.phase === 'active') {
          // T2：初值取账本投影的 max(step_no)+1，之后进程内自增。可重建的缓存，不是事实。
          const stepNo = stepAllocator.next(task.id)
          ledger.beginStep({ kind: 'model' as const, sessionId }, task.id, {
            stepNo,
            name: exec.name,
            idempotent: false,
            toolCallRef: String(exec.callId),
          })
          startedSteps.set(String(exec.callId), { taskId: task.id, stepNo })
        } else if (task !== undefined) {
          // T3：跳过要可见——账本从「拒绝记录」退化到「无记录」时不能无声。
          // 每个 (task, phase) 只提示一次，长会话不会把 stderr 刷满。
          const key = `${task.id}:${task.phase}`
          if (!warnedPhaseSkips.has(key)) {
            warnedPhaseSkips.add(key)
            console.warn(
              `[prts] 自动记账跳过：任务 ${task.id} 处于 '${task.phase}'，只有 active 相位的工具调用进账本`,
            )
          }
        }
      }
    } catch (error) {
      // 记账失败绝不否决工具执行——记账失败是缺陷，否决执行是事故。
      console.error(`[prts] ledger beginStep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  // U4：endStep 仍挂 tools/result（emit 型），但只收尾本进程 begin 过的调用。
  //
  // 同一处接工具循环检测（Super-agent 模块 5 缺的那一半）：`supervisor` 只答
  // 「进程活着吗」，这里答「这活是不是在原地打转」。**只标记、不自动停**——
  // `stop('S1')` 会 cancelAllTurns，一次误报就杀掉整轮对话，而「模型因为第一次超时
  // 重试同一条命令」是设计文档里自己列出的预测误报模式（design-superagent-fusion.md 七-2）。
  // 停机权留在上层，等有真实误报率数据再说。
  const toolLoopGuard = new ToolLoopGuard()
  // 疑似循环落审计链：日志会滚掉，而「误报率是多少」是决定要不要把它接进
  // StopController 的唯一依据（design-superagent-fusion.md 三-①）。复用 Authority
  // 那条写连接，不另开——同一 DB 多一条写连接只会增加 WAL 写锁竞争。
  const detachToolLoopAudit = attachToolLoopAudit(toolLoopGuard, authority.auditLog)
  const offToolResult = events?.on('tools/result', ((execution: unknown, result: unknown) => {
    try {
      const exec = execution as {
        readonly callId: unknown
        readonly name: unknown
        readonly arguments: unknown
        readonly agent?: { session?: { id?: string } }
      }
      // 检测放独立 try：它失败不该连带丢掉 endStep 的记账。
      try {
        const loopSessionId = exec.agent?.session?.id ?? ''
        if (typeof exec.name === 'string' && loopSessionId !== '') {
          const verdict = toolLoopGuard.observe({
            sessionId: loopSessionId, toolName: exec.name, args: exec.arguments,
          })
          if (verdict.kind === 'suspect') {
            console.error(
              `[prts] tool loop suspected: ${exec.name} 连续 ${verdict.count} 次相同参数`
              + `（session ${loopSessionId}，指纹 ${verdict.fingerprint}）`,
            )
          }
        }
      } catch { /* 循环检测是观测，失败静默 */ }
      const key = String(exec.callId)
      const started = startedSteps.get(key)
      if (started === undefined) return
      startedSteps.delete(key)
      const sessionId = exec.agent?.session?.id ?? ''
      ledger.endStep({ kind: 'model' as const, sessionId }, started.taskId, started.stepNo, {
        status: (result as { isError?: boolean }).isError === true ? 'failed' : 'succeeded',
      })
    } catch (error) {
      console.error(`[prts] ledger endStep failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  // V1-06 的前置接线：把用户消息落成情景记忆。
  //
  // 挂 `agent/inbox/claimed`（emit 型）而不是 `agent/turn-stopping`——后者载荷只有
  // {agent, turn, signal}，拿不到文本；前者载荷带 `message: UserMessage`。
  // （类型见 node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts 中
  //  'agent/inbox/claimed' 与 'agent/turn-stopping' 两处声明，不凭记忆猜。）
  //
  // 纪律：写记忆失败绝不能影响对话。整段包在 try/catch 里，只打日志。
  const extractText = (content: unknown): string => {
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content
      .map((block) => (
        block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
          ? String((block as { text?: unknown }).text ?? '')
          : ''
      ))
      .join('')
      .trim()
  }

  const offMemoryTurn = memory === undefined ? undefined : events?.on('agent/inbox/claimed', ((payload: unknown) => {
    try {
      const p = payload as {
        agent?: { session?: { id?: string } }
        message?: { content?: unknown }
        turn?: number
      }
      const sessionId = p.agent?.session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      const text = extractText(p.message?.content)
      if (text === '') return
      memory?.recordTurn({
        actor: 'system',
        sessionId,
        turnIndex: typeof p.turn === 'number' ? p.turn : 0,
        speaker: 'user',
        text,
        occurredAtMs: Date.now(),
      })
    } catch (error) {
      console.error(`[prts] memory recordTurn failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  // 助手回复同样要落盘：只记 user 的记忆，问「上次聊了什么」时缺一半。
  //
  // 事件形状（`src/cli/chat.ts:27-45` 按同一契约处理）：
  //   `agent/assistant-stream` → { agent, frame }；只有 frame.type='chunk' 且
  //     frame.chunk.type='text-delta' 才承载可见文本增量；
  //   `agent/turn-stopping` → { agent, turn }，回合边界，在这里落盘。
  // **不用 `assistant/message`**：它在 runtime-types.d.ts:132 是 `eventType` 字段，
  // 不是可订阅的事件名，拿不到正文。
  //
  // 写失败同样只打日志，绝不影响对话。
  const assistantBuffers = new Map<string, string>()

  const offMemoryAssistantStream = memory === undefined ? undefined : events?.on('agent/assistant-stream', ((payload: unknown) => {
    try {
      const p = payload as {
        agent?: { session?: { id?: string } }
        frame?: { type?: string; chunk?: { type?: string; text?: string } }
      }
      const sid = p.agent?.session?.id
      if (typeof sid !== 'string' || sid === '') return
      const frame = p.frame
      if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
      const text = frame.chunk.text
      if (typeof text !== 'string' || text === '') return
      assistantBuffers.set(sid, (assistantBuffers.get(sid) ?? '') + text)
    } catch (error) {
      console.error(`[prts] memory stream buffer failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  const offMemoryTurnStop = memory === undefined ? undefined : events?.on('agent/turn-stopping', ((payload: unknown) => {
    try {
      const p = payload as { agent?: { session?: { id?: string } }; turn?: number }
      const sid = p.agent?.session?.id
      if (typeof sid !== 'string' || sid === '') return
      const text = (assistantBuffers.get(sid) ?? '').trim()
      assistantBuffers.delete(sid)
      if (text === '') return
      memory?.recordTurn({
        actor: 'system',
        sessionId: sid,
        turnIndex: typeof p.turn === 'number' ? p.turn : 0,
        speaker: 'assistant',
        text,
        occurredAtMs: Date.now(),
      })
    } catch (error) {
      console.error(`[prts] memory recordTurn(assistant) failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  // V1-16 费用计量：模型调用的 usage 来自 `agent/assistant-stream` 的 usage chunk
  // （`dsh-llm` 的 StreamChunk 变体，带 input/output/cache 四路 token）。
  // 独立订阅而不是并进上面的 text-delta 处理：记账失败不该拖累记忆落盘，反之亦然。
  const costPrice = priceFromEnv()
  const offCostUsage = cost === undefined ? undefined : events?.on('agent/assistant-stream', ((payload: unknown) => {
    try {
      const p = payload as {
        frame?: {
          type?: string
          chunk?: {
            type?: string
            usage?: {
              inputTokens?: number
              outputTokens?: number
              cacheReadTokens?: number
              cacheWriteTokens?: number
            }
          }
        }
      }
      const chunk = p.frame?.chunk
      if (p.frame?.type !== 'chunk' || chunk?.type !== 'usage' || chunk.usage === undefined) return
      const u = chunk.usage
      const usage = {
        inputTokens: u.inputTokens ?? 0,
        outputTokens: u.outputTokens ?? 0,
        ...(u.cacheReadTokens === undefined ? {} : { cacheReadTokens: u.cacheReadTokens }),
        ...(u.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: u.cacheWriteTokens }),
      }
      cost?.record({ kind: 'model', ...usage, usd: priceOf(usage, costPrice) })
    } catch (error) {
      console.error(`[prts] cost usage record failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }) as never)

  // W4b/D2：模型侧账本工具集。清单严格来自 MODEL_OPS（ledger.ts:122-125），
  // 固定 actor 通道（activate/cancel/setBudget/resumeFromStop/verify/ownerAccept/
  // ownerReject）不注册为工具。实现与路径域收敛见 src/runtime/task-tools.ts 头部。
  //
  // 这里传进去的 allocator 与上面自动记账用的是同一个实例——两条写入路径各自
  // 推导 stepNo 必然撞号（ledger.beginStep 对同号不同 name 抛 UNEXPECTED_STEP）。
  const taskTools = createTaskTools(tools, {
    ledger,
    allocator: stepAllocator,
    workspace: o.workspace,
    authority,
  })

  // 记忆消费出口（2026-11-02）：此前 `search()` 在 src 内零调用方，记忆只写不读。
  // 库打不开时 `memory` 为 undefined，工具面一起缺席——不注册一个永远报错的工具，
  // 那只会让模型学会绕开它。
  // Wave 2 向量语义路：`PRTS_EMBED=1` 显式开启（与 PRTS_CONSOLIDATE_MODEL
  // 同一纪律——本地模型是加分项，主人没表态前不擅自拉起 GPU）。开启后：
  // 注入与 prts_memory_recall 的查询会被嵌入并走 search({queryVector})，
  // 调度器空闲时给 fact/profile/turn 补向量；Ollama 探活不过或嵌入失败时
  // 各环节各自降级为纯字面检索。模型用 PRTS_EMBED_MODEL 覆盖（默认 bge-m3）。
  const envNum = (name: string, fallback: number): number => {
    const raw = Number(process.env[name] ?? '')
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
  }
  const ollamaUrl = process.env.PRTS_OLLAMA_URL ?? 'http://127.0.0.1:11434'
  const ollamaProbe = createOllamaProbe({ baseUrl: ollamaUrl })
  // 后端选择（2026-11-05）：`PRTS_EMBED_BACKEND=openai` 走 OpenAI 兼容端点
  // （llama.cpp `llama-server --embedding`），默认仍是 ollama 保持既有行为。
  // 换后端不需要重算向量表：实测 bge-m3 在 llama.cpp 下同为 1024 维。
  // openai 模式不做探活——llama-server 没有 `/api/tags`；失败时由 embed 抛错，
  // 各调用点各自降级为纯字面检索（与 ollama 侧同一降级路径）。
  const embedBackend = process.env.PRTS_EMBED_BACKEND ?? 'ollama'
  const embedModel = process.env.PRTS_EMBED_MODEL ?? 'bge-m3'
  const embedUrl = process.env.PRTS_EMBED_URL
    ?? (embedBackend === 'openai' ? 'http://127.0.0.1:11435' : ollamaUrl)
  const embedderResolver = (process.env.PRTS_EMBED !== '1')
    ? undefined
    : async () => {
      if (embedBackend === 'openai') {
        return new OpenAiCompatibleEmbedder({ baseUrl: embedUrl, model: embedModel })
      }
      return (await ollamaProbe())
        ? new OllamaEmbedder({ baseUrl: ollamaUrl, model: embedModel })
        : undefined
    }

  // 交叉编码器精排（可选）：`PRTS_RERANK=1` 开启。
  //
  // 依据：产品口径（注入 5 条、候选池 15 条）@5 从 28.8% → 38.1%
  // （+22 题，McNemar p=0.0000），见 `docs/memory-recall-criteria-retest-2026-11-03.md` 第九节。
  // 只重排候选、不新增命中——候选池内召回的 41.9% 是硬上限。
  //
  // 为什么默认关闭：它依赖 Python + sentence-transformers（Ollama 不提供 rerank 接口），
  // 是额外运行时依赖；不开时检索行为与之前逐字一致。
  // 失败降级：进程起不来 / 超时 / 崩溃一律回落原顺序，注入照常发生（见 memory-inject.ts）。
  const reranker = process.env.PRTS_RERANK === '1'
    ? new PythonReranker({
      script: process.env.PRTS_RERANK_SCRIPT
        ?? fileURLToPath(new URL('../../scripts/rerank-server.py', import.meta.url)),
      ...(process.env.PRTS_RERANK_PYTHON === undefined ? {} : { python: process.env.PRTS_RERANK_PYTHON }),
      ...(process.env.PRTS_RERANK_MODEL === undefined ? {} : { model: process.env.PRTS_RERANK_MODEL }),
      timeoutMs: envNum('PRTS_RERANK_TIMEOUT_MS', 10_000),
    })
    : undefined

  // 语义路启用时预热内存向量索引。
  //
  // 为什么必须做：`search` 的语义路在未预热时走 SQL 降级路径，
  // `ORDER BY owner_kind, owner_id LIMIT 50000` 里 `turn` 排在最后，本库 24.6 万条 turn
  // 只有 19.9% 进入扫描窗口。实测该上限下九组融合权重无一超过纯 bm25（30.9% vs 31.8%，
  // p=0.83），全量扫描下才是 36.9%（p=0.0357）。见
  // `docs/memory-recall-criteria-retest-2026-11-03.md`。
  //
  // 失败不阻断启动：没有索引只是回到降级路径（行为与 v2.17 一致），不是安全问题。
  // 但必须留下痕迹，否则又会变成「语义检索生效了却查不出它只扫了 20%」的静默失效。
  // 一次性成本：本库约 1.0 GB / 5 秒，只在这一处付。
  if (memory !== undefined && embedderResolver !== undefined) {
    try {
      const startedAt = Date.now()
      const warmed = memory.warmVectorIndex()
      const status = memory.vectorIndexStatus()
      const skipped = status.skipped > 0 ? `，跳过 ${status.skipped} 条（损坏或维度不符）` : ''
      console.error(`[prts] memory vector index warmed: ${warmed} rows / dim ${status.dimension} / ${Date.now() - startedAt} ms${skipped}`)
    } catch (error) {
      console.error(`[prts] memory vector index warm failed — 语义检索降级为 cap 50k 路径: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const memoryTools = memory === undefined ? undefined : createMemoryTools(tools, {
    store: memory,
    ...(embedderResolver === undefined ? {} : { embedder: embedderResolver }),
    ...(reranker === undefined ? {} : { reranker }),
  })

  // Wave 1 装配器：必须**最先注册**——Cordis 的 waterfall 是「先注册 = 最外层」，
  // 只有最外层的 next() 才在其余七条注入链全部追加完之后返回（见 assembly.ts 头注释）。
  // 预算延迟求值：真正的 injectBudgetTokens 在下方才算出。
  //
  // `intentTrigger` 此刻还没建（它要 `memory` 且注册点在下游）：用 holder 延后绑定。
  // 装配器只在 pre-step 运行期回调，那时 holder 早已赋值——顺序是安全的。
  let intentTrigger: ReturnType<typeof attachIntentTrigger> | undefined
  const assembly = attachAssembly(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    {
      budget: () => ({ maxTokens: injectBudgetTokens }),
      ...(memory === undefined
        ? {}
        : { record: (input: Parameters<MemoryStore['recordInjection']>[0]) => { memory.recordInjection(input) } }),
      // 「投递成功才留痕」的跨链接线：装配器报出**裁剪后仍保留**的链，
      // 只有 intent 链还在，到期提醒才算真的送到了模型眼前。
      onDelivered: (chains, sessionId) => {
        if (chains.includes('intent')) intentTrigger?.markDelivered(sessionId)
      },
    },
  )

  // V1-09：模型侧只有 propose / list。evaluate / adopt / retire / restore
  // 一律不注册——技能是能力扩张，采用与否是博士的决策（与账本「只能建 draft」同构）。
  const skillTools = skills === undefined ? undefined : createSkillTools(tools, { store: skills })

  // ⑥ 子任务上下文：模型侧 prts_subtask。派生闸与深度上限在工具内；
  // 子会话的 roots 注册、dispose、释放都由 spawnSubtask 负责。
  const subtaskTool = createSubtaskTool(tools, {
    ctx: ctx as unknown as { get(name: string): unknown },
    authority,
    workspace: o.workspace,
    dataRoot: o.dataRoot,
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  })

  // V1-09 第二半：已采用的技能按当前问题推进上下文。只注入 `active`——
  // `candidate` 是博士没批准的做法，注入它等于让模型执行未获批准的经验。
  // 与记忆/提醒/开场重建各自独立注册，一条链挂了不牵连其余三条。
  const skillInjection = skills === undefined ? undefined : attachSkillInjection(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { store: skills },
  )

  // V1-05 表达层：当前情绪作为一句提示推进上下文。注入正文里写死了
  // 「不得改变任何事实性回答」——机制层已保证一半（情感库不参与检索），
  // 另一半只能靠模型侧这条显式约束。
  const emotionInjection = emotion === undefined ? undefined : attachEmotionInjection(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { store: emotion },
  )

  // V1-14 触发（方案 B）：到期时进程在则准点，不在则下次交互补发并如实告知延迟。
  // 挂在 pre-step 而不是定时器上——提醒必须有会话可投递，定时器到点时没有对话，
  // 注入无处可去；而 pre-step 天然覆盖「重启后补发」。
  // 留痕不在这里写：本 handler 只渲染候选，真正的 `markFired` 由装配器的
  // `onDelivered`（上方）确认「intent 链真的被保留」后经 `markDelivered` 落地。
  intentTrigger = memory === undefined ? undefined : attachIntentTrigger(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { store: memory },
  )

  // 每轮自动注入：挂在 `agent/pre-step` waterfall 上，在模型看到本轮消息之前
  // 追加一条记忆摘要。库打不开时整体缺席——没有库就没有可注入的内容。
  //
  // 注入条数可用 `PRTS_MEMORY_INJECT_LIMIT` 调（默认 5）。它是运维旋钮而不是代码常量：
  // 条数直接决定注入占多少上下文，也决定「答案分散在多条 turn」时能否凑齐证据。
  // 非法值（NaN / ≤0 / 非数字）回落到 5，不静默变成 0——0 等于关掉注入。
  const injectLimitRaw = Number(process.env.PRTS_MEMORY_INJECT_LIMIT ?? '5')
  const injectLimit = Number.isFinite(injectLimitRaw) && injectLimitRaw > 0 ? Math.floor(injectLimitRaw) : 5
  // V1-14 前瞻记忆的模型侧工具：只注册 create / list。取消是所有者动作，
  // 与记忆的 forget/correct 同一纪律（模型面零破坏性工具）。
  const intentTools = memory === undefined ? undefined : createIntentTools(tools, { store: memory })

  // ③ 装配预算（`docs/context-assembly-status.md:17`）：窗口取 `DSH_CONTEXT_WINDOW`，
  // 与 `config/prts.yml` 的 `defaultContextWindow` 同一个来源；未设时按 1000000。
  // 大窗口下预算很大、实际不裁（现状 5 条记忆 ~1K token）；换成本地小模型时
  // 设 `DSH_CONTEXT_WINDOW=8192`，窗口装不下输出预留+安全余量时预算自然为 0，注入让路。
  // `PRTS_MEMORY_INJECT_BUDGET` 可显式封顶（token），0 = 关掉注入。
  const contextWindowRaw = Number(process.env.DSH_CONTEXT_WINDOW ?? '1000000')
  const injectBudgetTokens = resolveTokenBudget({
    contextWindow: Number.isFinite(contextWindowRaw) && contextWindowRaw > 0 ? contextWindowRaw : undefined,
    ...(process.env.PRTS_MEMORY_INJECT_BUDGET === undefined
      ? {}
      : { configMaxTokens: Number(process.env.PRTS_MEMORY_INJECT_BUDGET) }),
  })

  const memoryInjection = memory === undefined ? undefined : attachMemoryInjection(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    {
      store: memory, limit: injectLimit,
      budget: { maxTokens: injectBudgetTokens },
      ...(embedderResolver === undefined ? {} : { embedder: embedderResolver }),
      ...(reranker === undefined ? {} : { reranker }),
    },
  )

  // ⑦ 跨会话连续（S4）：新会话开场，从任务账本 + 意图库 + 近期情景重建
  // 「上次聊到哪里」，不整体塞上一段聊天（架构需求 §5.3 ⑦）。
  //
  // 与 memory-inject / intent-trigger 各自独立注册 handler：三者都往 pre-step 追加
  // user 消息，但失败面各不相同（检索库 / 提醒状态 / 账本），合并会让一条挂掉
  // 连带吞掉另外两条。注册顺序决定消息顺序，这里是最后一条。
  const sessionRecall = memory === undefined ? undefined : attachSessionRecall(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { store: memory, ledger },
  )

  // V1-07 主动回忆：默认开启，`PRTS_PROACTIVE=off` 关闭（验收原文「可以关闭」）。
  // 与 memory-inject 是相反方向的克制：那条每轮都答，这条多数轮次不开口。
  const proactiveRecall = memory === undefined || proactiveMentions === undefined ? undefined : attachProactiveRecall(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    {
      store: memory,
      mentions: proactiveMentions,
      enabled: process.env.PRTS_PROACTIVE !== 'off',
    },
  )

  // W3 任务提醒：blocked / verifying 停太久时主动提一次。
  // 阈值用 `PRTS_TASK_REMINDER_HOURS`（默认 2 小时）；`PRTS_TASK_REMINDER=off` 关闭。
  // 排在所有注入 handler 最后：先回答、再交代旧事、最后才是「你还有东西卡着」。
  const reminderHoursRaw = Number(process.env.PRTS_TASK_REMINDER_HOURS ?? '2')
  const taskReminder = ledger === undefined || reminders === undefined || process.env.PRTS_TASK_REMINDER === 'off'
    ? undefined
    : attachTaskReminder(
      ctx as unknown as {
        on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
      },
      {
        ledger: { list: () => ledger.list() },
        store: reminders,
        ...(Number.isFinite(reminderHoursRaw) && reminderHoursRaw >= 0
          ? { staleAfterMs: reminderHoursRaw * 3_600_000 }
          : {}),
      },
    )

  // P1-3 后台巩固调度：空闲时把 live turn 巩固成实体图与事实。
  // `PRTS_CONSOLIDATE=off` 整体关闭。
  //
  // 模型阶段（事实抽取）是**显式 opt-in**：只有设了 `PRTS_CONSOLIDATE_MODEL`
  // 才会去探活 Ollama 并跑推理。不设则只跑零成本的规则巩固——在主人没表态
  // 之前，空闲时擅自把 GPU 拉起来跑本地模型不是该系统默认做的事。
  // 探活不过时当轮只跑规则巩固（降级不是失败）。
  // 其余旋钮：PRTS_OLLAMA_URL（默认 http://127.0.0.1:11434，与向量路共用探活）、
  // PRTS_CONSOLIDATE_IDLE_MS、PRTS_CONSOLIDATE_RULES_MAX、PRTS_CONSOLIDATE_FACTS_MAX。
  const consolidateModel = process.env.PRTS_CONSOLIDATE_MODEL
  const memoryScheduler = (memory === undefined || process.env.PRTS_CONSOLIDATE === 'off') ? undefined : attachMemoryScheduler({
    store: memory,
    events: events as { on(name: string, fn: (payload: unknown) => void): () => void } | undefined,
    ...(consolidateModel === undefined ? {} : {
      generator: async () => (await ollamaProbe())
        ? new OllamaGenerator({
          baseUrl: ollamaUrl,
          model: consolidateModel === '' ? 'q38-gsq-iq3s' : consolidateModel,
          // 60 s 封顶：巩固是后台事，一批卡住不该无限挂住调度器。
          timeoutMs: envNum('PRTS_CONSOLIDATE_TIMEOUT_MS', 60_000),
        })
        : undefined,
    }),
    ...(embedderResolver === undefined ? {} : { embedder: embedderResolver, embedLimit: envNum('PRTS_EMBED_MAX', 200) }),
    idleMs: envNum('PRTS_CONSOLIDATE_IDLE_MS', 3000),
    rulesMaxTurns: envNum('PRTS_CONSOLIDATE_RULES_MAX', 500),
    factsLimit: envNum('PRTS_CONSOLIDATE_FACTS_MAX', 20),
  })

  // turn 内失败只经 agent/error 上报：dsh-agent-loop 的 throwError() emit 后 throw，
  // kick() 的 catch 吞掉异常传播。不订阅则失败完全静默。
  // 工具结果卸载（spill）接线。它是优化、不是启动前置：根与受保护根/工作区根
  // 相交或上限为 0 时内部自行停用并告警，不阻断启动；钩子内失败只写 stderr，
  // 绝不改变工具调用的结果。
  const spillWiring = attachSpill(
    ctx as unknown as {
      on(name: string, fn: (exec: unknown, result: unknown, next: () => unknown) => unknown): () => void
    },
    {
      dataRoot: o.dataRoot,
      root: spillRoot,
      protectedRoots: authority.protectedRootPaths(),
      workspaceRoots: authority.workspaceRootPaths(),
      warn: (message: string) => console.warn(message),
    },
  )
  const detachErrorReporter = attachErrorReporter(ctx)
  if (ctx.get('loader') !== undefined) appReady.commit()
  return {
    ctx,
    ledger,
    authority,
    approvalBridge,
    /** 记忆库句柄（打不开时为 undefined；chat 的所有者记忆命令据此报不可用）。 */
    memory,
    /** Authority/Ledger 共用的 core.sqlite 路径——chat 的 forgetFlow 用它在同库记 K4 删除。 */
    dbPath,
    /** 本次实际注册的 prts_task_* / prts_memory_* 工具名（来自注册回执，不是手写常量）。 */
    toolNames: [...taskTools.names, ...(memoryTools?.names ?? []), ...(intentTools?.names ?? [])],
    /** 本会话最近一次模型创建的 draft；进程内易失提示，不是账本事实。 */
    draftTaskForSession: (sessionId: string) => taskTools.draftTaskForSession(sessionId),
    /** 后台巩固调度器（未启用时为 undefined）：诊断可读 stats()，测试可 runOnce()。 */
    memoryScheduler,
    sandboxBackend: backend,
    dispose: async () => {
      detachGuard()
      offPreExecute()
      offToolExecute()
      offToolResult?.()
      detachToolLoopAudit()
      offMemoryTurn?.()
      offMemoryAssistantStream?.()
      offMemoryTurnStop?.()
      offCostUsage?.()
      cost?.close()
      assembly?.dispose()
      memoryInjection?.dispose()
      sessionRecall?.dispose()
      proactiveRecall?.dispose()
      proactiveMentions?.close()
      taskReminder?.dispose()
      reminders?.close()
      memoryScheduler?.dispose()
      memoryTools?.dispose()
      skillTools?.dispose()
      subtaskTool.dispose()
      skillInjection?.dispose()
      skills?.close()
      emotionInjection?.dispose()
      emotion?.close()
      persona?.close()
      intentTools?.dispose()
      intentTrigger?.dispose()
      // 精排器是常驻 Python 子进程，必须显式收掉，否则退出后残留。
      reranker?.close()
      memory?.close()
      spillWiring.dispose()
      taskTools.dispose()
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
