// 守护进程启动替身：起一个真 Supervisor，登记 runtimePid+grandchildPid 后打印 READY 并挂起。
// 父测试 SIGKILL 此进程 → 验证 Job 关闭即整树终止。
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Supervisor } from '../../../src/supervisor/index.ts'

const dataRoot = process.argv[2] as string
const fixture = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
const here = fileURLToPath(new URL('.', import.meta.url))

const sup = await Supervisor.start({
  dataRoot,
  runtime: { command: process.execPath, args: [fixture], cwd: here, env: { PRTS_DATA_ROOT: dataRoot, FAKE_MODE: 'good' } },
  ownerPipeName: `boot-${process.pid}`,
})

// 等运行时连上并写出 fake-<pid>.json
const t0 = Date.now()
let meta: { runtimePid: number; grandchildPid: number } | null = null
while (Date.now() - t0 < 15000) {
  const pid = sup.status().runtimePid
  if (pid) {
    const f = join(dataRoot, `fake-${pid}.json`)
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8')) as { grandchildPid: number }
      meta = { runtimePid: pid, grandchildPid: j.grandchildPid }
      break
    }
  }
  await new Promise(r => setTimeout(r, 50))
}
if (!meta) { console.error('no runtime'); process.exit(2) }
writeFileSync(join(dataRoot, 'sup-boot.json'), JSON.stringify(meta))
console.log('READY')
setInterval(() => {}, 1000)
