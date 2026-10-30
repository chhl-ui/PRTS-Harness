/** K3 守护进程：进程外停止保障 + 崩溃重启 + 所有者控制管道。 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Socket } from 'node:net'

import { initCoreDb } from '../core/init.ts'
import { startupCheck } from '../core/startup-check.ts'
import { Ledger } from '../ledger/index.ts'
import { AuditLog } from '../audit/index.ts'
import { verifyIntegrity } from '../integrity/index.ts'
import type { ComposedEntry } from '../integrity/index.ts'
import { IntegrityError } from '../integrity/errors.ts'
import { spawnInJob } from './job-host.ts'
import type { JobProcess } from './job-host.ts'
import { encode, lineParser, listenPipe, ownerPipeName, runtimePipeName } from './protocol.ts'

export interface SupervisorConfig {
  dataRoot: string
  runtime: { command: string; args: string[]; cwd: string; env?: Record<string, string> }
  ownerPipeName: string
  timeouts?: { s2Ms?: number; s3Ms?: number }
  restart?: { maxRestarts: number; windowMs: number }
  /** K5：提供时，启动检查之后、spawn 之前执行完整性校验；失败不启动运行时。 */
  integrity?: { installRoot: string; manifestPath: string; entries: () => ComposedEntry[] }
}

type State = 'running' | 'stopped-by-owner' | 'restarting' | 'failed'
export type SupervisorStopLevel = 'S0' | 'S1' | 'S2' | 'S3'
export interface StopResult { level: SupervisorStopLevel; escalatedTo?: 'S3'; durationMs: number }

const STOP_ACTOR = { kind: 'system', component: 'stop' } as const

export class Supervisor {
  private readonly config: SupervisorConfig
  private readonly dbPath: string
  private readonly logsDir: string
  private readonly controlPipe: string
  private readonly s2Ms: number
  private readonly s3Ms: number
  private readonly maxRestarts: number
  private readonly windowMs: number

  private job: JobProcess | null = null
  private rt: Socket | null = null        // 运行时控制连接
  private mode: 'normal' | 'read-only' = 'normal'
  private state: State = 'running'
  private closed = false
  private restarts: number[] = []
  private pending = new Map<string, { resolve: (v: unknown) => void; timer: unknown }>()
  private pendingAuth = new Set<Socket>()   // 未通过 hello 认证的连接
  private controlToken = ''                 // 每次 spawn 重新生成
  private listeners: { close(): void }[] = []
  private pollTimer: unknown = null

  private constructor(config: SupervisorConfig) {
    this.config = config
    this.dbPath = join(config.dataRoot, 'core.sqlite')
    this.logsDir = join(config.dataRoot, 'logs')
    this.controlPipe = runtimePipeName()
    this.s2Ms = config.timeouts?.s2Ms ?? 5000
    this.s3Ms = config.timeouts?.s3Ms ?? 2000
    this.maxRestarts = config.restart?.maxRestarts ?? 3
    this.windowMs = config.restart?.windowMs ?? 60000
  }

  static async start(config: SupervisorConfig): Promise<Supervisor> {
    if (process.platform !== 'win32') throw new Error('Supervisor: only supported on Windows')
    const s = new Supervisor(config)
    mkdirSync(s.logsDir, { recursive: true })

    // K5 前半：启动检查 → 正常/不存在才 initCoreDb；read-only 记告警
    const check = startupCheck(s.dbPath)
    s.mode = check.mode
    if (check.mode === 'read-only') {
      s.alert(`startupCheck read-only: ${check.problems.join('; ')}`)
    } else {
      initCoreDb(s.dbPath)
    }

    // K5：完整性校验，失败不启动运行时
    if (config.integrity) {
      const r = verifyIntegrity({
        installRoot: config.integrity.installRoot,
        manifestPath: config.integrity.manifestPath,
        dbPath: s.dbPath,
        entries: config.integrity.entries(),
      })
      if (!r.ok) {
        s.state = 'failed'
        for (const f of r.failures) s.alert(`integrity: ${f.code} ${f.detail}`)
        if (s.mode === 'normal') {
          const audit = AuditLog.open(s.dbPath)
          try {
            audit.append({ kind: 'system', component: 'integrity' }, {
              kind: 'integrity.checked', ok: false,
              detail: r.failures.map((f) => `${f.code}:${f.detail}`).join('; ').slice(0, 500),
            })
          } finally { audit.close() }
        }
        throw new IntegrityError('INTEGRITY_FAILED',
          `integrity check failed: ${r.failures.map((f) => f.code).join(', ')}`, r.failures)
      }
      if (s.mode === 'normal') {
        const audit = AuditLog.open(s.dbPath)
        try {
          audit.append({ kind: 'system', component: 'integrity' }, { kind: 'integrity.checked', ok: true, detail: r.manifestSha256 })
        } finally { audit.close() }
      }
    }

    // 所有者管道：只接受 stop / status
    const owner = listenPipe(ownerPipeName(config.ownerPipeName))
    s.listeners.push(owner)
    void (async () => {
      for (;;) {
        const sock = await owner.nextClient()
        s.serveOwner(sock)
      }
    })()

    // 运行时控制管道（整个守护进程生命周期共用一条名字，重启沿用）
    const control = listenPipe(s.controlPipe)
    s.listeners.push(control)
    void (async () => {
      for (;;) {
        const sock = await control.nextClient()
        s.attachRuntime(sock)
      }
    })()

    s.spawnRuntime()
    s.pollTimer = setInterval(() => s.poll(), 200)
    return s
  }

  private alert(line: string): void {
    try { appendFileSync(join(this.logsDir, 'alerts.log'), `${new Date().toISOString()} ${line}\n`) } catch { /* 尽力 */ }
  }

  private spawnRuntime(): void {
    const out = join(this.logsDir, 'runtime-out.log')
    const err = join(this.logsDir, 'runtime-err.log')
    this.controlToken = randomBytes(32).toString('hex') // 重启换新令牌
    this.job = spawnInJob({
      command: this.config.runtime.command,
      args: this.config.runtime.args,
      cwd: this.config.runtime.cwd,
      env: {
        ...process.env,
        ...this.config.runtime.env,
        PRTS_CONTROL_PIPE: this.controlPipe,
        PRTS_CONTROL_TOKEN: this.controlToken,
        PRTS_DB: this.dbPath,
        PRTS_MODE: this.mode,
      } as Record<string, string>,
      stdoutPath: out,
      stderrPath: err,
    })
  }

  /**
   * 新连接先认证：2s 内首行必须是 {type:'hello',pid,token}，
   * token 用 timingSafeEqual 比对且 pid === 当前 job.pid；先认证者胜，
   * 已认证连接存活期间新连接一律拒绝。未认证消息全部丢弃。
   */
  private attachRuntime(sock: Socket): void {
    this.pendingAuth.add(sock)
    const drop = () => {
      this.pendingAuth.delete(sock)
      try { sock.destroy() } catch { /* ignore */ }
    }
    const timer = setTimeout(drop, 2000)
    let adopted = false
    sock.on('data', lineParser(
      (msg) => {
        if (adopted) return // 认证后交给 adoptRuntime 的解析器，这里不再处理（重复 hello 不得拆掉自己）
        const m = msg as { type?: string; pid?: unknown; token?: string }
        if (m?.type !== 'hello') return // 认证前一律丢弃
        clearTimeout(timer)
        const ok = typeof m.token === 'string' && this.tokenMatch(m.token)
          && m.pid === this.job?.pid
        if (!ok) { drop(); return }
        if (this.rt && !this.rt.destroyed) { drop(); return } // 先认证者胜
        adopted = true
        this.pendingAuth.delete(sock)
        this.adoptRuntime(sock)
      },
      () => { /* 畸形行丢弃 */ },
    ))
    sock.on('close', () => { this.pendingAuth.delete(sock); clearTimeout(timer) })
    sock.on('error', () => { /* close 跟随 */ })
  }

  private tokenMatch(tok: string): boolean {
    const a = Buffer.from(tok, 'utf8')
    const b = Buffer.from(this.controlToken, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  private adoptRuntime(sock: Socket): void {
    this.rt = sock
    sock.removeAllListeners('data')
    sock.on('data', lineParser(
      (msg) => this.onRuntimeMsg(msg),
      () => { /* 畸形行：忽略，不崩溃 */ },
    ))
    sock.on('close', () => { if (this.rt === sock) this.rt = null })
  }

  private onRuntimeMsg(msg: unknown): void {
    const m = msg as { type?: string; id?: string }
    if (m?.type === 'stopped' && typeof m.id === 'string') {
      const p = this.pending.get(m.id)
      if (p) {
        this.pending.delete(m.id)
        clearTimeout(p.timer as Parameters<typeof clearTimeout>[0])
        p.resolve(m)
      }
    }
  }

  private serveOwner(sock: Socket): void {
    const parse = lineParser(
      (msg) => {
        const m = msg as { type?: string; id?: string; level?: string }
        const id = typeof m?.id === 'string' ? m.id : randomUUID()
        if (m?.type === 'status') {
          const st = this.status()
          sock.write(encode({ type: 'status', id, pid: st.runtimePid, state: st.state, mode: st.mode }))
        } else if (m?.type === 'stop') {
          const level = m.level as SupervisorStopLevel
          void this.stop(level).then((r) => {
            try { sock.write(encode({ type: 'stopped', id, ...r })) } catch { /* gone */ }
          }).catch(() => { try { sock.write(encode({ type: 'error', id, code: 'INTERNAL' })) } catch { /* gone */ } })
        } else {
          sock.write(encode({ type: 'error', id, code: 'UNSUPPORTED' }))
        }
      },
      (raw) => { try { sock.write(encode({ type: 'error', id: randomUUID(), code: 'BAD_JSON' })) } catch { /* gone */ } },
    )
    sock.on('data', parse)
    sock.on('error', () => { /* 对端断开 */ })
  }

  status(): { runtimePid: number | null; mode: 'normal' | 'read-only'; state: State } {
    return { runtimePid: this.job && !this.job.isEmpty() ? this.job.pid : null, mode: this.mode, state: this.state }
  }

  /** 运行时控制 socket 是否已连接（就绪判定用；spawn 成功 ≠ 已连接）。 */
  get runtimeConnected(): boolean {
    return this.rt !== null && !this.rt.destroyed
  }

  /** 转发 stop 给运行时；超时/未连接/断开 → 升级 S3。 */
  async stop(level: SupervisorStopLevel): Promise<StopResult> {
    const t0 = Date.now()
    let escalatedTo: 'S3' | undefined
    let done = false

    if (level !== 'S3') {
      done = await this.requestRuntimeStop(level)
    }
    if (!done || level === 'S3') {
      escalatedTo = 'S3'
      await this.escalateS3()
    }
    if (level === 'S2' || level === 'S3' || escalatedTo === 'S3') {
      this.state = 'stopped-by-owner'
    }
    return { level, escalatedTo, durationMs: Date.now() - t0 }
  }

  private requestRuntimeStop(level: SupervisorStopLevel): Promise<boolean> {
    const rt = this.rt
    if (!rt || rt.destroyed) return Promise.resolve(false)
    const id = randomUUID()
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false) }, this.s2Ms)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(true) }, timer })
      try { rt.write(encode({ type: 'stop', id, level })) } catch { this.pending.delete(id); clearTimeout(timer); resolve(false) }
      rt.once('close', () => { if (this.pending.delete(id)) { clearTimeout(timer); resolve(false) } })
    })
  }

  /** S3：terminate(1) → 等 Job 清空 → 守护进程自己写账本与审计。 */
  private async escalateS3(): Promise<void> {
    const job = this.job
    if (job) {
      try { job.terminate(1) } catch { /* 已死 */ }
      const deadline = Date.now() + this.s3Ms
      while (!job.isEmpty() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
      }
      if (!job.isEmpty()) {
        this.alert(`S3 escalation: job not empty after ${this.s3Ms}ms`)
        throw new Error(`S3 escalation: job not empty after ${this.s3Ms}ms`)
      }
      job.close()
      this.job = null
    }
    // 运行时已死：账本停止与审计只能由守护进程写
    const t0 = Date.now()
    const ledger = Ledger.open(this.dbPath)
    const audit = AuditLog.open(this.dbPath)
    try {
      audit.append(STOP_ACTOR, { kind: 'stop.requested', level: 'S3' })
      for (const t of ledger.list()) {
        if (t.phase === 'done' || t.phase === 'cancelled' || t.phase === 'stopped-by-owner') continue
        try { ledger.stopByOwner(t.id) } catch { /* 单项失败不阻塞 */ }
      }
      audit.append(STOP_ACTOR, { kind: 'stop.completed', level: 'S3', durationMs: Date.now() - t0, escalatedTo: 'S3' })
    } finally {
      try { ledger.close() } catch { /* ignore */ }
      try { audit.close() } catch { /* ignore */ }
    }
  }

  /** 意外退出自动重启（限额内）；所有者停止不重启。 */
  private poll(): void {
    if (this.closed || !this.job) return
    const code = this.job.exitCode()
    if (code === undefined) return
    const dead = this.job
    this.job = null
    dead.close()
    if (this.state === 'stopped-by-owner' || this.state === 'failed') return
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < this.windowMs)
    if (this.restarts.length >= this.maxRestarts) {
      this.state = 'failed'
      this.alert(`runtime exited (code ${code}); restart limit ${this.maxRestarts}/${this.windowMs}ms reached`)
      return
    }
    this.state = 'restarting'
    this.restarts.push(now)
    this.alert(`runtime exited (code ${code}); restarting (${this.restarts.length}/${this.maxRestarts})`)
    try {
      this.spawnRuntime()
      this.state = 'running'
    } catch (e) {
      this.state = 'failed'
      this.alert(`respawn failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 正常停机：先请求 S2，超时走 S3；然后关 Job 与管道；不触发重启。 */
  async shutdown(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.state = 'stopped-by-owner'
    if (this.job && !this.job.isEmpty()) {
      const ok = await this.requestRuntimeStop('S2')
      if (!ok) {
        try { await this.escalateS3() } catch { /* 尽力 */ }
      }
    }
    if (this.pollTimer) clearInterval(this.pollTimer as Parameters<typeof clearInterval>[0])
    if (this.job) this.job.close()
    for (const l of this.listeners) l.close()
    if (this.rt) { try { this.rt.destroy() } catch { /* ignore */ } this.rt = null }
    for (const s of this.pendingAuth) { try { s.destroy() } catch { /* ignore */ } }
    this.pendingAuth.clear()
  }
}
