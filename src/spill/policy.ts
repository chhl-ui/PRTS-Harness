/**
 * 工具结果卸载的判定与替换。
 *
 * 纯逻辑，不碰 cordis、不碰 DSH 类型：接线层（`src/runtime/start.ts`）负责
 * 从 `tools/post-execute` 的 content 块里抽出文本、并在拿到结果后重建 content。
 *
 * 分级过滤（顺序即语义，见 `docs/design-tool-output-spill.md` §4.3）：
 * 未启用 → 错误结果 → read 自身 → 会话 id 缺失 → 未超阈值 → 会话配额。
 *
 * 不变量：**任何失败都返回 `undefined`，由调用方保留原内联结果**。
 * 卸载是优化，不能把一次成功的工具调用变成失败。
 */
import { retainText } from './retention.ts'
import type { SpillStore } from './types.ts'

/** 判定所需的依赖。`store` 为 `undefined` 表示未启用。 */
export interface SpillPolicyDeps {
  store: SpillStore | undefined
  /** 单次结果允许内联的最大估算 token 数，超过才卸载。 */
  maxInlineTokens: number
  /** 单会话累计允许卸载的字节数上限。 */
  sessionMaxBytes: number
  /** 单会话累计允许卸载的文件数上限。 */
  sessionMaxFiles: number
  /** 告警出口；恒不抛错。 */
  warn: (message: string) => void
}

/** 一次判定输入。`text` 是已从 content 块拼好的全文。 */
export interface SpillPolicyInput {
  sessionId: string
  toolName: string
  callId: string
  isError: boolean
  text: string
}

/** 判定结果：有值时用 `text` 替换模型可见的结果。 */
export interface SpillPolicyResult {
  text: string
}

/** 判定器。持有会话级配额计数，所以是工厂而不是无状态函数。 */
export interface SpillPolicy {
  maybeSpill(input: SpillPolicyInput): Promise<SpillPolicyResult | undefined>
}

/** 省略标记，与 DSH 的 GAP 同义。 */
const GAP = '\n\n[...]\n\n'

/**
 * 粗略 token 估算：4 字符 ≈ 1 token。
 *
 * 不引 `@deepseek-ai/dsh-token-meter`：那是按 provider 计价的精确估算，用在
 * 「要不要卸载」这种量级判断上属于过度精确，而且会让这个纯逻辑模块依赖运行时装配。
 * 阈值本身可配，估算误差由阈值吸收。
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** 造一个判定器。 */
export function createSpillPolicy(deps: SpillPolicyDeps): SpillPolicy {
  /** 会话累计：已卸载字节与文件数。 */
  const used = new Map<string, { bytes: number; files: number }>()
  /** 空 sessionId 的告警只发一次，避免长会话刷屏。 */
  let warnedEmptySession = false

  const warn = (message: string): void => {
    try { deps.warn(`[prts] spill: ${message}`) } catch { /* 告警出口不许抛 */ }
  }

  return {
    async maybeSpill(input: SpillPolicyInput): Promise<SpillPolicyResult | undefined> {
      try {
        if (deps.store === undefined) return undefined
        // 错误结果不卸载：截断错误信息会丢掉诊断价值。
        if (input.isError) return undefined
        // read 自身不卸载：否则「读 spill 文件」的结果又被 spill，无限套娃。
        if (input.toolName === 'read') return undefined
        // 会话 id 缺失：不 invent 一个共享目录去落盘（PRTS 有 sessionId 空串历史）。
        if (input.sessionId === '') {
          if (!warnedEmptySession) {
            warnedEmptySession = true
            warn('sessionId 为空，本次不卸载工具结果')
          }
          return undefined
        }
        // 未超阈值：不需要卸载。
        if (estimateTokens(input.text) <= deps.maxInlineTokens) return undefined

        const stat = used.get(input.sessionId) ?? { bytes: 0, files: 0 }
        if (stat.files >= deps.sessionMaxFiles) {
          warn(`会话 ${input.sessionId} 已达卸载文件数上限 ${deps.sessionMaxFiles}，跳过`)
          return undefined
        }
        if (stat.bytes + Buffer.byteLength(input.text, 'utf8') > deps.sessionMaxBytes) {
          warn(`会话 ${input.sessionId} 已达卸载字节上限 ${deps.sessionMaxBytes}，跳过`)
          return undefined
        }

        const ref = await deps.store.saveText({
          sessionId: input.sessionId,
          toolName: input.toolName,
          callId: input.callId,
          suggestedName: `${input.toolName}.txt`,
          content: input.text,
        })

        const notice = `\n\n[完整结果已存至 ${ref.locator}，用 read 或 grep 查看]`
        const budgetChars = Math.max(0, (deps.maxInlineTokens - estimateTokens(notice)) * 4)
        const retained = retainText(input.text, budgetChars)

        // 预算扣掉提示后连一段正文都留不下：不替换，让调用方保留原结果。
        if (retained.head === '' && retained.tail === '') {
          warn('扣掉提示后的预算不足以保留任何正文，跳过替换')
          return undefined
        }

        used.set(input.sessionId, { bytes: stat.bytes + ref.bytes, files: stat.files + 1 })
        return { text: `${retained.head}${GAP}${retained.tail}${notice}` }
      } catch (error) {
        warn(`卸载失败，保留原结果：${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    },
  }
}
