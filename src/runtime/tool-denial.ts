/**
 * 「工具被 sandbox 模式拒绝」的识别。
 *
 * ## 为什么需要
 *
 * `Authority.guard` 拒绝会写 `tool.denied`（`authority.ts:366`），但 `/sandbox view`
 * 的 read-only 是 DSH 的 fs 后端自己拒的，**不经过 guard**。结果：2026-11-09 真机实测，
 * 模型尝试写文件被拒（文件确实没创建），但审计链上一条记录都没有——
 * `docs\TODO.md` 那条判据的后半句「审计留痕」不成立。
 *
 * ## 为什么用文本匹配而不是错误码
 *
 * 拒绝来自 DSH 内部（`dsh-tool-fs`），PRTS 拿不到结构化的拒绝原因，只有回给模型的
 * 错误正文。这条匹配规则必须钉住实际文案，改文案会让它失效——所以有测试。
 * 匹配失败不会漏掉强制（写入仍然被拒），只会漏掉审计这一条观测。
 */
export function isSandboxDenial(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const r = result as { isError?: unknown }
  if (r.isError !== true) return false
  const text = JSON.stringify(result)
  return text.includes('仅可查看（read-only）档') || text.includes('fs 写/删不可用')
}
