// 运行时替身：先 connectControl（删除 env）再派生 detached 孙进程；按 FAKE_MODE 行为。
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectControl } from '../../../src/stop/runtime-control.ts'
import type { RuntimeStopLevel } from '../../../src/stop/runtime-control.ts'

const db = process.env.PRTS_DB as string
const mode = process.env.FAKE_MODE ?? 'good'
const dataRoot = process.env.PRTS_DATA_ROOT as string

// freeze：模拟「进程活着但事件循环停摆」——连接控制管道但不发心跳。
// 关掉心跳后，Watchdog 只能靠自身的超时判定（真实场景里是同步阻塞让
// setInterval 停摆，效果相同）。
if (mode === 'freeze') process.env.PRTS_HEARTBEAT_MS = '0'

// 先连接控制管道（内部删除 PRTS_CONTROL_PIPE/TOKEN），再派生孙进程
const ctl = await connectControl({
  onStop: async (level: RuntimeStopLevel) => {
    if (mode === 'hang') await new Promise<never>(() => {}) // 永不回包
    const { StopController } = await import('../../../src/stop/index.ts')
    const { Ledger } = await import('../../../src/ledger/index.ts')
    const { AuditLog } = await import('../../../src/audit/index.ts')
    const ledger = Ledger.open(db)
    const audit = AuditLog.open(db)
    const hooks = {
      stopSpeech: async () => {},
      cancelAllTurns: async () => {},
      killAllJobs: async () => {},
    }
    const report = await new StopController({ hooks, ledger, audit }).stop(level)
    ledger.close(); audit.close()
    return report
  },
})
void ctl

// detached 孙进程：自报 env 是否残留控制变量，验证 Job 关闭即整树终止
const grandScript =
  `require('fs').writeFileSync(${JSON.stringify(join(dataRoot, `grand-${process.pid}.json`))},` +
  `JSON.stringify({pipe:!!process.env.PRTS_CONTROL_PIPE,token:!!process.env.PRTS_CONTROL_TOKEN}));` +
  `setTimeout(()=>{},600000)`
const grand = spawn(process.execPath, ['-e', grandScript], { detached: true, stdio: 'ignore' })
grand.unref()
writeFileSync(join(dataRoot, `fake-${process.pid}.json`), JSON.stringify({ pid: process.pid, grandchildPid: grand.pid }))

if (mode === 'crash') {
  setTimeout(() => process.exit(3), 300)
}
setInterval(() => {}, 1000)
