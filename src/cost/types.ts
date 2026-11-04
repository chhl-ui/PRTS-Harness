/**
 * V1-16 费用计量的类型。
 *
 * 原文（架构需求 §7 V1-16）：「7 天试用的**模型费用与巩固费用分开计量**，
 * 不超过预先冻结的额度」。
 *
 * 拆成两个账户（`model` / `consolidation`）是这一条的核心：
 * 对话模型走 API（有单价），巩固走本地 Ollama（有算力成本但没有 API 账单）。
 * 分开记账才可能在「成本结构变化」时看出是哪一边涨的。
 */

/** 两个费用账户。字符串而非枚举：将来加「嵌入」等账户时不必改窄类型。 */
export type CostKind = 'model' | 'consolidation'

/** 一行费用留痕（只追加）。 */
export interface CostEntry {
  id: number
  kind: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 按当时单价折算的美元金额。 */
  usd: number
  recordedAtMs: number
}

/**
 * 单价表：每**百万** token 的美元价。
 *
 * 用 env 配置而不是硬编码：DeepSeek 的价目会变，写死会让所有历史账目失真。
 * 未配置时全 0——只记 token，不编造金额。
 */
export interface PriceTable {
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheWritePerM: number
}

/** 一个账户的累计。 */
export interface CostBucket {
  inputTokens: number
  outputTokens: number
  usd: number
}

/** 汇总。`capUsd` 只在调用方给了冻结额度时出现（未给 = 不判定超限）。 */
export interface CostSummary {
  model: CostBucket
  consolidation: CostBucket
  /** 两类合计，用于冻结额度判定。 */
  totalUsd: number
  /** 冻结额度（美元）。未设时不出现。 */
  capUsd?: number
  /** 是否已超冻结额度。未设 cap 时恒为 false。 */
  exceeded: boolean
}

/** 记一笔费用的入参。 */
export interface CostRecordInput {
  kind: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  usd: number
  /** 缺省为 `Date.now()`。 */
  recordedAtMs?: number
}

/** 汇总的过滤条件。 */
export interface CostSummaryQuery {
  /** 只统计 `recorded_at_ms >= sinceMs` 的行（试用期起点）。 */
  sinceMs?: number
  /** 冻结额度（美元）；0 是合法值（一分钱都不许花）。 */
  capUsd?: number
}

/**
 * 费用留痕库。
 *
 * 纯同步接口：`node:sqlite` 是同步 API，调用点在 `agent/assistant-stream`
 * 的 usage chunk 里（每轮一次），异步化只会把「记一条账」变成可重入的竞态面。
 */
export interface CostStore {
  /** 记一笔。负数 / NaN 一律按 0 写入——不拒绝，也不让坏数据污染累计。 */
  record(input: CostRecordInput): void
  /** 按 kind 分组累计；未知 kind 保留在库里但不进两个账户。 */
  summary(opts?: CostSummaryQuery): CostSummary
  /** 关闭库句柄。可重复调用。 */
  close(): void
}
