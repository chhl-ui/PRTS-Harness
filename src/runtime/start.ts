/** 运行时组装：boot('prts', configPath, patches, prepare) + 最小 credentials 服务 + K2a 守卫接线。 */
import { mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { attachErrorReporter } from './error-report.ts'
import { createEmotionSignals } from './emotion-signals.ts'
import { AppContainerSandboxProvider, appContainerProfileName } from '../sandbox/provider.ts'
import { ensureWorkspaceWriteOwner, protectSubpathLocal, protectSubpathAppContainer } from '../sandbox/workspace-acl.ts'
import { deriveAppContainerSid } from '../sandbox/appcontainer.ts'
import { DEFAULT_READ_ONLY_SUBPATHS } from '../authority/index.ts'
import { createStepAllocator, createTaskTools, isLedgerTool } from './task-tools.ts'
import { createMemoryTools } from './memory-tools.ts'
import { createSessionTools } from './session-tools.ts'
import { registerWebSearch } from './web-search.ts'
import { createWebTools } from './web-tools.ts'
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
import { resolveTokenBudget, DEFAULT_OUTPUT_RESERVE, DEFAULT_SAFETY_MARGIN } from './token-budget.ts'
import { attachCompactionPolicy } from './compaction-policy-attach.ts'
import { resolveThresholdRatio } from './compaction-policy.ts'
import { ToolLoopGuard } from './tool-loop-guard.ts'
import { attachToolLoopAudit } from './tool-loop-audit.ts'
import { isSandboxDenial } from './tool-denial.ts'
import { attachMemoryScheduler, createOllamaProbe, type MemoryScheduler } from './memory-scheduler.ts'
import { attachWakeClock, parseSilentLimit, type WakeClock, type WakeReason } from './wake-clock.ts'
import { applyClockToolPolicy, clockPromptGuidance, clockToolPolicy, createClockToolState } from './clock-tools.ts'
import { createAbsenceSignal } from './emotion-absence.ts'
import { createMemoryRecallSignal, attachFailureMention } from './emotion-memory.ts'
import { Authority, classify } from '../authority/index.ts'
import { openProactiveStore, type ProactiveStore } from '../proactive/index.ts'
import { openReminderStore, type ReminderStore } from '../reminders/index.ts'
import { openCostStore, priceFromEnv, priceOf, type CostStore } from '../cost/index.ts'
import { Ledger } from '../ledger/index.ts'
import type { TaskId } from '../ledger/index.ts'
import { initCoreDb } from '../core/init.ts'
import { MemoryStore, OllamaEmbedder, OpenAiCompatibleEmbedder, OllamaGenerator, OpenAIGenerator } from '../memory/index.ts'
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

/**
 * config 里声明了、但模块解析不到的插件。
 *
 * 为什么需要：DSH 对「插件 resolve 失败」是**静默的**——写错一个包名，系统照常启动，
 * 只有依赖它的下游插件打一行 `pending`。功能安静地缺失，而配置里看不出来。
 * （2026-11-05 实测：`dsh-token-meter` 写成不存在的包名，启动零报错。）
 *
 * 默认只警告不阻断：`require.resolve` 对某些只导出 ESM 的包可能误报，
 * 「误报导致起不来」比「少一个功能」更糟。`PRTS_STRICT_PLUGINS=1` 才升级为失败。
 */
function unrunnablePlugins(configPath: string): string[] {
  let text: string
  try {
    text = readFileSync(resolve(configPath), 'utf8')
  } catch {
    return [] // 读不到就交给 boot 报错，不在这里抢先
  }
  const names = [...text.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
  const req = createRequire(pathToFileURL(resolve(configPath)))
  const missing: string[] = []
  for (const name of names) {
    try {
      req.resolve(name)
    } catch {
      missing.push(name)
    }
  }
  return missing
}

/**
 * /sandbox 档位解析：`sandboxPolicy` 服务按会话对象取当前档；
 * 服务或会话缺失、resolve 抛错都当无档（不收紧）——档位收紧是加固不是
 * 强制点，fail-open 与下方「审批链路出错放行」的取向一致。
 * `ctx.sandboxPolicy` 直连服务字段（cordis 声明式注入），`ctx.get` 兜底。
 */
function resolveSandboxMode(ctx: unknown, session: unknown): string | undefined {
  const c = ctx as {
    get?(name: string): unknown
    sandboxPolicy?: { resolve?(req: { session?: unknown }): { mode?: string } | undefined }
  }
  const svc = c.sandboxPolicy ?? (typeof c.get === 'function' ? c.get('sandboxPolicy') : undefined)
  try {
    return (svc as { resolve?(req: { session?: unknown }): { mode?: string } | undefined } | undefined)
      ?.resolve?.({ session })?.mode
  } catch {
    return undefined
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
  /** §G2 ① 时钟（`PRTS_CLOCK=off` 或记忆库不可用时为 undefined）。 */
  clock?: WakeClock
  /** 本次实际生效的 shell 沙箱后端（`PRTS_SANDBOX_BACKEND` 的解析结果）。 */
  sandboxBackend: 'local' | 'appcontainer'
  /**
   * 会话对象的沙箱档位（owner 只读查询用）。
   *
   * 复用内部的 `resolveSandboxMode`：解析失败、服务缺失、会话缺失一律返回
   * undefined，由调用方决定怎么表达「没有档位」——不在这里编一个默认值。
   */
  sandboxModeFor(session: unknown): string | undefined
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
  // 插件名写错时 DSH 是静默的（照常启动，只让下游 pending），这里提前说出来。
  const missingPlugins = unrunnablePlugins(o.configPath)
  if (missingPlugins.length > 0) {
    const detail = `prts: config 声明了 ${missingPlugins.length} 个无法解析的插件：\n  ${missingPlugins.join('\n  ')}`
    if (process.env.PRTS_STRICT_PLUGINS === '1') {
      throw new Error(`${detail}\n（PRTS_STRICT_PLUGINS=1，按配置错误处理）`)
    }
    console.warn(`${detail}\n（这些插件不会激活，对应功能将缺失；设 PRTS_STRICT_PLUGINS=1 可让启动直接失败）`)
  }
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
  // 进程被杀时留下的 `started` step 在这里收口。不调用的话它们永远悬着——
  // 「正在执行的步骤」与「进程已死的步骤」在账本里无法区分。
  // 2026-11-09 真实中断实测：杀掉在 `Start-Sleep 45` 里的进程，重启后 step 仍是 started。
  // 只做 started → unknown，**不改任务相位**：任务仍 active，等 owner 用 /task-bind 接回。
  try {
    const recovered = ledger.recoverOnStartup()
    if (recovered.length > 0) {
      console.error(
        `[prts] 启动恢复：${recovered.length} 个中断的步骤已标记 unknown`
        + '（任务仍 active，用 /task-bind <taskId> 接回本会话）',
      )
    }
  } catch (error) {
    // 恢复失败不能阻断启动：账本还能用，只是孤儿 step 留到下个进程。
    console.error(`[prts] 启动恢复失败：${error instanceof Error ? error.message : String(error)}`)
  }

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
      // /sandbox view（read-only）下 fs 写/删一律拒。shell 侧由 runner --mode
      // 落实同一档；fs 侧只能在这里拦——dsh-fs-local 不消费 sandboxPolicy
      // （本地后端没有 mode 概念），不拦的话 write/edit 只过 K2a 授权判定，
      // 「仅可查看」就名不副实（实测：切 view 后 write 照写不误）。
      if (capabilities.some((c) => c.startsWith('fs.write:') || c.startsWith('fs.delete:'))
        && resolveSandboxMode(ctx, exec.agent?.session) === 'read-only') {
        return 'prts: 会话处于仅可查看（read-only）档，fs 写/删不可用（/sandbox edit 恢复）'
      }
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
        .filter((c) => c.startsWith('fs.read:') || c.startsWith('fs.write:')
          || c.startsWith('fs.delete:') || c.startsWith('net:'))
      // net 必须一起进 E3：它的默认策略是 ask，而 ask 只有经这里发审批、
      // 由 approval/request 落成 once/grant 才可能变 allow。把 net 留在外面，
      // 同步守卫那侧就只剩「无 grant → deny」一条路——那不是审查，是无条件拒绝
      // （实测：prts_web_search 报 `no active grant for net:*`，且无任何通道能签发）。
      // exec/system/tool 仍不进：pwsh 命令体内的写删识别不了，整体拒绝会切掉现有
      // 能力（test/runtime/runtime.test.ts 的 R2 依赖 pwsh 可用）。
      if (capabilities.length === 0) return next()
      // 只读档下的写/删不问人：问了守卫照样拒，白制造一次审批。
      if (capabilities.some((c) => c.startsWith('fs.write:') || c.startsWith('fs.delete:'))
        && resolveSandboxMode(ctx, exec.agent?.session) === 'read-only') {
        return next()
      }
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
      // sandbox 模式拒绝也进审计链。`Authority.guard` 那条（authority.ts:366）只覆盖能力级拒绝，
      // 而 `/sandbox view` 的 read-only 由 DSH 的 fs 后端自己拒、不经过 guard——
      // 不补这一段，安全事件就只进对话、不进 K4（2026-11-09 实测：文件确实没写成功，
      // 但审计链上一条记录都没有，TODO 那条判据的「审计留痕」不成立）。
      try {
        if (isSandboxDenial(result)) {
          const deniedSessionId = exec.agent?.session?.id ?? ''
          authority.auditLog.append(
            { kind: 'model', sessionId: deniedSessionId },
            {
              kind: 'tool.denied',
              sessionId: deniedSessionId,
              tool: String(exec.name ?? ''),
              reason: 'sandbox-mode:read-only',
            },
          )
        }
      } catch { /* 审计失败不阻断工具结果 */ }
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
    // 摘要工具用的生成器：惰性构造，默认 Strata（OpenAI 兼容 /v1/chat/completions）。
    // 不在这里探活——启动时连不上本地模型不该阻断 boot；工具调用时失败会明确报错，
    // 模型看得到「摘要不可用」而不是拿到一个空成功。
    generator: async () => new OpenAIGenerator({
      ...(process.env.PRTS_SUMMARY_BASE === undefined ? {} : { baseUrl: process.env.PRTS_SUMMARY_BASE }),
      ...(process.env.PRTS_SUMMARY_MODEL === undefined ? {} : { model: process.env.PRTS_SUMMARY_MODEL }),
    }),
  })

  // Firecrawl 联网工具：key 存在才挂。工具跑在**本进程**（有网络），不走 pwsh 沙箱
  // ——那边 restricted-token 把 Authenticated Users 移掉了，DNS Client 管道进不去。
  // key 缺失时两个工具都不注册，模型看不到它们，而不是看到一个必然失败的壳。
  const firecrawlKey = (() => {
    try {
      return readFileSync(join(o.dataRoot, 'secrets', 'firecrawl.key'), 'utf8').trim()
    } catch {
      return ''
    }
  })()
  const webTools = firecrawlKey === '' ? undefined : createWebTools(tools, { apiKey: firecrawlKey })

  // server-side web_search：默认关闭，PRTS_WEB_SEARCH=1 才往请求里加 tools 字段。
  // 开了以后查询内容会发到 DeepSeek 后端，本地守卫看不到——这条只写在注释里，不弹横幅。
  const webSearchRegistry = ctx.get('deepseekLlmApiExtensions') as { register(field: string, provider: unknown): unknown } | undefined
  const webSearchOff = registerWebSearch(webSearchRegistry)

  // 会话自主管理工具（prts_session_archive）：模型只写 archive/requested 事件，
  // 真正的切换由 runChat 主循环在下一轮开头执行（它够得着 applySwitch）。
  const sessionTools = createSessionTools(tools, memory === undefined ? {} : { store: memory })

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

  // V1-09：模型侧全套七个动作（2026-11-09 放开，见 skills/store.ts 头注释）。
  // 放开的前提是技能不授予权限——注入的只是建议文本，真正拦得住模型的是 K2a 守卫；
  // 人工闸门退到 /skill（博士随时可撤）与哈希链（逐条可 verify）。
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
  // `candidate` 是还没被任何人采用的提案，注入它等于让模型执行未生效的经验。
  // 与记忆/提醒/开场重建各自独立注册，一条链挂了不牵连其余三条。
  // taskForSession（DESIGN-04）：提供时把绑定任务落进 offer 载荷，效果归因的连接键。
  const skillInjection = skills === undefined ? undefined : attachSkillInjection(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { store: skills, taskForSession: (sid) => ledger.taskForSession(sid) },
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

  // M→E「顾虑」（DESIGN-07）：提到收尾连败 ≥2 的项目 → 前瞻性沉重。
  // 注册在 memory-inject **之前**（外层）：waterfall 的 next() 后副作用逆注册序
  // 执行，外层后写——同轮想起 + 顾虑两写时顾虑覆盖想起（更具体者胜）。
  const failureMention = emotion === undefined || ledger === undefined ? undefined : attachFailureMention(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    { emotion, ledger },
  )

  // 压缩后回填（§5.3 ④ 的落地端）：上下文到压缩线时，允许记忆注入带回本会话
  // 自己的 turn。默认关闭——正常情况下它们已在上下文里，重复注入口径会变。
  // 由下面的 `compactionPolicy` 在决策为 `compact` 时置位（只升不降：压缩过的
  // 会话不会因为后续测量变小就又能看见早期内容了）。
  let compactPressure = false
  const memoryInjection = memory === undefined ? undefined : attachMemoryInjection(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    {
      store: memory, limit: injectLimit,
      budget: { maxTokens: injectBudgetTokens },
      includeOwnSession: () => compactPressure,
      ...(embedderResolver === undefined ? {} : { embedder: embedderResolver }),
      ...(reranker === undefined ? {} : { reranker }),
      // M→E「想起」（DESIGN-07）：注入成功 → 旧事实进上下文 → 轻微暖意。
      ...(emotion === undefined ? {} : { onHits: createMemoryRecallSignal({ emotion }) }),
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

  // 压缩决策观测（架构需求 §5.3 ④）：把 DSH 的静默跳过变成看得见的判断。
  //
  // **只观测，不动作**：`compaction-basic` 照旧跑，本层记下同一时刻 PRTS 的判断。
  // DSH 的 `compactIfNeeded` 在 `requestHeader` / `routedTarget` 为空时静默
  // `return null`（`dsh-compaction-basic/lib/index.js:932-935`）——两者一对，就能看出
  // 「该压却没压」。
  //
  // 窗口来自 `ctx.llm.resolveModelInfo`，但 deepseek adapter 的返回值取自
  // `config/prts.yml:20` 的 `defaultContextWindow`（`DSH_CONTEXT_WINDOW ?? 1000000`，
  // 见 `dsh-llm-deepseek/lib/index.js:527-535`）——**它和上面的注入预算用的是同一个
  // 配置值**，不是对模型能力的独立查询。默认 1000000 时阈值约 800K，实际会话永远触发
  // 不到：这既解释了「生产 57 个会话零压缩记录」，也说明 §5.3 第③条「未知窗口不按无限
  // 处理」在这一项上还没兑现。本层如实记录这个值，不替配置方假设真实窗口。
  //
  // 落点说明：这里只写 stderr，不写装配清单也不写审计链。两处语义都是为别的用途定的
  // （前者「材料装入」、后者「核心变更与拒绝」），硬塞会让读的人误解谁在说什么。
  // 可查询的压缩账本应与 §5.3 ⑧ 的上下文清单一起设计，不在这里临时造一张。
  // 阈值比例：0.8 是 **DSH 的默认**（`dsh-compaction-basic/lib/index.js:15`），
  // 不是 PRTS 决定的。架构需求 §5.3 第④条只说「超限时压缩」，没定义超限是多少——
  // 所以这里如实区分「配的」与「沿用的」，并在启动时打印一次：默认值冒充策略
  // 却没人察觉，正是 `docs/context-assembly-status.md` 记的那种缺失。
  // 非法配置传 NaN 下去，由 `decideCompaction` 判成 `config-invalid`（它才是判定方）。
  const compactionRatio = resolveThresholdRatio(process.env.PRTS_COMPACT_RATIO)
  console.error(
    `[prts] 压缩阈值 ${compactionRatio.ratio === undefined ? '（配置不成立）' : String(compactionRatio.ratio)}`
    + ` 来源 ${
      compactionRatio.source === 'config' ? 'PRTS_COMPACT_RATIO'
        : compactionRatio.source === 'dsh-default' ? 'DSH 默认（未做 PRTS 决定）' : '非法配置'
    }`,
  )
  const compactionPolicy = attachCompactionPolicy(
    ctx as unknown as {
      on(name: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
    },
    {
      config: {
        thresholdRatio: compactionRatio.ratio ?? Number.NaN,
        outputReserve: DEFAULT_OUTPUT_RESERVE,
        safetyMargin: DEFAULT_SAFETY_MARGIN,
        enabled: process.env.PRTS_COMPACT_POLICY !== 'off',
      },
      measure: (agent) => {
        try {
          const meter = (ctx as unknown as { get(n: string): unknown }).get('tokenMeter') as
            { measure?: (s: unknown) => { totalTokens?: number } } | undefined
          const m = meter?.measure?.((agent as { session?: unknown } | undefined)?.session)
          return typeof m?.totalTokens === 'number' ? m.totalTokens : undefined
        } catch { return undefined }
      },
      resolveWindow: async (agent) => {
        try {
          const header = (agent as { session?: { requestHeader?: () => unknown } } | undefined)
            ?.session?.requestHeader?.() as { config?: { provider?: unknown; model?: unknown } } | undefined
          const provider = header?.config?.provider
          const model = header?.config?.model
          if (typeof provider !== 'string' || typeof model !== 'string') return undefined
          const llm = (ctx as unknown as { get(n: string): unknown }).get('llm') as
            { resolveModelInfo?: (p: string, m: string) => Promise<{ context?: { contextWindow?: number } }> } | undefined
          const info = await llm?.resolveModelInfo?.(provider, model)
          const w = info?.context?.contextWindow
          return typeof w === 'number' && w > 0 ? w : undefined
        } catch { return undefined }
      },
      record: (row) => {
        // 决策为 `compact` = 上下文已过阈值 → 打开记忆注入的本会话通道。
        // 只升不降：压缩过的会话不会因为后续测量变小就又能看见早期内容。
        if (row.action === 'compact') compactPressure = true
        // 正常态不刷屏：`below-threshold` 每轮都会出现，`disabled` 是明确关掉。
        if (row.action === 'skip') return
        console.error(
          `[prts] 压缩决策 ${row.action}${row.reason === undefined ? '' : `/${row.reason}`}`
          + `${row.usedTokens === undefined ? '' : ` 已用 ${row.usedTokens}`}`
          + `${row.contextWindow === undefined ? '' : ` 窗口 ${row.contextWindow}`}`
          + `${row.sessionId === '' ? '' : ` 会话 ${row.sessionId}`}`,
        )
      },
    },
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
    // §G2 ② 第一处接线：写入时的情绪决定事实有多重。
    // 记忆库不 import 情感库（`emotion/store.ts:24` 的隔离约束），所以取值函数在这里接。
    // `get()` 返回的是**已按半衰期衰减**的当前状态——情绪本来就会淡，这正是要的语义。
    ...(emotion === undefined ? {} : { currentValence: () => emotion?.get()?.valence }),
  })

  // §G2 ① 时钟（方案 B：离屏自主）。`PRTS_CLOCK=off` 整体关闭。
  //
  // 为什么自己起会话而不是复用活跃会话：批准的是 B——「无人也能动」。复用活跃会话
  // 意味着客户端一断时钟就哑了，那正是要解决的问题（`chat-serve.ts:121-153` 的
  // accept 循环里，两次客户端之间有很长一段没有 agent 的窗口）。
  //
  // 会话身份：每次触发一个新 id。`agents.create` 对磁盘上已存在的 session 抛
  // `SessionAlreadyExistsError`（`chat-serve.ts:96-102` 记过这个坑），复用 id 会在
  // 第二次 tick 直接失败。代价是一天最多 `PRTS_CLOCK_DAILY_CAP` 个会话文件。
  //
  // 账本与费用：v1 不绑任务、不动 ledger——自主回合只说一句话，不产生工作项；
  // 费用走 dsh 自己的 usage 记录，不记进任何任务预算。改这个口径要先改计划。
  const clockStaleMs = envNum('PRTS_CLOCK_STALE_HOURS', 2) * 3_600_000
  const clockModel = process.env.PRTS_CLOCK_MODEL ?? 'deepseek-chat'
  /**
   * 自主会话的工具面（allow-list，见 `clock-tools.ts`）。
   *
   * `setup` 在 agent 发布前执行（`dsh-agent/lib/types/index.d.ts:105`），拿到的是
   * 这次会话的 scoped context，`get('tools')` 即 scoped tools 服务，可以
   * `restrict({ allow })`。fail-closed：拿不到限制入口就抛错——`deliver` 抛错
   * 会被调度器记成一次投递失败，宁可这次不说，也不能静默退回全量工具。
   *
   * **名单要与真实注册集合取交集**：`prts_skill_list` / recall / intent 这几组都是
   * 条件注册的（技能链断裂、记忆库打不开时那些工具根本不存在），而 `restrict`
   * 对未注册的工具名抛错。静态名单直接交给它，等于让一个模块的 fail-closed 降级
   * 把时钟打死：每次 tick 记一次投递失败，连续失败后时钟自停。这里把各工具工厂
   * 回报的 `names` 汇总成 `registered`，只有真注册了的名字才写进 allow。
   *
   * 与 K2a 的分工：`restrict` 管「这次会话看不见哪些工具」，`Authority.guard`
   * 管「看见了也未必能动得了手」。两层互补，别把任何一层当成另一层。
   */
  const clockRegisteredTools = new Set<string>([
    ...taskTools.names,
    ...(memoryTools?.names ?? []),
    ...sessionTools.names,
    ...(intentTools?.names ?? []),
    ...(skillTools?.names ?? []),
    // 联网工具也纳进汇总：白名单将来若加 `prts_web_*`，交集不会把它静默删掉
    // （`webTools` 只在 Firecrawl key 存在时创建；缺省时这些名字本来就不该进 allow）。
    ...(webTools?.names ?? []),
  ])
  const clockTools = clockToolPolicy(process.env, clockRegisteredTools)
  /** 降级状态：restrict 失败降成空集时，同一轮的提示词不再宣称工具可用。 */
  const clockToolState = createClockToolState()
  const clockSetup = clockTools === undefined
    ? undefined
    : (agentCtx: { get(name: string): unknown }): void => {
      applyClockToolPolicy(agentCtx.get('tools'), clockTools, clockToolState)
    }
  /**
   * 自主动机消息的正文。
   *
   * 工具面已经由上面的 `clockSetup` 在机制上收窄：名单外的工具对这次会话不可见，
   * 模型连调都调不到。正文由 `clockPromptGuidance` 用**同一份策略**生成——
   * 名单里没有的工具（技能链断了、记忆库没开）不写进提示词；回退模式
   * （`PRTS_CLOCK_TOOLS=off`）下工具面根本没收紧，也就不谎称「其他工具不可用」。
   * 提示词不能替代机制，也不该在机制缺席时假装在场。
   */
  const clockPrompt = (reason: WakeReason): string =>
    `[自主动机] 这不是博士在说话，是时钟到点了。\n${reason.text}\n`
    + clockPromptGuidance(clockTools, clockToolState)
    + '然后用一到两句话把这件事告诉博士，不要展开分析。'
  // 测试上下文默认关：`node --test` 会为每个测试文件起一个 `startRuntime`，而时钟的
  // 启动 kick 是 `setTimeout(0)`——立刻就会去 create 一个离屏 agent。那会让几十个
  // 既有测试凭空多出一条后台会话，且结果取决于临时库里有没有到期项，不可预测。
  // live 测试用 `PRTS_CLOCK=on` 显式打开（`NODE_TEST_CONTEXT` 的判据与
  // `sandbox/provider.ts:59` 同一套，不另造环境变量）。
  const clockDisabled = process.env.PRTS_CLOCK === 'off'
    || (process.env.PRTS_CLOCK !== 'on' && process.env.NODE_TEST_CONTEXT !== undefined)
  /**
   * 应答闸门阈值（DESIGN-09）：连续几次开口无人回应后，只保留到期的意图。
   * 解析规则见 `parseSilentLimit`——`0` 有意义（关掉闸门），不能用 `envNum`。
   */
  const clockSilentLimit = parseSilentLimit(process.env.PRTS_CLOCK_SILENT_LIMIT)
  const clock: WakeClock | undefined =
    (memory === undefined || clockDisabled) ? undefined : attachWakeClock({
      collectDue: (nowMs: number): WakeReason[] => {
        const due: WakeReason[] = []
        // 顺序即优先级：到期意图是唯一带「计划时刻」的事实，承诺过的先说。
        try {
          for (const r of memory.dueIntents(nowMs)) {
            due.push({
              kind: 'intent',
              refId: r.intentId,
              text: `你原定 ${new Date(r.fireAtMs).toISOString()} 提醒的事：${r.action}`,
            })
          }
        } catch (error) {
          console.error(`[prts] clock: dueIntents 读取失败：${error instanceof Error ? error.message : String(error)}`)
        }
        try {
          for (const task of ledger.list()) {
            if (task.phase !== 'blocked' && task.phase !== 'verifying') continue
            if (typeof task.updatedAt !== 'number' || !Number.isFinite(task.updatedAt)) continue
            if (nowMs - task.updatedAt < clockStaleMs) continue
            const elapsed = nowMs - task.updatedAt
            // 小于 1 小时用分钟。真机实测（2026-11-10 探针）模型会把正文原样念出来，
            // 而 `Math.round(0.36s / 3600000)` = 「已经 0 小时」——那种措辞会让她
            // 显得没在认真看时间。阈值调到 2h 的生产配置不会命中这一档，但配置可改。
            const age = elapsed < 3_600_000
              ? `${Math.max(1, Math.round(elapsed / 60_000))} 分钟`
              : `${Math.round(elapsed / 3_600_000)} 小时`
            const title = typeof task.title === 'string' && task.title !== '' ? task.title : task.id
            due.push({
              kind: 'stale-task',
              refId: task.id,
              text: task.phase === 'verifying'
                ? `任务「${title}」等你验收，已经 ${age}`
                : `任务「${title}」被阻塞，已经 ${age}`,
            })
          }
        } catch (error) {
          console.error(`[prts] clock: 任务列表读取失败：${error instanceof Error ? error.message : String(error)}`)
        }
        // 3) 惦记着的事：重要性高、且很久没被提起。
        //    这是唯一一条**不看时间截止**的理由——前两路读的是「到点了」，这里读的是
        //    「我惦记」。同一个定时器，读的东西不一样，说出来的话就不一样。
        //    一次只挑一条：把「惦记的事」列成清单念出来，又变回闹钟了。
        try {
          const idleDays = envNum('PRTS_CLOCK_FACT_IDLE_DAYS', 14)
          const minImportance = envNum('PRTS_CLOCK_FACT_MIN_IMPORTANCE', 0.6)
          const picked = memory.lonelyFacts({
            nowMs,
            minImportance,
            minIdleMs: idleDays * 86_400_000,
          })
          for (const f of picked) {
            // 提过就别再提：`proactive_mentions` 的冷却（默认 7 天）本来就是为
            // 「这条记忆刚说过」准备的，时钟复用它，而不是另造一套去重。
            if (proactiveMentions?.isCoolingDown(f.factId, nowMs) === true) continue
            due.push({ kind: 'fact', refId: f.factId, text: `你记着的一件事：${f.text}` })
            break
          }
        } catch (error) {
          console.error(`[prts] clock: 记忆检索失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return due
      },
      deliver: async (reason) => {
        const agents = ctx.get('agents') as {
          create(o: unknown): Promise<{
            agent: { followup(m: unknown): void | Promise<void>; whenIdle?(): Promise<void> }
            dispose(): Promise<void>
          }>
        } | undefined
        if (agents === undefined) throw new Error('wake-clock: agents service unavailable')
        const sessionId = `prts-clock-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
        const handle = await agents.create({
          sessionId,
          meta: { cwd: o.workspace },
          // 与 `/dispatch` 同一取法（chat-serve 的 dispatch 也是硬编码 provider）。
          // provider id 硬编码是既有事实（TODO.md §I），profile 化了要一起改。
          agentOptions: { provider: 'deepseek-official', model: clockModel },
          // 机制边界：这次会话只看见白名单里的工具（`clock-tools.ts`）。
          // `PRTS_CLOCK_TOOLS=off` 时 clockSetup 为 undefined，退回旧的全量工具面。
          ...(clockSetup === undefined ? {} : { setup: clockSetup }),
        } as never)
        try {
          await handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: clockPrompt(reason) }],
            source: { kind: 'user' },
          }))
          if (handle.agent.whenIdle !== undefined) await handle.agent.whenIdle()
        } finally {
          await handle.dispose()
        }
        return sessionId
      },
      onFired: (reason, nowMs, sessionId) => {
        if (reason.kind === 'intent') {
          try {
            memory.markFired({ actor: 'system', intentId: reason.refId, firedAtMs: nowMs, sessionId: sessionId ?? '' })
          } catch (error) {
            console.error(`[prts] clock: markFired 失败（${reason.refId}）：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (reason.kind === 'fact') {
          // 记一条「提过」的留痕，冷却期从这一刻算。记失败不撤投递——
          // 话说出去了，不能因为记账失败再让它重复一遍（与 intent 侧同一纪律）。
          try {
            proactiveMentions?.record({
              sessionId: sessionId ?? '',
              turn: 0,
              memoryId: reason.refId,
              kind: 'fact',
              score: 1,
              mentionedAtMs: nowMs,
            })
          } catch (error) {
            console.error(`[prts] clock: 记忆提起留痕失败（${reason.refId}）：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        try {
          authority.auditLog.append({ kind: 'system', component: 'clock' }, {
            kind: 'clock.fired',
            sessionId,
            reasonKind: reason.kind,
            refId: reason.refId,
            text: reason.text.slice(0, 200),
          })
        } catch (error) {
          console.error(`[prts] clock: 审计写入失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
      onStopped: (why, consecutive) => {
        try {
          authority.auditLog.append({ kind: 'system', component: 'clock' }, { kind: 'clock.stopped', consecutive, why })
        } catch (error) {
          console.error(`[prts] clock: 停止留痕失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
      // §G2 ④ 长时间未见 → 情感（DESIGN-06）：每次 tick 检查，不受说话闸门
      // 限制；只写情绪不说话。时钟 off / 记忆库缺 → 本边随宿主一起不工作。
      ...(emotion === undefined ? {} : {
        onTick: createAbsenceSignal({
          emotion,
          lastOwnerTurnAtMs: () => memory.lastOwnerTurnAtMs(),
          afterMs: envNum('PRTS_MISS_AFTER_HOURS', 24) * 3_600_000,
        }),
      }),
      intervalMs: envNum('PRTS_CLOCK_INTERVAL_MS', 60_000),
      minGapMs: envNum('PRTS_CLOCK_MIN_GAP_MS', 30 * 60_000),
      dailyCap: envNum('PRTS_CLOCK_DAILY_CAP', 8),
      // 应答闸门（DESIGN-09）：她会看自己说的话有没有被接住。取法与 absence
      // signal 同一口径——`lastOwnerTurnAtMs()` 已排除 prts-clock-* / subtask-*
      // 合成会话，否则系统自己说话就会把 streak 清零。
      lastOwnerTurnAtMs: () => memory.lastOwnerTurnAtMs(),
      silentLimit: clockSilentLimit,
    })
  clock?.start()

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
  // V1-05 情感事件源：轮次失败 → 受挫（10 分钟节流）；turn 正常收尾 → 顺利；
  // 博士验收/否定在 `chat.ts` 的 runAccept/runReject 里写（那是 owner 命令面）。
  // `emotion` 是可选的（打不开时只是没有情绪层），所以没有它就不接线。
  const emotionSignals = emotion === undefined ? undefined : createEmotionSignals({ store: emotion })
  const detachErrorReporter = attachErrorReporter(ctx, emotionSignals === undefined
    ? {}
    : { onReport: (entry) => emotionSignals.onError(entry) })
  // turn 正常收尾 → 轻微正向。DSH 语义：`agent/turn-stopping` 是 turn 即将关闭、
  // 模型不再欠回复；失败走 `agent/error`（emit，先到）。失败轮由 signals 内部记账后跳过，
  // 不让后到的「顺利」覆盖「受挫」。
  const turnStopBus = events as unknown as
    { on(name: string, fn: (payload: unknown) => void): () => void } | undefined
  const detachTurnStop = emotionSignals === undefined || turnStopBus === undefined
    ? undefined
    : turnStopBus.on('agent/turn-stopping', (payload) => {
      const p = payload as { turn?: unknown }
      emotionSignals.onTurnStopping({ turn: typeof p.turn === 'number' ? p.turn : -1 })
    })
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
    /**
     * 本次实际注册的工具名汇总（来自注册回执，不是手写常量）。
     *
     * 顺序无关，完整性有关：memory-commands.test.ts 用它对整个工具面做
     * 「不得出现删除/纠正语义」的断言——漏掉任何一个工具集，那条断言就会
     * 在漏掉的部分上静默变绿。新增工具集务必一起加进来。
     */
    toolNames: [
      ...taskTools.names,
      ...(memoryTools?.names ?? []),
      ...(intentTools?.names ?? []),
      ...sessionTools.names,
      ...(webTools?.names ?? []),
      ...(skillTools?.names ?? []),
    ],
    /** 本会话最近一次模型创建的 draft；进程内易失提示，不是账本事实。 */
    draftTaskForSession: (sessionId: string) => taskTools.draftTaskForSession(sessionId),
    /** 后台巩固调度器（未启用时为 undefined）：诊断可读 stats()，测试可 runOnce()。 */
    memoryScheduler,
    /** §G2 ① 时钟（未启用时为 undefined）：诊断读 stats()，测试可 tick()。 */
    clock,
    sandboxBackend: backend,
    sandboxModeFor: (session) => resolveSandboxMode(ctx, session),
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
      failureMention?.dispose()
      sessionRecall?.dispose()
      compactionPolicy?.dispose()
      proactiveRecall?.dispose()
      proactiveMentions?.close()
      taskReminder?.dispose()
      reminders?.close()
      memoryScheduler?.dispose()
      // 先停时钟再关库：tick 里要读 dueIntents / ledger.list，库关了还在跑会抛错。
      clock?.stop()
      memoryTools?.dispose()
      sessionTools.dispose()
      webTools?.dispose()
      await webSearchOff?.()
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
      detachTurnStop?.()
      await ctx.fiber.dispose()
    },
  }
}
