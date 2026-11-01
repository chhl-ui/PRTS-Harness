/**
 * head-tail 切分：把一段超预算的文本压成「头部 + 尾部 + 省略字节数」。
 *
 * 纯函数，不依赖任何 @deepseek-ai/* 类型，便于单测与复用。
 * 切分单位是 UTF-16 code unit（JS 字符串下标），但绝不把代理对切两半。
 */

export interface RetainedText {
  /** 保留的头部文本。 */
  head: string
  /** 保留的尾部文本。 */
  tail: string
  /** 被省略部分的 UTF-8 字节数。 */
  omittedBytes: number
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/**
 * 按字符预算保留内容的首尾两段。
 *
 * - head 取 `ceil(budget / 2)` 个字符，tail 取 `floor(budget / 2)` 个字符。
 * - 切点落在 UTF-16 代理对中间时，head 少切 1 个字符、tail 多留 1 个字符。
 * - `omittedBytes` = 原文 UTF-8 字节数 − head 字节数 − tail 字节数。
 * - `budgetChars <= 0` 时 head 与 tail 都为空。
 * - 预算足以覆盖全文时，head 为全文、tail 为空、`omittedBytes` 为 0。
 */
export function retainText(content: string, budgetChars: number): RetainedText {
  const totalBytes = Buffer.byteLength(content, 'utf8')
  if (!(budgetChars > 0)) return { head: '', tail: '', omittedBytes: totalBytes }

  const budget = Math.floor(budgetChars)
  const length = content.length
  let headChars = Math.ceil(budget / 2)
  let tailChars = budget - headChars

  // 预算已覆盖全文：不做切分，避免 head 与 tail 重叠导致同一段内容出现两次。
  if (headChars + tailChars >= length) return { head: content, tail: '', omittedBytes: 0 }

  // head 的切点落在代理对中间（切点前是高代理、切点处是低代理）：head 少切 1，tail 多留 1。
  if (
    headChars > 0 &&
    headChars < length &&
    isHighSurrogate(content.charCodeAt(headChars - 1)) &&
    isLowSurrogate(content.charCodeAt(headChars))
  ) {
    headChars -= 1
    tailChars += 1
  }

  // tail 的起点同样不能落在代理对中间，否则 tail 会以孤立低代理开头。
  let tailStart = length - tailChars
  if (
    tailStart > 0 &&
    tailStart < length &&
    isHighSurrogate(content.charCodeAt(tailStart - 1)) &&
    isLowSurrogate(content.charCodeAt(tailStart))
  ) {
    tailChars += 1
    tailStart -= 1
  }

  // 上述调整可能让 head 与 tail 重新相接，此时直接返回全文。
  if (headChars + tailChars >= length) return { head: content, tail: '', omittedBytes: 0 }

  const head = content.slice(0, headChars)
  const tail = content.slice(length - tailChars)
  const omittedBytes = totalBytes - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8')

  return { head, tail, omittedBytes: omittedBytes > 0 ? omittedBytes : 0 }
}
