/**
 * 交叉编码器重排（reranker）接入层。
 *
 * 为什么需要：产品口径实测（`docs/memory-recall-criteria-retest-2026-11-03.md` 第九节）
 * —— 注入 5 条、候选池 15 条时 @5 只有 28.8%，交叉编码器重排后到 38.1%
 * （+22 题，McNemar p=0.0000）。候选池内召回 41.9% 是硬上限，rerank 只重排不新增，
 * 它改善的是「答案在池里、但排不进注入名额」那一段。
 *
 * 三个模型的同口径结果（236 题）：ms-marco-MiniLM-L-6-v2（22M）44.5% @8 / 0.24 s/题
 * 优于 bge-reranker-v2-m3（568M）43.6% / 5.74 s/题 与 bge-reranker-base（278M）42.8%。
 * 默认模型取前者——**任务匹配度比参数量重要**。
 *
 * 设计纪律：
 * - **fail-open**：未配置、启动失败、超时、进程崩溃，一律回落原始顺序，注入照常发生。
 *   记忆可以少几条精排，不能因为精排器挂了就不注入。
 * - **纯函数可测**：重排抽成 `applyRerank`，与进程协议分开测。
 * - **不引入 Node 依赖**：sentence-transformers 只在 Python 生态里，走子进程 NDJSON over stdio，
 *   不监听端口、不改 Node 依赖树。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'

/** 精排器接口。实现方只需给分数，排序由 `applyRerank` 负责。 */
export interface Reranker {
  /** 返回与 `docs` 等长的分数数组（越大越相关）。失败时抛错，由调用方降级。 */
  score(query: string, docs: readonly string[]): Promise<number[]>
  close(): void
}

/**
 * 按分数降序重排命中。
 *
 * `scores` 长度与 `hits` 不符时**原样返回**——重排是增强，任何形状异常都退回原顺序，
 * 绝不错排（错排会让注入内容与查询无关，比不排更糟）。
 * 同分保持原相对顺序（稳定），避免等分项在每个请求里抖动。
 */
export function applyRerank<T extends { id: string }>(hits: readonly T[], scores: readonly number[]): T[] {
  if (hits.length === 0) return []
  if (scores.length !== hits.length) return [...hits]
  const order = hits.map((_, i) => i)
  order.sort((a, b) => (scores[b] - scores[a]) || (a - b))
  return order.map((i) => hits[i])
}

export interface PythonRerankerOptions {
  /** rerank 服务脚本路径（`scripts/rerank-server.py`）。 */
  script: string
  /** Python 可执行文件，默认 `python`。 */
  python?: string
  /** 单次打分超时，默认 10 s。 */
  timeoutMs?: number
  /** CrossEncoder 的 max_length，默认 512（与探针一致）。 */
  maxLength?: number
  /** 传给服务脚本的模型名，默认 ms-marco-MiniLM-L-6-v2。 */
  model?: string
}

interface Pending {
  resolve: (scores: number[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 常驻 Python 子进程实现的精排器。
 *
 * 进程懒启动：只有第一次 `score` 才 spawn——没开 rerank 的部署不该背一个常驻 Python。
 * 启动/崩溃后不自动重启：连续崩溃通常是模型文件或解释器坏了，重试只会拖慢每次注入；
 * 标记为不可用、让调用方降级，并把 stderr 尾部留作诊断。
 */
export class PythonReranker implements Reranker {
  private readonly script: string
  private readonly python: string
  private readonly timeoutMs: number
  private readonly maxLength: number
  private readonly model: string
  private proc: ChildProcessWithoutNullStreams | undefined
  private reader: Interface | undefined
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false
  /** 已失败过：不再尝试重启，直接抛错让调用方降级。 */
  private broken: string | undefined
  private stderrTail = ''

  constructor(opts: PythonRerankerOptions) {
    this.script = opts.script
    this.python = opts.python ?? 'python'
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.maxLength = opts.maxLength ?? 512
    this.model = opts.model ?? 'cross-encoder/ms-marco-MiniLM-L-6-v2'
  }

  async score(query: string, docs: readonly string[]): Promise<number[]> {
    if (this.closed) throw new Error('reranker 已关闭')
    if (this.broken !== undefined) throw new Error(`reranker 不可用：${this.broken}`)
    if (docs.length === 0) return []
    const proc = this.ensure()
    const id = ++this.seq
    const line = JSON.stringify({ id, query, docs })
    return await new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rerank 超时（${this.timeoutMs} ms）`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      proc.stdin.write(line + '\n', (err) => {
        if (err === null || err === undefined) return
        const entry = this.pending.get(id)
        if (entry === undefined) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(new Error(`rerank 写入失败：${err.message}`))
      })
    })
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('reranker 已关闭'))
    try { this.reader?.close() } catch { /* 已关闭 */ }
    this.reader = undefined
    if (this.proc !== undefined) {
      const proc = this.proc
      this.proc = undefined
      try { proc.stdin.end() } catch { /* 已断开 */ }
      try { proc.kill() } catch { /* 已退出 */ }
    }
  }

  /** 诊断用：子进程 stderr 的最后一段（模型加载失败等信息都在这里）。 */
  stderrTailText(): string {
    return this.stderrTail
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc !== undefined && this.proc.exitCode === null && !this.proc.killed) return this.proc
    const proc = spawn(
      this.python,
      [this.script, '--model', this.model, '--max-length', String(this.maxLength)],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk: string) => {
      // 只留尾部：模型加载失败、缺包等线索在这里，别让日志无限增长。
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })
    proc.on('error', (error: Error) => {
      this.broken = error.message
      this.failAll(new Error(`reranker 启动失败：${error.message}`))
    })
    proc.on('exit', (code) => {
      if (this.closed) return
      this.broken = `进程退出（code ${String(code)}）${this.stderrTail ? `：${this.stderrTail.slice(-300)}` : ''}`
      this.failAll(new Error(`reranker 进程退出（code ${String(code)}）`))
    })
    const reader = createInterface({ input: proc.stdout })
    reader.on('line', (raw: string) => {
      const text = raw.trim()
      if (text === '') return
      let msg: { id?: number; scores?: number[]; error?: string }
      try {
        msg = JSON.parse(text) as typeof msg
      } catch {
        return // 非协议输出（进度条等）直接忽略
      }
      if (typeof msg.id !== 'number') return
      const entry = this.pending.get(msg.id)
      if (entry === undefined) return
      this.pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (typeof msg.error === 'string') entry.reject(new Error(`rerank 服务报错：${msg.error}`))
      else entry.resolve(Array.isArray(msg.scores) ? msg.scores : [])
    })
    this.proc = proc
    this.reader = reader
    return proc
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}
