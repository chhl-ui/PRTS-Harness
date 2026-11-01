/**
 * 工具结果卸载的接线层：读配置、造存储、校验根隔离、挂 `tools/post-execute`。
 *
 * 这一层只做装配，判定逻辑在 `./policy.ts`，存储在 `./store.ts`。
 *
 * 两条硬约束：
 * 1. **卸载失败绝不改变工具调用的结果**——钩子里任何异常都吞掉并保留原 decision。
 * 2. **spill 根必须与受保护根、工作区根都不相交**——否则要么模型读不回来，
 *    要么模型能改写卸载内容。相交时只停用 spill 并告警，不阻断启动。
 */
import { dirname, join } from 'node:path'

import { isWithin, normalizePath, realpathBestEffort } from '../authority/paths.ts'
import { createSpillPolicy } from './policy.ts'
import { createLocalSpillStore } from './store.ts'

/** 环境变量名：单次内联 token 上限。 */
const ENV_MAX_INLINE = 'PRTS_SPILL_MAX_INLINE_TOKENS'
/** 环境变量名：存储根。 */
const ENV_ROOT = 'PRTS_SPILL_ROOT'
/** 环境变量名：单会话字节上限。 */
const ENV_SESSION_MAX_BYTES = 'PRTS_SPILL_SESSION_MAX_BYTES'
/** 环境变量名：单会话文件数上限。 */
const ENV_SESSION_MAX_FILES = 'PRTS_SPILL_SESSION_MAX_FILES'

/** 默认单次内联 token 上限。给初始值而非缺省关闭，否则行为零变化、无从回归。 */
const DEFAULT_MAX_INLINE = 8000
/** 默认单会话字节上限（64 MiB）。 */
const DEFAULT_SESSION_MAX_BYTES = 64 * 1024 * 1024
/** 默认单会话文件数上限。 */
const DEFAULT_SESSION_MAX_FILES = 200

/** 读一个非负整数环境变量，非法或缺失时回退默认值。 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

/**
 * 解析 spill 存储根：默认与 dataRoot 平级，**不嵌在 dataRoot 里面**。
 *
 * 嵌在 dataRoot 里会被 `protectedRoots` 覆盖，而 `fs.read` 对受保护根直接 deny，
 * 卸载的内容模型就永远读不回来——这是 v1 设计被议事会指出的硬伤。
 */
export function resolveSpillRoot(dataRoot: string): string {
  const configured = process.env[ENV_ROOT]
  return configured !== undefined && configured !== ''
    ? configured
    : join(dirname(dataRoot), 'prts-spill')
}

/** 相交检查的结果：`undefined` 表示可用。 */
export function spillRootProblem(
  spillRoots: readonly string[],
  protectedRoots: readonly string[],
  workspaceRoots: readonly string[],
): string | undefined {
  for (const spill of spillRoots) {
    const s = realpathBestEffort(spill)
    for (const p of protectedRoots) {
      if (isWithin(s, realpathBestEffort(p)) || isWithin(realpathBestEffort(p), s)) {
        return `spill 根 ${spill} 与受保护根 ${p} 相交（模型将无法回读卸载内容）`
      }
    }
    for (const w of workspaceRoots) {
      if (isWithin(s, realpathBestEffort(w)) || isWithin(realpathBestEffort(w), s)) {
        return `spill 根 ${spill} 与工作区根 ${w} 相交（模型将能改写卸载内容，且污染工作区）`
      }
    }
  }
  return undefined
}

/** 钩子所需的最小 ctx 形状：只要 `on`。 */
export interface HookContext {
  on(name: string, fn: (exec: unknown, result: unknown, next: () => unknown) => unknown): () => void
}

/** 接线参数。 */
export interface AttachSpillOptions {
  dataRoot: string
  /** 存储根；省略时按 {@link resolveSpillRoot} 从 dataRoot 推出。 */
  root?: string
  protectedRoots: readonly string[]
  workspaceRoots: readonly string[]
  warn: (message: string) => void
}

/** 接线结果。 */
export interface SpillAttachment {
  /** 实际使用的存储根。 */
  root: string
  /** 是否真的启用了（根相交或上限为 0 时会关闭）。 */
  enabled: boolean
  /** 卸下钩子。 */
  dispose(): void
}

/** content 块的最小形状：只关心 text 与 image 两类。 */
interface ContentLike { readonly type?: string; readonly text?: string }

/** 把 content 拼成一段文本；出现图片块时返回 `undefined`（图片不卸载）。 */
function joinText(content: readonly unknown[]): string | undefined {
  let text = ''
  for (const block of content) {
    const b = block as ContentLike
    if (b.type === 'image') return undefined
    if (b.type === 'text') text += b.text ?? ''
  }
  return text === '' ? undefined : text
}

/** 挂上 spill 钩子。返回的对象里 `dispose` 负责卸下。 */
export function attachSpill(ctx: HookContext, options: AttachSpillOptions): SpillAttachment {
  const root = normalizePath(options.root ?? resolveSpillRoot(options.dataRoot))
  const maxInlineTokens = envInt(ENV_MAX_INLINE, DEFAULT_MAX_INLINE)

  const problem = spillRootProblem([root], options.protectedRoots, options.workspaceRoots)
  if (problem !== undefined) {
    options.warn(`[prts] spill 已停用：${problem}`)
    return { root, enabled: false, dispose: () => { /* 未挂载 */ } }
  }
  if (maxInlineTokens === 0) {
    options.warn('[prts] spill 已停用：PRTS_SPILL_MAX_INLINE_TOKENS=0')
    return { root, enabled: false, dispose: () => { /* 未挂载 */ } }
  }

  const policy = createSpillPolicy({
    store: createLocalSpillStore({ root }),
    maxInlineTokens,
    sessionMaxBytes: envInt(ENV_SESSION_MAX_BYTES, DEFAULT_SESSION_MAX_BYTES),
    sessionMaxFiles: envInt(ENV_SESSION_MAX_FILES, DEFAULT_SESSION_MAX_FILES),
    warn: options.warn,
  })

  const off = ctx.on('tools/post-execute', async (execution: unknown, result: unknown, next: () => unknown) => {
    // 必须先调 next()：cordis 的 waterfall 里不调它会打断整条链。
    const decision = await next() as { kind?: string; content?: unknown; value?: unknown }
    try {
      if (decision.kind !== 'accept') return decision
      // 带 value 的 decision 是直通结果，不是面向模型的内容。
      if (Object.hasOwn(decision, 'value')) return decision

      const exec = execution as {
        readonly name?: unknown
        readonly callId?: unknown
        readonly agent?: { session?: { id?: string } }
      }
      const res = result as { readonly isError?: boolean; readonly content?: unknown }
      const content = decision.content ?? res.content
      if (!Array.isArray(content)) return decision

      const text = joinText(content)
      if (text === undefined) return decision

      const out = await policy.maybeSpill({
        sessionId: exec.agent?.session?.id ?? '',
        toolName: typeof exec.name === 'string' ? exec.name : '',
        callId: String(exec.callId ?? ''),
        isError: res.isError === true,
        text,
      })
      if (out === undefined) return decision
      return { kind: 'accept', content: [{ type: 'text', text: out.text }] }
    } catch (error) {
      options.warn(`[prts] spill 钩子失败，保留原结果：${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
  })

  return { root, enabled: true, dispose: off }
}
