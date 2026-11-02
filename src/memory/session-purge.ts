/**
 * P0-2b：DSH 会话日志的所有者删除。
 *
 * 为什么单独成模块而不并进 forget-flow：记忆库删除清的是 mem_* 投影，
 * 但 DSH 的 `session.v4.jsonl` 保存着完整对话原文（含历次注入）——
 * 删掉记忆条目后原文仍在日志里，续会话还会回到模型上下文。
 * forgetFlow 只如实上报残留（K4 `session-log` derivative 挂未完成），
 * 清掉它是本模块的职责。
 *
 * ## 「未在使用」的可靠判定
 *
 * DSH 的写租约（`dsh-session-persistence-jsonl`）在 Windows 上是命名内核
 * 信号量：`Local\dsh-session-lock-<sha256(小写 resolve(<dir>/session.lock))>`，
 * 计数 1；持有方存活期间第二获取者的零超时 wait 必得 WAIT_TIMEOUT。
 * 内核对象随最后一个句柄关闭销毁——进程死了锁自动释放，无过期语义。
 * POSIX 对应物是 `session.lock` 文件上的非阻塞 `flock(LOCK_EX|LOCK_NB)`。
 *
 * 判定 = 我们自己按同一协议尝试获取：
 * - 拿到 → 会话无写者；**持有期间任何新写者都会被 SessionAlreadyOwnedError
 *   挡住**，拿锁-删除-放锁因此是无竞态的。
 * - 拿不到 → 会话在用（含当前 chat 自己——当前会话天然被拒，不需要特判）。
 *
 * 上游把实现藏在包内部（SessionWriteLease 未导出），这里按公开协议重实现。
 * 一致性靠端到端测试钉住：「活动会话必须 busy」一旦失效说明上游改了锁方案，
 * 测试变红——而不是悄悄退化成分叉的假锁。
 *
 * ## 删除粒度
 *
 * 整个会话目录（`session.v4.jsonl` + 附属文件）一起删。逐行外科手术改写
 * JSONL 会破坏 append-only 事件图（seq / sourceEventSeqs 关系），DSH 续会话
 * 读到的是损坏的历史。代价是整段会话记录消失——所以走独立命令与显式确认，
 * 不并入 /forget 的自动级联。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { AuditLog } from '../audit/audit.ts'

// koffi 没有自带类型声明；与 appcontainer.ts 同一约定，只在模块内使用。
const require = createRequire(import.meta.url)
const koffi = require('koffi') as {
  load(lib: string): {
    func(name: string, ret: string, args: string[]): (...a: unknown[]) => number
    func(convention: string, name: string, ret: string, args: string[]): (...a: unknown[]) => number
  }
  sizeof?(t: unknown): number
}

export interface SessionProbe {
  sessionId: string
  dir: string
  exists: boolean
  /** session.v4.jsonl 的字节数；0 = 不存在或不可读。 */
  jsonlBytes: number
  /** 探测时的占用态——拿锁试出来的；purge 时会重新取锁（那才是裁决）。 */
  state: 'free' | 'busy' | 'missing' | 'unsupported'
}

/** 会话 id 只允许目录名安全字符——拒绝分隔符与 '..'，否则 join 会落到会话树外，
 * 而下游接的是整目录删除。 */
export function isSessionIdSafe(sessionId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(sessionId) && sessionId !== '.' && sessionId !== '..'
}

/** `sessions/<--cwd-->/<sessionId>/` 定位：同一 id 可跨多个 workspace 前缀出现，全部列出。 */
export function findSessionDirs(sessionsRoot: string, sessionId: string): string[] {
  if (!isSessionIdSafe(sessionId)) return []
  if (!existsSync(sessionsRoot)) return []
  const out: string[] = []
  for (const ws of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const candidate = join(sessionsRoot, ws.name, sessionId)
    try {
      if (statSync(candidate).isDirectory()) out.push(candidate)
    } catch { /* 不存在或不可读 */ }
  }
  return out.sort()
}

interface HeldLock { release(): void }

function sessionLockName(dir: string): string {
  const p = resolve(join(dir, 'session.lock')).toLowerCase()
  return `Local\\dsh-session-lock-${createHash('sha256').update(p).digest('hex')}`
}

const WIN32 = process.platform === 'win32'
let _api: {
  createSemaphoreW(...a: unknown[]): number
  waitForSingleObject(...a: unknown[]): number
  releaseSemaphore(...a: unknown[]): number
  closeHandle(...a: unknown[]): number
  getLastError?(...a: unknown[]): number
} | null = null

function win32Api() {
  if (_api === null) {
    const kernel32 = koffi.load('kernel32.dll')
    _api = {
      createSemaphoreW: kernel32.func('__stdcall', 'CreateSemaphoreW', 'intptr', ['void*', 'int', 'int', 'str16']),
      waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['intptr', 'uint']),
      releaseSemaphore: kernel32.func('__stdcall', 'ReleaseSemaphore', 'int', ['intptr', 'int', 'void*']),
      closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']),
      getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []),
    }
  }
  return _api
}

/**
 * 按 DSH 协议获取会话写锁。返回 'busy' 表示在用；'unsupported' 平台不支持；
 * 否则返回 HeldLock，调用方用完必须 release()。
 * 导出而不是模块私有：probe 用它、测试也要靠它模拟「活动写者」。
 */
export function acquireSessionLock(dir: string): HeldLock | 'busy' | 'unsupported' {
  if (!WIN32) return 'unsupported'
  const api = win32Api()
  const handle = api.createSemaphoreW(null, 1, 1, sessionLockName(dir))
  if (handle === 0) throw new Error(`CreateSemaphoreW 失败 (Win32 ${api.getLastError?.()})`)
  const w = api.waitForSingleObject(handle, 0)
  if (w === 0) {
    return {
      release() {
        api.releaseSemaphore(handle, 1, null)
        api.closeHandle(handle)
      },
    }
  }
  api.closeHandle(handle)
  if (w === 0x102 /* WAIT_TIMEOUT */) return 'busy'
  throw new Error(`WaitForSingleObject 异常返回 ${w}`)
}

/** 探测一组会话：路径、体量、占用态。探测本身也要拿锁试（随即放掉）。 */
export function probeSessions(sessionsRoot: string, sessionIds: string[]): SessionProbe[] {
  const out: SessionProbe[] = []
  for (const id of sessionIds) {
    const dirs = findSessionDirs(sessionsRoot, id)
    if (dirs.length === 0) {
      out.push({ sessionId: id, dir: '', exists: false, jsonlBytes: 0, state: 'missing' })
      continue
    }
    for (const dir of dirs) {
      let jsonlBytes = 0
      try { jsonlBytes = statSync(join(dir, 'session.v4.jsonl')).size } catch { /* 无 jsonl */ }
      let state: SessionProbe['state'] = 'busy' // 拿锁抛错按 busy 报——探测绝不能假报 free
      try {
        const lock = acquireSessionLock(dir)
        state = lock === 'busy' ? 'busy' : lock === 'unsupported' ? 'unsupported' : 'free'
        if (typeof lock !== 'string') lock.release()
      } catch { /* 保守：异常 → busy */ }
      out.push({ sessionId: id, dir, exists: true, jsonlBytes, state })
    }
  }
  return out
}

export interface SessionPurgeResult {
  ok: boolean
  purged: string[]
  busy: string[]
  missing: string[]
  unsupported: string[]
  /** purge 后被标记完成的 K4 deletionId（最后一个 derivative 完成触发）。 */
  k4Completed: string[]
  /** 追加的 deletion.derivative-done 事件数。 */
  k4Marked: number
  message: string
}

/**
 * 删除整组会话目录并为命中的 K4 删除记录补 derivative-done。
 * 持锁期间改名到垃圾桶名再 rm——先改名保证即使 rm 中途失败，
 * 原路径上也不再有可读日志；新写者即使抢到锁也只看到空目录。
 */
export function purgeSessions(opts: {
  sessionsRoot: string
  sessionIds: string[]
  audit?: AuditLog
}): SessionPurgeResult {
  const { sessionsRoot, sessionIds, audit } = opts
  const purged: string[] = []
  const busy: string[] = []
  const missing: string[] = []
  const unsupported: string[] = []
  const purgedIds = new Set<string>()

  for (const id of sessionIds) {
    const dirs = findSessionDirs(sessionsRoot, id)
    if (dirs.length === 0) { missing.push(id); continue }
    let allOk = true
    for (const dir of dirs) {
      let lock: HeldLock | 'busy' | 'unsupported'
      try {
        lock = acquireSessionLock(dir)
      } catch (e) {
        // 锁协议本身异常：保守——保留目录、报告失败、继续下一个会话，不中止整批。
        allOk = false
        busy.push(`${id}(锁检查失败:${e instanceof Error ? e.message : String(e)})`)
        break
      }
      if (lock === 'busy') { allOk = false; busy.push(`${id}`); break }
      if (lock === 'unsupported') { allOk = false; unsupported.push(id); break }
      try {
        const grave = `${dir}.purged-${Date.now()}`
        renameSync(dir, grave)
        rmSync(grave, { recursive: true, force: true })
      } catch (e) {
        allOk = false
        busy.push(`${id}(删除失败:${e instanceof Error ? e.message : String(e)})`)
        break
      } finally {
        lock.release()
      }
    }
    if (allOk) { purged.push(id); purgedIds.add(id) }
  }

  // K4：为所有挂着的 session-log derivative 补 done（幂等由库层 INVALID_TRANSITION 兜住）。
  let k4Marked = 0
  const k4Completed: string[] = []
  if (audit !== undefined && purgedIds.size > 0) {
    for (const rec of audit.query({ kinds: ['deletion.requested'] })) {
      const e = rec.event as { kind: 'deletion.requested'; deletionId: string; derivatives?: { kind: string; ref: string }[] }
      const state = audit.deletion(e.deletionId)
      if (state.completed) continue
      state.derivatives.forEach((d, i) => {
        if (d.kind === 'session-log' && purgedIds.has(d.ref) && !d.done) {
          audit.append({ kind: 'owner' }, { kind: 'deletion.derivative-done', deletionId: e.deletionId, index: i })
          k4Marked++
        }
      })
      if (audit.deletion(e.deletionId).completed) k4Completed.push(e.deletionId)
    }
  }

  const lines: string[] = []
  if (purged.length > 0) lines.push(`已删除会话目录：${purged.join(', ')}`)
  if (busy.length > 0) lines.push(`在用拒删：${busy.join(', ')}`)
  if (unsupported.length > 0) lines.push(`平台不支持锁协议，未删：${unsupported.join(', ')}`)
  if (missing.length > 0) lines.push(`未找到会话目录：${missing.join(', ')}`)
  if (k4Marked > 0) lines.push(`K4 补记 derivative-done ×${k4Marked}；完成：${k4Completed.length > 0 ? k4Completed.join(', ') : '（无）'}`)
  if (purged.length > 0) lines.push('注意：整个会话日志已删除，不只是被删内容的部分。')

  return {
    ok: purged.length > 0 || (busy.length === 0 && unsupported.length === 0),
    purged, busy, missing, unsupported, k4Completed, k4Marked,
    message: lines.join('\n'),
  }
}
