import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { Supervisor } from '../../src/supervisor/index.ts'
import { ownerPipeName } from '../../src/supervisor/protocol.ts'
import { Ledger } from '../../src/ledger/index.ts'
import { AuditLog } from '../../src/audit/index.ts'
import { DatabaseSync } from 'node:sqlite'
import { owner } from '../ledger/helpers.ts'

const WIN = process.platform === 'win32'
const fixture = fileURLToPath(new URL('./fixtures/fake-runtime.ts', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function waitFor(cond: () => boolean, ms = 8000, step = 50): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise(r => setTimeout(r, step)) }
  return cond()
}
function tmpDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}
function cfg(dir: string, fakeMode = 'good', extra: Partial<Parameters<typeof Supervisor.start>[0]> = {}) {
  mkdirSync(dir, { recursive: true })
  return {
    dataRoot: dir,
    runtime: { command: process.execPath, args: [fixture], cwd: here, env: { PRTS_DATA_ROOT: dir, FAKE_MODE: fakeMode } },
    ownerPipeName: `test-${Math.random().toString(16).slice(2, 10)}`,
    ...extra,
  } as Parameters<typeof Supervisor.start>[0]
}
async function ownerReq(pipe: string, msg: Record<string, unknown>, read = true): Promise<Record<string, unknown>> {
  const s = connect(pipe)
  await new Promise((res, rej) => { s.once('connect', res); s.once('error', rej) })
  s.write(JSON.stringify(msg) + '\n')
  if (!read) { await new Promise(r => setTimeout(r, 60)); s.destroy(); return {} }
  return new Promise((resolve, reject) => {
    let buf = ''
    s.on('data', (c) => {
      buf += String(c)
      const i = buf.indexOf('\n')
      if (i >= 0) { s.destroy(); resolve(JSON.parse(buf.slice(0, i))) }
    })
    s.once('error', reject)
    setTimeout(() => { s.destroy(); reject(new Error('owner pipe timeout')) }, 5000)
  })
}
async function cleanupSup(sup: Supervisor | undefined, pids: number[], dir: string) {
  if (sup) { try { await sup.shutdown() } catch { /* ignore */ } }
  for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
  for (const p of pids) await waitFor(() => !pidAlive(p), 3000)
  await waitFor(() => {
    try { rmSync(dir, { recursive: true, force: true }); return true } catch { return false }
  }, 15000, 200)
}

test('S2 good：所有者 stop → stopped、任务停止、不升级、pid 仍活、state=stopped-by-owner', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    // 预置任务
    const l0 = Ledger.open(join(dir, 'core.sqlite'))
    const task = l0.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l0.activate(owner, { id: task.id, revision: 1 }); l0.close()

    sup = await Supervisor.start(cfg(dir))
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null))
    pids.push(sup.status().runtimePid!)
    assert.ok(await waitFor(() => sup!.runtimeConnected), '运行时未连接控制管道')

    const r = await sup.stop('S2')
    assert.equal(r.escalatedTo, undefined)
    assert.equal(sup.status().state, 'stopped-by-owner')
    assert.ok(pidAlive(pids[0]), 'S2 不应杀运行时')

    const l = Ledger.open(join(dir, 'core.sqlite'), { readOnly: true })
    try { assert.equal(l.get(task.id).phase, 'stopped-by-owner') } finally { l.close() }
    const a = AuditLog.open(join(dir, 'core.sqlite'), { readOnly: true })
    try {
      const kinds = a.query({ kinds: ['stop.requested', 'stop.completed'] }).map(e => e.event.kind)
      assert.ok(kinds.includes('stop.requested') && kinds.includes('stop.completed'))
    } finally { a.close() }
  } finally { await cleanupSup(sup, pids, dir) }
})

test('S3 升级：hang 超时 → terminate、孙进程全灭、账本由守护进程写、escalatedTo=S3', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    const l0 = Ledger.open(join(dir, 'core.sqlite'))
    const task = l0.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l0.activate(owner, { id: task.id, revision: 1 }); l0.close()

    sup = await Supervisor.start(cfg(dir, 'hang', { timeouts: { s2Ms: 1000, s3Ms: 3000 } }))
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null))
    const pid = sup.status().runtimePid!
    pids.push(pid)
    const metaFile = join(dir, `fake-${pid}.json`)
    assert.ok(await waitFor(() => existsSync(metaFile)), 'fake runtime 未写登记文件')
    assert.ok(await waitFor(() => sup!.runtimeConnected), '运行时未连接控制管道') // 保证走 s2Ms 超时路径
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as { grandchildPid: number }
    pids.push(meta.grandchildPid)
    assert.ok(pidAlive(meta.grandchildPid))

    const t0 = Date.now()
    const r = await sup.stop('S2')
    const escalationMs = Date.now() - t0
    console.log(`S3 escalation total ${escalationMs}ms (s2 timeout 1000 + terminate+empty)`)
    assert.equal(r.escalatedTo, 'S3')
    assert.equal(sup.status().state, 'stopped-by-owner')
    assert.ok(await waitFor(() => !pidAlive(pid), 4000), '运行时 pid 未消失')
    assert.ok(await waitFor(() => !pidAlive(meta.grandchildPid), 4000), 'detached 孙进程未消失')

    const l = Ledger.open(join(dir, 'core.sqlite'), { readOnly: true })
    try { assert.equal(l.get(task.id).phase, 'stopped-by-owner') } finally { l.close() }
    const a = AuditLog.open(join(dir, 'core.sqlite'), { readOnly: true })
    try {
      const done = a.query({ kinds: ['stop.completed'] }).map(e => e.event as { escalatedTo?: string })
      assert.equal(done[done.length - 1]?.escalatedTo, 'S3')
    } finally { a.close() }
  } finally { await cleanupSup(sup, pids, dir) }
})

test('守护进程被 SIGKILL：Job 关闭即整树终止（≤3s 运行时+孙进程全灭）', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  const boot = fileURLToPath(new URL('./fixtures/sup-boot.ts', import.meta.url))
  const child = spawn(process.execPath, [boot, dir], { stdio: 'pipe' })
  let errBuf = ''
  child.stderr?.on('data', (c) => { errBuf += String(c) })
  try {
    // 等启动脚本打出 READY
    await new Promise<void>((resolve, reject) => {
      let buf = ''
      child.stdout?.on('data', (c) => {
        buf += String(c)
        if (buf.includes('READY')) resolve()
      })
      child.once('exit', (code) => reject(new Error(`boot exited code=${code} stderr=${errBuf.slice(-600)}`)))
      setTimeout(() => reject(new Error(`READY timeout; stderr=${errBuf.slice(-600)}`)), 30000)
    })
    const meta = JSON.parse(readFileSync(join(dir, 'sup-boot.json'), 'utf8')) as { runtimePid: number; grandchildPid: number }
    pids.push(meta.runtimePid, meta.grandchildPid)
    assert.ok(pidAlive(meta.runtimePid) && pidAlive(meta.grandchildPid))

    child.kill('SIGKILL')
    await new Promise(r => child.once('exit', r))
    assert.ok(await waitFor(() => !pidAlive(meta.runtimePid), 3000), 'supervisor 死后运行时应消失')
    assert.ok(await waitFor(() => !pidAlive(meta.grandchildPid), 3000), '孙进程应随 Job 消亡')
  } finally {
    try { child.kill('SIGKILL') } catch { /* gone */ }
    for (const p of pids) try { process.kill(p, 'SIGKILL') } catch { /* gone */ }
    await waitFor(() => {
      try { rmSync(dir, { recursive: true, force: true }); return true } catch { return false }
    }, 15000, 200)
  }
})

test('崩溃重启：crash 模式 maxRestarts=2 → 两次换 pid 后 failed；所有者 S3 后不重启', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    sup = await Supervisor.start(cfg(dir, 'crash', { restart: { maxRestarts: 2, windowMs: 60000 }, timeouts: { s2Ms: 800 } }))
    const seen = new Set<number>()
    assert.ok(await waitFor(() => {
      const p = sup!.status().runtimePid
      if (p) { seen.add(p); pids.push(p) }
      return sup!.status().state === 'failed'
    }, 15000), '未达到 failed 状态')
    assert.equal(seen.size >= 2, true, `pid 变化次数 ${seen.size}`) // 至少换过一次（crash 每次 ~300ms）
    const alerts = readFileSync(join(dir, 'logs', 'alerts.log'), 'utf8')
    assert.match(alerts, /restart|exited|failed/)

    // 再起一个，所有者 S3 → 不重启
    const dir2 = tmpDir('prts-sup2-')
    const pids2: number[] = []
    let sup2: Supervisor | undefined
    try {
      sup2 = await Supervisor.start(cfg(dir2, 'crash', { restart: { maxRestarts: 5, windowMs: 60000 }, timeouts: { s3Ms: 3000 } }))
      assert.ok(await waitFor(() => sup2!.status().runtimePid !== null))
      pids2.push(sup2.status().runtimePid!)
      const r = await sup2.stop('S3')
      assert.equal(r.escalatedTo, 'S3')
      const deadPid = pids2[0]
      await new Promise(r => setTimeout(r, 1200))
      assert.equal(sup2.status().state, 'stopped-by-owner')
      assert.equal(sup2.status().runtimePid, null, 'S3 后不应重启')
      assert.ok(!pidAlive(deadPid))
    } finally { await cleanupSup(sup2, pids2, dir2) }
  } finally { await cleanupSup(sup, pids, dir) }
})

test('read-only：库被篡改 → PRTS_MODE=read-only、alerts 有 problems、audit 行数不变', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    const { initCoreDb } = await import('../../src/core/init.ts')
    initCoreDb(join(dir, 'core.sqlite')) // 建齐两表再篡改
    const l0 = Ledger.open(join(dir, 'core.sqlite'))
    l0.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l0.close()
    const raw = new DatabaseSync(join(dir, 'core.sqlite'))
    raw.exec("UPDATE ledger_events SET payload_json = '{\"x\":1}' WHERE seq = 1")
    const before = (raw.prepare('SELECT COUNT(*) c FROM audit_events').get() as { c: number }).c
    raw.close()

    sup = await Supervisor.start(cfg(dir, 'good', { timeouts: { s2Ms: 800, s3Ms: 2000 } }))
    assert.equal(sup.status().mode, 'read-only')
    const alerts = readFileSync(join(dir, 'logs', 'alerts.log'), 'utf8')
    assert.match(alerts, /audit_events|ledger_events|missing|broken/)
    const raw2 = new DatabaseSync(join(dir, 'core.sqlite'))
    try {
      assert.equal((raw2.prepare('SELECT COUNT(*) c FROM audit_events').get() as { c: number }).c, before)
    } finally { raw2.close() }
  } finally { await cleanupSup(sup, pids, dir) }
})

test('所有者管道：status 返回 pid；未知类型 UNSUPPORTED；畸形 JSON 不崩守护进程', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    sup = await Supervisor.start(cfg(dir))
    const pipe = ownerPipeName((sup as unknown as { config: { ownerPipeName: string } }).config.ownerPipeName)
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null))
    pids.push(sup.status().runtimePid!)

    const st = await ownerReq(pipe, { type: 'status', id: 'q1' })
    assert.equal(st.type, 'status')
    assert.equal(st.pid, pids[0])
    const bad = await ownerReq(pipe, { type: 'wat', id: 'q2' })
    assert.equal(bad.code, 'UNSUPPORTED')
    // 畸形 JSON：守护进程不崩，再发 status 仍正常
    const s = connect(pipe)
    await new Promise((res) => s.once('connect', res))
    s.write('not-json{{{\n')
    await new Promise(r => setTimeout(r, 200))
    s.destroy()
    const st2 = await ownerReq(pipe, { type: 'status', id: 'q3' })
    assert.equal(st2.type, 'status')
  } finally { await cleanupSup(sup, pids, dir) }
})

// ===== 控制管道认证（R3.2/R3.3：模型 shell 不得冒充运行时）=====

function controlPipeOf(sup: Supervisor): string {
  return (sup as unknown as { controlPipe: string }).controlPipe
}
function tokenOf(sup: Supervisor): string {
  return (sup as unknown as { controlToken: string }).controlToken
}
/** 连上控制管道并可选发一行，返回 {sock, closed}。 */
async function impostor(pipe: string, lines: string[]): Promise<{ close(): Promise<void>; closed: boolean }> {
  const s = connect(pipe)
  const st = { closed: false }
  await new Promise<void>((res, rej) => { s.once('connect', res); s.once('error', rej) })
  s.on('close', () => { st.closed = true })
  for (const l of lines) s.write(l + '\n')
  return {
    get closed() { return st.closed },
    close: () => new Promise<void>((res) => { s.once('close', res); s.destroy(); setTimeout(res, 3000) }),
  }
}

test('控制管道认证：四种冒充场景全拒 + 孙进程无控制 env', { skip: !WIN }, async () => {
  const dir = tmpDir('prts-sup-')
  const pids: number[] = []
  let sup: Supervisor | undefined
  try {
    const l0 = Ledger.open(join(dir, 'core.sqlite'))
    l0.create(owner, { title: 'T', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    l0.close()

    // s2Ms 用产品默认值（5s），不用其他用例的 1s：本用例验证的是「真运行时
    // 能应答 S2」，不是「超时升级」（那是 :104 的 hang 用例）——1s 在高负载下
    // （全量跑 15 个文件并发）不够 fixture 子进程被调度 + 回包，会让第 5 步
    // 偶发升级到 S3（实测 30 次全量 1 次）。
    sup = await Supervisor.start(cfg(dir, 'good', { timeouts: { s2Ms: 5000, s3Ms: 3000 } }))
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null))
    pids.push(sup.status().runtimePid!)
    assert.ok(await waitFor(() => sup!.runtimeConnected))
    const pipe = controlPipeOf(sup)
    const token = tokenOf(sup)
    const realPid = sup.status().runtimePid!

    // 1) 错误 token → 连接被销毁，真运行时保持
    const imp1 = await impostor(pipe, [JSON.stringify({ type: 'hello', pid: realPid, token: 'aa'.repeat(32) })])
    await waitFor(() => imp1.closed, 3000)
    assert.equal(imp1.closed, true)
    assert.equal(sup.runtimeConnected, true, '真运行时连接被顶替')

    // 2) 正确 token + 错误 pid → 拒
    const imp2 = await impostor(pipe, [JSON.stringify({ type: 'hello', pid: realPid + 9999, token })])
    await waitFor(() => imp2.closed, 3000)
    assert.equal(imp2.closed, true)

    // 3) 不发 hello → ~2s 后断开
    const t0 = Date.now()
    const imp3 = await impostor(pipe, [])
    assert.ok(await waitFor(() => imp3.closed, 4000), '未认证连接未被清理')
    const dt = Date.now() - t0
    assert.ok(dt >= 1500 && dt <= 3500, `hello 超时窗口异常: ${dt}ms`)

    // 4) 已认证期间正确 token+pid 的后来者也被拒（先认证者胜）
    const imp4 = await impostor(pipe, [JSON.stringify({ type: 'hello', pid: realPid, token })])
    await waitFor(() => imp4.closed, 3000)
    assert.equal(imp4.closed, true)
    assert.equal(sup.runtimeConnected, true)

    // 5) 真运行时仍正常应答 S2，无升级
    const r = await sup.stop('S2')
    assert.equal(r.escalatedTo, undefined, `S2 应正常应答而不是升级（耗时 ${r.durationMs}ms）`)

    // 6) 孙进程 env 检查：两控制变量都不得存在
    const grandFile = join(dir, `grand-${realPid}.json`)
    assert.ok(await waitFor(() => existsSync(grandFile)), '孙进程未写 env 报告')
    const g = JSON.parse(readFileSync(grandFile, 'utf8')) as { pipe: boolean; token: boolean }
    assert.deepEqual(g, { pipe: false, token: false })
    await imp1.close(); await imp2.close(); await imp3.close(); await imp4.close()
  } finally { await cleanupSup(sup, pids, dir) }
})


