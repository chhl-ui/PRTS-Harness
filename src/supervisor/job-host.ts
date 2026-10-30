/** K3 JobHost：把运行时进程放进 kill-on-close Job（仅 Windows）。 */
import { openSync, closeSync } from 'node:fs'
import { devNull } from 'node:os'
import {
  loadWin32ProcessBindings,
  spawnCurrentTokenJobProcess,
  pollProcessExit,
  isJobEmpty,
  terminateJob,
  closeHandleChecked,
} from '@deepseek-ai/dsh-win32-process'
import type { SpawnedJobProcess, Win32ProcessBindings } from '@deepseek-ai/dsh-win32-process'

export interface JobProcess {
  pid: number
  /** 已退出返回退出码，否则 undefined。 */
  exitCode(): number | undefined
  /** Job 内无活动进程。 */
  isEmpty(): boolean
  /** 终止 Job 内所有进程。 */
  terminate(exitCode: number): void
  /** 关闭进程与 Job 句柄；可重复调用。 */
  close(): void
}

export function spawnInJob(o: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  stdoutPath: string
  stderrPath: string
}): JobProcess {
  if (process.platform !== 'win32') {
    throw new Error('spawnInJob: only supported on Windows (Job Objects)')
  }
  const api: Win32ProcessBindings = loadWin32ProcessBindings()
  const stdin = openSync(devNull, 'r')
  const stdout = openSync(o.stdoutPath, 'a')
  const stderr = openSync(o.stderrPath, 'a')
  let spawned: SpawnedJobProcess
  try {
    spawned = spawnCurrentTokenJobProcess(api, {
      applicationName: o.command,
      command: o.command,
      args: o.args,
      cwd: o.cwd,
      env: o.env,
      stdio: { stdin, stdout, stderr },
    })
  } finally {
    closeSync(stdin); closeSync(stdout); closeSync(stderr)
  }
  let closed = false
  return {
    pid: spawned.pid,
    exitCode: () => pollProcessExit(api, spawned.process),
    isEmpty: () => isJobEmpty(api, spawned.job),
    terminate: (exitCode: number) => terminateJob(api, spawned.job, exitCode),
    close: () => {
      if (closed) return
      closed = true
      closeHandleChecked(api, spawned.process, 'runtime process handle')
      closeHandleChecked(api, spawned.job, 'runtime job handle')
    },
  }
}
