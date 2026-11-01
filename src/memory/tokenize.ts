/**
 * 记忆模块：查询分词。
 *
 * **为什么需要它**：`LIKE` 只能做子串匹配，而评测里传进来的是**一整句问题**
 * （`"What lens do I prefer?"`）。整串去 `LIKE '%整句%'`，在对话片段里几乎
 * 不可能命中——2026-11-01 首次跑评测回路时 10/10 题零命中，就是这个问题。
 *
 * **为什么必须去停用词**：第一版加分词后零命中归零，但 24/24 题全部答
 * 「I don't know」——因为 `the` / `was` / `with` / `my` / `its` 这类词把大量
 * 无关片段召回到前面，真正的证据被挤出 top-K。实测教训，不是理论洁癖。
 *
 * 分词后任一词命中即召回，命中词数充当**相关度的代理**——`LIKE` 本身不产生
 * 相关度分，但「命中几个查询词」是可以算的（设计稿 §6.5 的已知退化，这里是
 * 在退化约束下能做到的最好形式）。
 *
 * 规则很粗，刻意如此：
 * - 英文/数字：连续 2 个以上字母数字，且不在停用词表里
 * - 中文：连续 2 个以上汉字（不引入分词库——`src/memory` 的第一版不引第三方依赖）
 */

/** 高频虚词。不滤掉它们，`LIKE OR` 会被噪音淹没。 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have',
  'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'me', 'my', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will',
  'with', 'would', 'you', 'your',
])

export function tokenize(s: string): string[] {
  const out = new Set<string>()
  for (const w of s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    if (!STOPWORDS.has(w)) out.add(w)
  }
  for (const c of s.match(/[\u4e00-\u9fff]{2,}/g) ?? []) out.add(c)
  return [...out]
}
