/**
 * 客户端重连退避：与「客户端寿命与运行时寿命解耦」配套的纯函数。
 *
 * 第 n 次连续失败等待 min(1s × n, 5s)；连接成功后调用方把计数清零。
 * 单独成文件是为了可确定性验证——chat-client 是进程入口，import 即执行，
 * 不适合直接单测。
 */
export function reconnectDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return 0
  return Math.min(1000 * attempt, 5000)
}
