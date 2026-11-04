/**
 * 子任务派生的纯函数层（设计见 `docs/design-session-identity.md` §3.2）。
 *
 * 只做三件事——**不碰 agent、不碰数据库**：
 * 1. taskId 白名单（`^[A-Za-z0-9_-]{1,64}$`）——`..`、绝对路径、分隔符一律拒；
 * 2. 派生目录 `<workspace>/.prts-subtask/<taskId>`，并用 realpath 归一复验
 *    「必须在 `.prts-subtask/` 下且不越出 workspace」；
 * 3. 给出注册键 `sessionId = "subtask-" + taskId`（与 `agents.create({ sessionId })`
 *    入参同一个值——注册键与 agent 会话 id 的同一性由这里钉死）。
 *
 * 编排（create → followup → 等 idle → 取摘要 → dispose）不在这里，见后续条目。
 * 这样切分的理由：路径与身份是安全面，必须能被单独测；编排依赖 DSH agent API，
 * 混在一起会让安全断言被异步时序掩盖。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isWithin, realpathBestEffort } from '../authority/index.ts'

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
