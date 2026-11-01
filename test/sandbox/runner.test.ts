/**
 * runner 回归：验证 DSH 启动它的那种形态真的能用。
 *
 * 与 appcontainer.test.ts 的区别：那边直接调库，这边走**两层管道**——
 * AppContainer 子进程 → CreatePipe → runner 进程 → 调用方的 Node 管道。
 * 接线到 DSH 时走的是这条路，所以单独钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../../src/sandbox/runner.ts', import.meta.url))
const CMD = 'C:\\Windows\\System32\\cmd.exe'

interface RunResult {
  code: number | null
  out: string
  err: string
}

function runRunner(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    child.on('close', (code: number | null) => resolve({ code, out, err }))
  })
}

test('runner: 输出穿过两层管道、退出码原样透传', { timeout: 180000 }, async () => {
  const ws = join(tmpdir(), `prts-runner-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const profile = `PRTS.RunnerTest.${process.pid}.${Date.now()}`
  try {
    const r = await runRunner([
      '--profile', profile, '--workspace', ws, '--',
      CMD, '/c', 'echo NESTED_OK && echo NESTED_ERR 1>&2 && exit 3',
    ])
    assert.equal(r.code, 3, `退出码应原样透传为 3，实际 ${r.code}（stderr: ${r.err.trim()}）`)
    assert.match(r.out, /NESTED_OK/, `stdout 没穿过来：${JSON.stringify(r.out)}`)
    assert.match(r.out, /NESTED_ERR/, `stderr 没合并进来：${JSON.stringify(r.out)}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: 大输出在两层管道里不丢不死锁', { timeout: 180000 }, async () => {
  const ws = join(tmpdir(), `prts-runner-big-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const profile = `PRTS.RunnerBig.${process.pid}.${Date.now()}`
  try {
    const r = await runRunner([
      '--profile', profile, '--workspace', ws, '--',
      CMD, '/c', 'for /L %i in (1,1,5000) do @echo 0123456789012345678901234567890123456789',
    ])
    assert.equal(r.code, 0, `大输出导致非零退出 ${r.code}`)
    assert.ok(r.out.length > 150_000,
      `输出被截断到 ${r.out.length} 字节——两层管道里有死锁或提前结束`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: 启动失败必须 fail-closed（非零 + 可读错误）', { timeout: 180000 }, async () => {
  const ws = join(tmpdir(), `prts-runner-bad-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const profile = `PRTS.RunnerBad.${process.pid}.${Date.now()}`
  try {
    const r = await runRunner([
      '--profile', profile, '--workspace', ws, '--',
      'C:\\Windows\\System32\\definitely-not-here.exe',
    ])
    assert.equal(r.code, 70, `内部错误应返回 70，实际 ${r.code}`)
    assert.ok(r.err.length > 0, '失败必须往 stderr 写可读原因，不能静默')
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})

test('runner: 用法错误返回 64', { timeout: 60000 }, async () => {
  const r = await runRunner(['--workspace', 'C:\\tmp'])
  assert.equal(r.code, 64, `缺 --profile 应返回 64，实际 ${r.code}`)
  assert.match(r.err, /--profile/)
})

test('runner: cwd 设到工作区——pwsh 能执行（继承错目录会报「当前目录无效」）', { timeout: 180000 }, async () => {
  // 这是一个真实踩到的缺陷：runner 起初没给 spawn 传 cwd，子进程继承 runner 的
  // 当前目录（仓库根），AppContainer 对它没有 traverse。cmd 不敏感所以看不出，
  // pwsh 直接报「当前目录无效」而根本不执行命令。用相对路径写文件来钉住它。
  const PWSH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  // 必须用**浅层**目录：workspace 放在 %TEMP% 下时，PowerShell 解析相对路径要
  // realpath 整条祖先链，而 AppData / Temp 对 AppContainer 没有 traverse 权限，
  // 于是报「对路径 … 的访问被拒绝」。cmd 不做 realpath 所以看不出来。
  // 生产配置的 C:\prts-workspace 就符合这个要求，测试也跟着放 C:\ 下。
  const ws = join('C:\\', `prts-ac-test-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const profile = `PRTS.RunnerCwd.${process.pid}.${Date.now()}`
  try {
    const r = await runRunner([
      '--profile', profile, '--workspace', ws, '--',
      PWSH, '-NoProfile', '-Command',
      'Set-Content -Path inside-ps.txt -Value ps-ok; Get-Content inside-ps.txt',
    ])
    assert.equal(r.code, 0, `pwsh 退出码 ${r.code}（输出：${JSON.stringify((r.out + r.err).slice(0, 200))}）`)
    assert.match(r.out, /ps-ok/, `pwsh 没按工作区为 cwd 执行：${JSON.stringify(r.out.slice(0, 200))}`)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
