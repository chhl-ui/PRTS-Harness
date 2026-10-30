/** PRTS 真实运行时进程入口（守护进程在 Job 中启动）。 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 1. connectControl 必须先于一切派生（删除控制 env，防子进程冒充）
const { connectControl } = await import('../stop/runtime-control.ts')

const mode = (process.env.PRTS_MODE ?? 'normal') as 'normal' | 'read-only'
const db = process.env.PRTS_DB as string
const dataRoot = process.env.PRTS_DATA_ROOT as string
const workspace = process.env.PRTS_WORKSPACE as string
const configPath = process.env.PRTS_CONFIG as string
if (!db || !dataRoot || !workspace || !configPath) {
  console.error('PRTS runtime: missing PRTS_DB/PRTS_DATA_ROOT/PRTS_WORKSPACE/PRTS_CONFIG')
  process.exit(2)
}

// 2. 账本/审计先行：boot 前的 stop 只能做账本停止；boot 后换完整 StopController
let stopImpl: ((level: 'S0' | 'S1' | 'S2') => Promise<unknown>) | null = null
const ctl = await connectControl({
  onStop: async (level) => {
    if (stopImpl) return stopImpl(level)
    // boot 未完成：仅账本停止
    const { Ledger } = await import('../ledger/index.ts')
    const { AuditLog } = await import('../audit/index.ts')
    const ledger = Ledger.open(db)
    const audit = AuditLog.open(db)
    try {
      const { StopController } = await import('../stop/index.ts')
      const hooks = { stopSpeech: async () => {}, cancelAllTurns: async () => {}, killAllJobs: async () => {} }
      return await new StopController({ hooks, ledger, audit }).stop(level)
    } finally { ledger.close(); audit.close() }
  },
})
void ctl

// 3. 密钥文件（不存在则不提供）
let credentials: { DEEPSEEK_API_KEY?: string } | undefined
const keyFile = join(dataRoot, 'secrets', 'deepseek.key')
if (existsSync(keyFile)) {
  credentials = { DEEPSEEK_API_KEY: readFileSync(keyFile, 'utf8').trim() }
}

// 4. 启动组合
const { startRuntime } = await import('./start.ts')
const app = await startRuntime({ configPath, dataRoot, workspace, mode, credentials })
const { StopController } = await import('../stop/index.ts')
const { Ledger } = await import('../ledger/index.ts')
const { AuditLog } = await import('../audit/index.ts')
stopImpl = async (level) => {
  const ledger = Ledger.open(db)
  const audit = AuditLog.open(db)
  try {
    const { createStopHooks } = await import('./stop-hooks.ts')
    const hooks = createStopHooks(app.ctx)
    return await new StopController({ hooks, ledger, audit }).stop(level)
  } finally { ledger.close(); audit.close() }
}
console.error('PRTS runtime: ready')
