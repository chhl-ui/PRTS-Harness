/**
 * 把「疑似循环」写进审计链。
 *
 * 判定在 `tool-loop-guard.ts`，这里只负责落账。分开的理由：guard 是纯计数，
 * 它不该知道审计、日志或停止权存在——那三者任何一个挂掉，判定都还应该成立。
 *
 * 为什么值得落链：日志会滚掉，而「误报率是多少」是决定要不要把它接进
 * `StopController` 的唯一依据（`docs/design-superagent-fusion.md` 三-①）。
 * 审计链是只追加、可校验的，正好用来攒这个样本。
 *
 * sink 用最小接口（只要求 `append`）而不是 `AuditLog`：测试不必起数据库，
 * 也避免把这个模块和 sqlite 生命周期绑在一起。
 */
import type { ToolLoopGuard } from './tool-loop-guard.ts'

/** 审计落点。真实实现是 `AuditLog.append(actor, event)`。 */
export interface AuditSink {
  append(actor: unknown, event: unknown): void
}

const ACTOR = { kind: 'system', component: 'tool-loop' }

/**
 * 订阅 guard 的疑似循环事件并转发给审计 sink。
 * 返回解除函数，幂等——重复调用不报错，且之后不再写。
 */
export function attachToolLoopAudit(guard: ToolLoopGuard, sink: AuditSink): () => void {
  const off = guard.subscribe((event) => {
    // 审计失败不得影响判定：guard 那边也会兜一层，这里再兜是因为
    // 「sink 抛错」比「listener 抛错」更常见（链断、磁盘满）。
    try {
      sink.append(ACTOR, event)
    } catch { /* 观测失败不阻断 */ }
  })
  let detached = false
  return () => {
    if (detached) return
    detached = true
    off()
  }
}
