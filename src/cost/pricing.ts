/**
 * 费用计价：token × 单价 → 美元。
 *
 * 单价单位是「每百万 token」，与 DeepSeek / OpenAI 等厂商的报价口径一致——
 * 直接抄价目表就能配，不需要再做换算。
 *
 * 未配置单价时返回 0：**只记 token，不编造金额**。宁可账面上是 0 但 token
 * 数真实可查，也不要写一个猜出来的数字让「费用」变成不可信的估算。
 */
import type { PriceTable } from './types.ts'

const PER_MILLION = 1_000_000

/** 有限正数原样返回，其余（负数 / NaN / Infinity / undefined）按 0。 */
function nonNegative(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * 一次调用的美元费用。四路 token 分别计价后求和再除百万——
 * 先除后乘会在小额 token 上引入累计误差。
 */
export function priceOf(usage: UsageLike, price: PriceTable): number {
  const totalTokensUsd = (
    nonNegative(usage.inputTokens) * nonNegative(price.inputPerM)
    + nonNegative(usage.outputTokens) * nonNegative(price.outputPerM)
    + nonNegative(usage.cacheReadTokens) * nonNegative(price.cacheReadPerM)
    + nonNegative(usage.cacheWriteTokens) * nonNegative(price.cacheWritePerM)
  )
  return totalTokensUsd / PER_MILLION
}

/** 从环境变量读单价表。非法值（空串 / NaN / 负数）一律回落 0。 */
export function priceFromEnv(env: Record<string, string | undefined> = process.env): PriceTable {
  const read = (name: string): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return 0
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return {
    inputPerM: read('PRTS_PRICE_INPUT_PER_M'),
    outputPerM: read('PRTS_PRICE_OUTPUT_PER_M'),
    cacheReadPerM: read('PRTS_PRICE_CACHE_READ_PER_M'),
    cacheWritePerM: read('PRTS_PRICE_CACHE_WRITE_PER_M'),
  }
}
