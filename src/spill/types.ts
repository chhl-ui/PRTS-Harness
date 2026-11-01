/**
 * 工具结果卸载（spill）：对外类型。
 *
 * 一次 spill 就是「把一段完整文本存到盘上，回一个模型能读的位置」。
 * 消费方只认 {@link SpillRef.retrievalHint}，不解析 {@link SpillRef.locator}。
 */

/** 一次卸载请求。 */
export interface SpillSaveInput {
  /** 归属会话；存储按它分目录。必填非空——调用方负责在为空时不调用。 */
  sessionId: string
  /** 产出这段结果的工具名，只作描述与命名用。 */
  toolName: string
  /** 本次工具调用的 callId，只作描述用。 */
  callId: string
  /** 建议的文件名。**只是提示**：存储层会把它编码成单一路径段，绝不当作路径。 */
  suggestedName: string
  /** 要持久化的完整文本（UTF-8）。 */
  content: string
}

/** 一次卸载的结果。 */
export interface SpillRef {
  /** 模型可读的位置。消费方不得解析其结构。 */
  locator: string
  /** 写入内容的 UTF-8 字节数。 */
  bytes: number
  /** 给模型的说明，含 locator 与建议的读取方式。 */
  retrievalHint: string
}

/** 卸载存储。真实实现见 `./store.ts`；测试可注入抛错的实现验证降级。 */
export interface SpillStore {
  /** 持久化 `content`，返回可回读的位置。存储失败必须抛错，由调用方降级。 */
  saveText(input: SpillSaveInput): Promise<SpillRef>
}
