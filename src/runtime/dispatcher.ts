/**
 * Wave 3 分派器：Router 侧把任务分给 worker（一次性子会话），只回收摘要。
 *
 * 设计依据：`docs/design-superagent-fusion.md` §四「分派器（`create` worker，只回摘要）」。
 * 单任务派生完全复用 `spawnSubtask`——先注册后 create、失败释放、只回摘要、dispose，
 * 本层只加两件事：**并发上限**与**逐任务失败隔离**。不新建会话模型、不碰账本。
 *
 * 为什么要有并发上限：每次分派都是一次真实模型调用 + 一个进程内 agent。
 * 无上限时一次误用就能把预算与内存打满；上限是保守值（3，最多 5），
 * 需要更高并发时应先有真实负载数据再调，而不是把它当默认。
 *
 * 失败方向：单个 worker 失败只写进该任务的结果（`ok:false` + `error`），
 * 不中断同批其他任务；sessionId 仍带上，便于从磁盘日志排查。
 */
import { randomUUID } from 'node:crypto'
import { TASK_ID, spawnSubtask } from './subtask.ts'
import type { SpawnSubtaskDeps } from './subtask.ts'

export interface DispatchTaskInput {
  task: string
  /** 可选短标识；不传则自动生成。同批内必须唯一（会撞同一 sessionId）。 */
  taskId?: string
}

export interface PlannedDispatch {
  concurrency: number
  tasks: Array<{ task: string; taskId: string }>
}

export interface DispatchOptions {
  /** 同时存活的 worker 上限，默认 3，允许 1..5。 */
  concurrency?: number
}

export interface DispatchOutcome {
  taskId: string
  sessionId: string
  summary: string
  ok: boolean
  /** 仅 ok=false 时存在；来自 worker 创建/收敛/读取的原始错误文本。 */
  error?: string
}

const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 5

/**
 * 纯校验与规划：任务非空、taskId 白名单、同批去重、并发上限归一。
 * **不建目录、不碰 agents**——所有拒绝都发生在任何副作用之前。
 */
export function planDispatch(
  tasks: readonly DispatchTaskInput[],
  opts: DispatchOptions = {},
): PlannedDispatch {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('dispatch: 至少一个任务')
  }
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`dispatch: concurrency 必须是 1..${MAX_CONCURRENCY} 的整数`)
  }
  const seen = new Set<string>()
  const planned = tasks.map((t, i) => {
    const rawTask = (t as DispatchTaskInput | undefined)?.task
    if (typeof rawTask !== 'string' || rawTask.trim() === '') {
      throw new Error(`dispatch: 第 ${i + 1} 个任务必须是非空字符串`)
    }
    const taskId = (t as DispatchTaskInput).taskId ?? randomUUID().replace(/-/g, '').slice(0, 12)
    if (!TASK_ID.test(taskId)) {
      throw new Error(`dispatch: 非法 taskId ${JSON.stringify(taskId)}`)
    }
    if (seen.has(taskId)) throw new Error(`dispatch: taskId 重复：${taskId}`)
    seen.add(taskId)
    return { task: rawTask, taskId }
  })
  return { concurrency, tasks: planned }
}

/**
 * 并发分派。结果**按输入顺序**返回，与完成先后无关。
 * 单任务失败不抛出——失败信息在对应结果项里；只有「整批无法开始」（planDispatch 拒绝）
 * 才抛错。
 */
export async function dispatchTasks(
  deps: SpawnSubtaskDeps,
  tasks: readonly DispatchTaskInput[],
  opts: DispatchOptions = {},
): Promise<DispatchOutcome[]> {
  const plan = planDispatch(tasks, opts)
  const results: DispatchOutcome[] = new Array(plan.tasks.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      // JS 单线程：取下标与自增之间没有 await，不会两个 worker 抢到同一项。
      const i = next
      next += 1
      const t = plan.tasks[i]
      if (t === undefined) return
      results[i] = await runOne(deps, t)
    }
  }
  const width = Math.min(plan.concurrency, plan.tasks.length)
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

async function runOne(
  deps: SpawnSubtaskDeps,
  t: { task: string; taskId: string },
): Promise<DispatchOutcome> {
  try {
    const r = await spawnSubtask(deps, t.task, t.taskId)
    return { taskId: t.taskId, sessionId: r.sessionId, summary: r.summary, ok: true }
  } catch (error) {
    return {
      taskId: t.taskId,
      sessionId: `subtask-${t.taskId}`,
      summary: '',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
