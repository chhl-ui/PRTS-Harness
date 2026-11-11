/**
 * 自主回合（时钟离屏会话）的工具面白名单。
 *
 * ## 为什么是机制，不是提示词
 *
 * 时钟到点时起的是一个**没人看着**的会话：博士不在场，没有人能在中途喊停。
 * 早先的边界只写在 `clockPrompt` 里（「不要调用任何工具」），那是请求模型自律；
 * 机制上它和用户会话拿到同一套全量工具。这一层把「能做什么」变成会话级事实：
 * 装配层在 `agents.create({ setup })` 里对 agent 的 scoped `tools` 服务调
 * `restrict({ allow })`，名单外的工具对这次会话**不可见**——模型即使被注入、
 * 或者自己判断失误，也调不到没人看着时不该调的工具。
 *
 * ## 为什么是 allow-list
 *
 * 新增工具默认**不**对自主会话开放（fail-closed）。deny-list 的对称错代价不同：
 * 名单漏了一个只读查询，最坏是她少一条信息、说的话泛一点；名单漏了一个写工具，
 * 最坏是她真的动了手。两种错的代价不对称，所以选会随新工具变严的那一种。
 *
 * ## 名单里有什么
 *
 * 五个只读查询：`prts_memory_recall`（记忆）、`prts_session_recall`（上次聊到哪）、
 * `prts_task_list`（任务）、`prts_intent_list`（待提醒）、`prts_skill_list`（技能）——
 * 让她能先查清再开口，而不是隔空猜。
 *
 * 唯一的写工具是 `prts_intent_create`：她可以给自己安排一条未来的提醒
 * （写 `mem_intents`，博士能 `/intent` 看到并取消）。写的是「未来的消息」，
 * 不是任务、不是文件、不是账本——这是自主回合被允许的最小副作用。
 *
 * ## 名单 ≠ 实际注册集合
 *
 * 这几个工具都是**条件注册**的：技能链断裂时 `prts_skill_list` 根本不存在
 * （`start.ts` 技能库那段 fail-closed 降级），记忆库打不开时 recall / intent
 * 一整组都不存在。`tools.restrict` 对未注册的工具名**抛错**，所以静态名单直接
 * 交给它会把「一个模块降级」放大成「时钟每次 tick 投递失败、连续失败后自停」——
 * 一个模块的病把另一个产品能力打死。因此策略接受 `registered`（本次进程真实注册
 * 的工具名），先与静态名单取交集；`applyClockToolPolicy` 再兜一层：收窄失败时
 * 退到空集（比预期更窄、绝不会更宽），而不是放行全量。
 *
 * ## 提示词跟着名单走
 *
 * `clockPromptGuidance` 用同一份策略生成提示词正文——名单里没有的工具，
 * 提示词就不提它。回退模式（`PRTS_CLOCK_TOOLS=off`，工具面没有收窄）下
 * **不**说「其他工具这次不可用」：边界由机制说话，提示词不撒谎。
 *
 * ## 回退
 *
 * `PRTS_CLOCK_TOOLS=off` 退回旧行为（不限制）。只认字面量 `off`：拼错、空串、
 * 其它值都保持默认收紧，避免一个笔误就静默放开整条规则。
 */

/**
 * 自主回合可见的工具（allow-list）。
 *
 * 改这个名单等于改「无人值守时她能做什么」——加一个写工具前先想清楚：
 * 夜里三点执行它、博士第二天才看见，后果能接受吗？
 *
 * 这里是**上限**：真正生效的名单还要与本次进程实际注册的工具取交集
 * （见文件头「名单 ≠ 实际注册集合」）。
 */
export const CLOCK_ALLOWED_TOOLS: readonly string[] = [
  'prts_memory_recall',
  'prts_session_recall',
  'prts_task_list',
  'prts_intent_list',
  'prts_skill_list',
  'prts_intent_create',
]

export interface ClockToolPolicy {
  /** 本次会话允许的工具名。数组是副本：调用方改了不会污染上面的常量。 */
  allow: string[]
}

/** 一次运行的降级状态：`applyClockToolPolicy` 写，`clockPromptGuidance` 读。 */
export interface ClockToolState {
  /** 上一次 `restrict` 是否失败并降到了空集。每次应用策略前重置。 */
  degraded: boolean
}

/** 每个 runtime 一个状态对象（不放模块级：那会跨 runtime / 跨测试串味）。 */
export function createClockToolState(): ClockToolState {
  return { degraded: false }
}

/**
 * 时钟会话的工具面策略。`undefined` = 不限制（旧行为，供排查与回退用）。
 *
 * env 参数是为了让调用方显式传进程 env（也让测试不必改 process.env）；
 * 默认取 `process.env`。
 *
 * `registered` 是本次进程真实注册的工具名（各工具工厂的 `names`）。给了就取交集：
 * 条件注册的工具缺席时不会被写进 `restrict({ allow })`——否则 `restrict` 抛错，
 * 一个模块的降级会把时钟打死。不给则返回静态名单（纯策略视角）。
 */
export function clockToolPolicy(
  env: NodeJS.ProcessEnv = process.env,
  registered?: Iterable<string>,
): ClockToolPolicy | undefined {
  if (env.PRTS_CLOCK_TOOLS === 'off') return undefined
  if (registered === undefined) return { allow: [...CLOCK_ALLOWED_TOOLS] }
  const known = registered instanceof Set ? (registered as Set<string>) : new Set(registered)
  return { allow: CLOCK_ALLOWED_TOOLS.filter((name) => known.has(name)) }
}

/** 只读查询在提示词里的说法。顺序即提示词里的列举顺序。 */
const CLOCK_TOOL_HINTS: Readonly<Record<string, string>> = {
  prts_memory_recall: '记忆里有没有相关的',
  prts_task_list: '任务进展',
  prts_intent_list: '还有哪些待提醒',
  prts_session_recall: '上次聊到哪里',
  prts_skill_list: '会哪些技能',
}

/**
 * 与工具面一致的提示词正文（不含「这不是博士在说话」前缀，也不含结尾的语气要求）。
 *
 * - 收紧模式：只提 `allow` 里真有的查询工具；`prts_intent_create` 在名单里才提；
 *   最后一句「其他工具这次不可用」是陈述机制事实（`restrict` 已经把它们藏起来了）。
 * - 回退模式（`undefined`）：工具面没有收窄，如实说明，不谎称工具不可用。
 */
export function clockPromptGuidance(policy: ClockToolPolicy | undefined, state?: ClockToolState): string {
  if (policy === undefined) {
    // 不写具体 env 名：这段正文会进入模型上下文，也可能被原样复述给博士——
    // 运维开关名不该出现在对话里（如实说明「回退」即可）。
    return '这次是回退模式（工具面没有收窄），但这次只是到点说一句话：'
      + '不要调用任何工具，也不要创建或修改任务。'
  }
  if (state?.degraded === true) {
    // 工具面已经被兜底降成空集：此时再说「你可以先查 X」就是撒谎，
    // 模型会白烧一次回合去调一个看不见的工具。
    return '这次没有可用的工具，直接说你要说的。'
  }
  const allow = new Set(policy.allow)
  const parts: string[] = []
  const readable = Object.keys(CLOCK_TOOL_HINTS).filter((name) => allow.has(name))
  if (readable.length === 0) {
    parts.push('这次没有可用的查询工具，直接说你要说的。')
  } else {
    parts.push(
      '你可以先查清再开口：'
      + readable.map((name) => `${name}（${CLOCK_TOOL_HINTS[name]}）`).join('、')
      + '。',
    )
  }
  if (allow.has('prts_intent_create')) {
    parts.push('如果这件事值得将来再提一次，用 prts_intent_create 记一条提醒。')
  }
  parts.push('其他工具这次不可用。')
  return parts.join('')
}

/** scoped context 上 `get('tools')` 的形状——只用到 `restrict` 这一个方法。 */
type ScopedTools = { restrict?: unknown }

/**
 * 把策略落到这次会话的 scoped tools 服务上。
 *
 * fail-closed 两级：
 * 1. 拿不到 `restrict`（服务缺席 / 形状不对 / 为 null）→ 抛错，
 *    由调度器记成一次投递失败；绝不静默退回全量工具面。
 * 2. `restrict` 自己抛错（名单与真实注册集合仍可能漂移：插件、后续注册）→
 *    在 stderr 留下痕迹后退到**空集**重试一次。空集是比预期更窄，不是更宽；
 *    时钟照常说话，只是这次什么工具都没有。
 */
export function applyClockToolPolicy(scoped: unknown, policy: ClockToolPolicy, state?: ClockToolState): void {
  // 每次应用前重置：上一次降级不该污染下一次（restrict 这次可能就好了）。
  if (state !== undefined) state.degraded = false
  const service = scoped as ScopedTools | null | undefined
  if (typeof service?.restrict !== 'function') {
    throw new Error('wake-clock: scoped tools service unavailable')
  }
  const restrict = (service.restrict as (filter: { allow: readonly string[] }) => unknown)
    .bind(service as ScopedTools)
  try {
    restrict({ allow: [...policy.allow] })
  } catch (error) {
    if (state !== undefined) state.degraded = true
    console.error(
      `[prts] clock: tools.restrict 失败，本次会话工具面降为空集：${error instanceof Error ? error.message : String(error)}`,
    )
    restrict({ allow: [] })
  }
}
