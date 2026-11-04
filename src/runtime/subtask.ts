/**
 * 子任务派生（设计见 `docs/design-session-identity.md` §3.2）。
 *
 * 分两层：
 * 1. **纯函数**（`planSubtask` / `ensureSubtaskDir`）——taskId 白名单、派生目录、
 *    realpath 越界复验。安全面，可独立测。
 * 2. **编排**（`spawnSubtask`）——先注册会话再 create、等收敛、取摘要、dispose 后释放。
 *    顺序写死：先注册后创建，消除「已创建但未注册」的窗口（那窗口里子会话会以主会话
 *    权限运行）。
 *
 * 不碰账本、不碰模型工具面；`prts_subtask` 工具由 `createSubtaskTool` 单独给出，
 * 派生闸（子会话不可再开）也在那里。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { isWithin, realpathBestEffort } from '../authority/index.ts'
import type { Authority } from '../authority/index.ts'
import { assistantAfterSeq, waitIdle } from '../cli/chat.ts'

export interface SubtaskPlan {
  /** 规范化后的 taskId（已过白名单）。 */
  taskId: string
  /** 注册键 = agent 会话 id。 */
  sessionId: string
  /** 子会话的工作目录（已 realpath 归一）。 */
  dir: string
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

const SUBTASK_BASE = '.prts-subtask'

/**
 * 计算子任务的会话 id、工作目录与注册键。**纯计算，不建目录**。
 *
 * 校验顺序刻意写死：先白名单（拦 `..` / 绝对路径 / 分隔符），再归一复验
 * （拦符号链接等白名单拦不住的形态）。两步都在写入或创建 agent 之前。
 */
export function planSubtask(workspace: string, rawTaskId: string): SubtaskPlan {
  if (typeof rawTaskId !== 'string' || !TASK_ID.test(rawTaskId)) {
    throw new Error(`subtask: invalid taskId ${JSON.stringify(rawTaskId)}`)
  }
  const root = realpathBestEffort(workspace)
  const base = join(root, SUBTASK_BASE)
  const dir = join(base, rawTaskId)
  const real = realpathBestEffort(dir)
  // 归一后必须在 base 下，且不越出 workspace 根——两道都查，防止 base 本身被替换成链接。
  if (!isWithin(real, base) || !isWithin(real, root)) {
    throw new Error(`subtask: derived dir escapes workspace: ${dir}`)
  }
  return { taskId: rawTaskId, sessionId: `subtask-${rawTaskId}`, dir: real }
}

/** 建派生目录（幂等）。只应在 `planSubtask` 通过后调用。 */
export function ensureSubtaskDir(plan: SubtaskPlan): void {
  mkdirSync(plan.dir, { recursive: true })
}

// ── 编排层 ─────────────────────────────────────────────────────────────

export interface SpawnSubtaskDeps {
  /** 只用到 `get('agents')`——与 chat.ts 同一取法。 */
  ctx: { get(name: string): unknown }
  authority: Authority
  workspace: string
  dataRoot: string
  parentSessionId: string
  provider: string
  model: string
  /** 等子会话收敛的上限，默认 120s（与 runChat 的 waitIdle 默认一致）。 */
  timeoutMs?: number
}

export interface SubtaskResult {
  sessionId: string
  summary: string
}

interface AgentLike {
  status: string
  followup(m: unknown): void
}

interface AgentHandleLike {
  agent: AgentLike
  dispose(): Promise<void>
}

/**
 * 派生子会话并拿回摘要。
 *
 * 失败方向全是 fail-closed：agents 服务缺失 / create 失败 / 超时不收敛——都会
 * 释放已注册的会话身份（不留下「幽灵子会话」），并把错误抛给调用方。
 */
export async function spawnSubtask(
  deps: SpawnSubtaskDeps,
  task: string,
  rawTaskId?: string,
): Promise<SubtaskResult> {
  if (typeof task !== 'string' || task.trim() === '') {
    throw new Error('subtask: task 必须是非空字符串')
  }
  const taskId = rawTaskId ?? randomUUID().replace(/-/g, '').slice(0, 12)
  const plan = planSubtask(deps.workspace, taskId)
  ensureSubtaskDir(plan)

  const agents = deps.ctx.get('agents') as { create(o: unknown): Promise<AgentHandleLike> } | undefined
  if (agents === undefined) throw new Error('subtask: agents service unavailable')

  // 先注册后创建：反过来会留一个「已创建但未注册」的窗口。
  deps.authority.registerSessionRoots(plan.sessionId, [plan.dir], deps.parentSessionId)
  let handle: AgentHandleLike
  try {
    handle = await agents.create({
      sessionId: plan.sessionId,
      meta: {
        cwd: plan.dir,
        origin: 'subagent',
        parentSession: deps.parentSessionId,
        delegationDepth: 1,
      },
      agentOptions: { provider: deps.provider, model: deps.model },
    })
  } catch (error) {
    deps.authority.releaseSession(plan.sessionId)
    throw error
  }

  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: task }],
      source: { kind: 'user' },
    }))
    const settled = await waitIdle(handle.agent, deps.timeoutMs ?? 120_000)
    if (!settled) throw new Error('subtask: 子会话未在时限内收敛')
    const { text } = assistantAfterSeq(deps.dataRoot, plan.sessionId, 0)
    return { sessionId: plan.sessionId, summary: text }
  } finally {
    try { await handle.dispose() } catch { /* dispose 失败不掩盖主错误 */ }
    deps.authority.releaseSession(plan.sessionId)
  }
}

// ── 模型工具面 ─────────────────────────────────────────────────────────

/** 只用到 register 一个方法（与 task-tools.ts 的 ToolRegistry 同构）。 */
export interface SubtaskToolRegistry {
  register(definition: unknown): () => void
}

export interface SubtaskTool {
  dispose(): void
}

/**
 * 工具面 deps：`parentSessionId` **不是固定入参**——每次 execute 从调用方会话取，
 * 否则一个工具实例只能服务一个父会话。
 */
export type SubtaskToolDeps = Omit<SpawnSubtaskDeps, 'parentSessionId'>

/**
 * 注册 `prts_subtask`。派生闸：
 * - 只有主会话可调（`authority.isSubagentSession` 为真 → 拒）——子会话不能再开子会话，
 *   深度上限因此恒为 1，不依赖 `delegationDepth`（框架没有上限逻辑）。
 * - taskId 由 `planSubtask` 白名单校验；不传则用随机 12 位。
 * - 取不到调用方 sessionId → 拒（fail-closed，不猜父会话）。
 */
export function createSubtaskTool(
  tools: SubtaskToolRegistry,
  deps: SubtaskToolDeps,
): SubtaskTool {
  const off = tools.register({
    name: 'prts_subtask',
    description:
      '把一件独立工作交给子会话执行，只拿回摘要。子会话有自己受限的工作目录（'
      + deps.workspace + ' 下的 .prts-subtask/），看不到主会话的对话上下文；'
      + '它跑完只回一段文本，不把中间过程带回来。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '交给子会话的任务，写清楚要产出什么' },
        taskId: { type: 'string', description: '可选短标识（字母数字下划线连字符，≤64）' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          summary: { type: 'string' },
        },
        required: ['sessionId', 'summary'],
      },
      render: (value: unknown): { type: 'text'; text: string }[] => {
        const v = value as { summary?: unknown }
        return [{ type: 'text', text: typeof v?.summary === 'string' ? v.summary : JSON.stringify(value) }]
      },
    },
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { task?: unknown; taskId?: unknown }
      if (typeof a.task !== 'string' || a.task.trim() === '') {
        throw new Error('prts: task 必须是非空字符串')
      }
      if (a.taskId !== undefined && typeof a.taskId !== 'string') {
        throw new Error('prts: taskId 必须是字符串')
      }
      const sessionId = (exec as { agent?: { session?: { id?: string } } })?.agent?.session?.id ?? ''
      if (sessionId === '') throw new Error('prts: 无法确定当前会话，拒绝派生')
      if (deps.authority.isSubagentSession(sessionId)) {
        throw new Error('prts: 子会话不能再开子会话（深度上限 1）')
      }
      return spawnSubtask({ ...deps, parentSessionId: sessionId }, a.task, a.taskId)
    },
  })
  return { dispose: off }
}
