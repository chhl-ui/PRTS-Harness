/**
 * 会话表（Wave 3 第一步）：把「进程内活会话」与「磁盘历史会话」合成一张表。
 *
 * 数据来源与边界（都已核实）：
 * - **live**：`AgentRegistry.list()` 只返回 live agents（`dsh-agent/lib/types/index.d.ts:353-357`
 *   注释「All live agents, in registration order」）；进程重启后它为空。
 * - **disk**：`<dataRoot>/dsh-home/sessions/<--cwd-->/<sessionId>/session.v4.jsonl`
 *   （`src/cli/chat.ts:56` 的根、`src/memory/session-purge.ts:66-67` 的目录约定）。
 *
 * 不读会话内容、不解析血缘——那属于装配层；这里只回答「有哪些会话、还在不在」。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface SessionEntry {
  sessionId: string
  /** 进程内有活 agent。 */
  live: boolean
  /** 磁盘上有 session.v4.jsonl。 */
  onDisk: boolean
  /** 磁盘会话文件的 mtime（live 且无盘为 null）。 */
  lastModifiedMs: number | null
}

export interface SessionTableDeps {
  /** 只用到 `list()`——`ctx.get('agents')` 的公开面。缺省表示没有 live 会话。 */
  agents?: { list(): Array<{ session?: { id?: string } }> }
  /** `<dataRoot>/dsh-home/sessions` 的绝对路径。 */
  sessionsRoot: string
}

const SESSION_FILE = 'session.v4.jsonl'

/**
 * 合并 live 与 disk。排序：最近修改的在前；同类按 sessionId 字典序（稳定，不依赖引擎排序）。
 *
 * 子会话（`subtask-*`）也会出现在这里——是否过滤由调用方决定（`/sessions` 默认全列，
 * 但会把子会话标注出来），本函数不做语义裁剪。
 */
export function listSessions(deps: SessionTableDeps): SessionEntry[] {
  const map = new Map<string, SessionEntry>()

  for (const agent of deps.agents?.list() ?? []) {
    const id = agent?.session?.id
    if (typeof id !== 'string' || id === '') continue
    map.set(id, { sessionId: id, live: true, onDisk: false, lastModifiedMs: null })
  }

  if (existsSync(deps.sessionsRoot)) {
    let workspaces: string[] = []
    try {
      workspaces = readdirSync(deps.sessionsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch { /* 目录不可读：只返回 live 部分 */ }
    for (const ws of workspaces) {
      const wsDir = join(deps.sessionsRoot, ws)
      let sessions: string[] = []
      try {
        sessions = readdirSync(wsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      } catch { continue }
      for (const sid of sessions) {
        let mtime: number
        try {
          mtime = statSync(join(wsDir, sid, SESSION_FILE)).mtimeMs
        } catch { continue } // 没有 session.v4.jsonl 的目录不是会话
        const existing = map.get(sid)
        if (existing === undefined) {
          map.set(sid, { sessionId: sid, live: false, onDisk: true, lastModifiedMs: mtime })
        } else {
          existing.onDisk = true
          existing.lastModifiedMs = mtime
        }
      }
    }
  }

  return [...map.values()].sort((a, b) => (
    (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0) || a.sessionId.localeCompare(b.sessionId)
  ))
}

/** `/sessions` 的一行文本：`<id>  <live|disk>  <子会话标记>  <最近修改>。 */
export function renderSessionLine(e: SessionEntry): string {
  const where = e.live ? (e.onDisk ? 'live+disk' : 'live') : 'disk'
  const sub = e.sessionId.startsWith('subtask-') ? '  [subagent]' : ''
  const when = e.lastModifiedMs === null ? '' : `  ${new Date(e.lastModifiedMs).toISOString()}`
  return `${e.sessionId}  ${where}${sub}${when}`
}
