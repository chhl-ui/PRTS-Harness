/**
 * Watchdog：进程外检测「活着但卡死」，并强杀重启。
 *
 * 依据（`docs/design-superagent-fusion.md` 五模块；DeepSeek《Exploring Super-agent
 * Design》第 6 节）：
 *   「the usual process checks are not enough, because many failures are not crashes.
 *    The process is running, but the model is stuck」
 *   ——Watchdog 要问两个问题：**是否活着**，**是否在推进**。
 *
 * PRTS 的 `Supervisor` 已经是进程外的（kill-on-close Job、控制管道、S0–S3），
 * 但只做第一问：进程退出才重启。本文件补第二问——**心跳**。
 *
 * 机制：运行时每 `heartbeatMs` 通过控制管道发 `{type:'heartbeat'}`；
 * Supervisor 超过 `heartbeatTimeoutMs`（默认 3 倍）没收到就判卡死 → S3 强杀 → 重启。
 * **同步阻塞会让事件循环停摆，心跳随之停止**——这正是要抓的形态
 * （2026-11-04 实测：全量 20 轮第 5/11/15 轮挂起，CPU 2.5s / 存活 90s）。
 *
 * 基线预期：`heartbeatMs` 配置项与 `FAKE_MODE='freeze'` 尚不存在 —— 红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Supervisor } from '../../src/supervisor/index.ts'

const WIN = process.platform === 'win32'

function cfg(dir: string, fakeMode: string, extra: Record<string, unknown> = {}): never {
  return {
    dataRoot: dir,
    runtime: {
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', './fixtures/fake-runtime.ts'],
      cwd: new URL('.', import.meta.url).pathname.replace(/^\//, ''),
      env: { PRTS_DATA_ROOT: dir, FAKE_MODE: fakeMode },
    },
    ownerPipeName: `wd-${Math.random().toString(16).slice(2, 10)}`,
    ...extra,
  } as never
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

async function waitFor(cond: () => boolean, ms = 15000, step = 50): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, step)) }
  return cond()
}

async function cleanupSup(sup: Supervisor | undefined, dir: string): Promise<void> {
  try { if (sup) await sup.shutdown() } catch { /* ignore */ }
  try { const { rmSync } = await import('node:fs'); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
}

test('WD1 运行时卡死（连接但不发心跳）：判定停滞 → 强杀 → 重启 → 限额耗尽转 failed', { skip: !WIN, timeout: 90000 }, async () => {
  const dir = tmpDir('prts-wd-freeze-')
  let sup: Supervisor | undefined
  try {
    sup = await Supervisor.start(cfg(dir, 'freeze', {
      timeouts: { heartbeatMs: 200, s3Ms: 2000 },
      restart: { maxRestarts: 2, windowMs: 60000 },
    }))
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null), '运行时未启动')

    const alertsPath = join(dir, 'logs', 'alerts.log')
    const readAlerts = (): string => { try { return readFileSync(alertsPath, 'utf8') } catch { return '' } }

    // 1) 判定心跳超时（超时 = 200 * 3 = 600ms）
    assert.ok(await waitFor(() => /heartbeat timeout/.test(readAlerts()), 20000),
      `未判定心跳超时：${readAlerts().slice(0, 300)}`)
    // 2) 强杀后走了重启（不是只杀不管）
    assert.ok(await waitFor(() => /restarting \(1\//.test(readAlerts()), 15000),
      `未走重启：${readAlerts().slice(0, 300)}`)
    // 3) 反复卡死 → 限额耗尽 → failed（证明重启计数真的在生效，不是无限重启）
    assert.ok(await waitFor(() => sup!.status().state === 'failed', 30000),
      `限额（2）耗尽后未进入 failed，当前 state=${sup!.status().state}`)
    assert.match(readAlerts(), /restart limit/, '限额告警必须留痕')
  } finally { await cleanupSup(sup, dir) }
})

test('WD2 正常心跳：不误判、不重启', { skip: !WIN, timeout: 60000 }, async () => {
  const dir = tmpDir('prts-wd-good-')
  let sup: Supervisor | undefined
  try {
    sup = await Supervisor.start(cfg(dir, 'good', { timeouts: { heartbeatMs: 200 } }))
    assert.ok(await waitFor(() => sup!.status().runtimePid !== null), '运行时未启动')
    const first = sup!.status().runtimePid!
    assert.ok(await waitFor(() => sup!.runtimeConnected), '控制连接未建立')

    // 跑满 5 个超时周期（200*3*5 = 3s），pid 不得变、状态不得 failed
    await new Promise((r) => setTimeout(r, 3000))
    assert.equal(sup!.status().runtimePid, first, '正常心跳被误判重启')
    assert.equal(sup!.status().state, 'running')
  } finally { await cleanupSup(sup, dir) }
})
