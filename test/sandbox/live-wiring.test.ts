/**
 * 接线级回归：`appcontainer` 后端下，`ctx.sandbox` 产出的 argv 真的能起一个受限进程，
 * 且隔离真的生效。
 *
 * 这一条与其它 sandbox 测试的分工：
 *  - `confine.test.ts` / `provider.test.ts`：验 argv 形状与字段，不跑进程
 *  - `appcontainer.test.ts` / `runner.test.ts`：验组件本身，argv 是手拼的
 *  - 本文件：**从 ctx.sandbox 拿 provider 真实产出的 argv** 去 spawn，验完整链路
 *
 * 为什么需要它：真机第一次跑就暴露过 `--inherit` 缺失（PTY 起不来），而纯 argv
 * 断言看不出来。这条用一个真实的受限进程守住「接线后还能跑」与「跑起来仍然隔离」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime } from '../../src/runtime/start.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'

const CMD = 'C:\\Windows\\System32\\cmd.exe'
const KEY = 'C:\\prts-data\\secrets\\deepseek.key'
/** 工作区外的落脚点，用来验证写越界被拦。 */
const OUTSIDE = 'C:\\Users\\Administrator\\prts-live-write-test.txt'

interface RunOut { code: number | null; out: string }

function collect(argv: readonly string[]): Promise<RunOut> {
  return new Promise((resolve) => {
    // stdio 用 pipe：confine 默认 `--inherit`，runner 会把子进程输出透传到这些管道上。
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.on('close', (code) => resolve({ code, out }))
  })
}

test('接线：appcontainer 后端下，真实 confine 产出的 argv 能跑且仍然隔离', { timeout: 180000 }, async () => {
  // workspace 必须在浅层：%TEMP% 下 AppContainer 无法 traverse 祖先链。
  const ws = join('C:\\', `prts-live-${process.pid}-${Date.now()}`)
  mkdirSync(ws, { recursive: true })
  const dataRoot = join(ws, '_data')
  mkdirSync(dataRoot, { recursive: true })

  const prev = process.env.PRTS_SANDBOX_BACKEND
  process.env.PRTS_SANDBOX_BACKEND = 'appcontainer'
  const app = await startRuntime({
    configPath: prtsYml,
    dataRoot,
    workspace: ws,
    mode: 'normal',
    patches: PATCHES,
  })

  try {
    assert.equal(app.sandboxBackend, 'appcontainer', '开关没生效，后续验证无意义')

    const sandbox = app.ctx.get('sandbox') as {
      confine?: (a: readonly string[], p: unknown) => Promise<{ argv: string[] }>
    } | undefined
    assert.ok(typeof sandbox?.confine === 'function', 'ctx.sandbox 必须提供 confine')
    const confine = sandbox.confine.bind(sandbox)

    const run = async (inner: string): Promise<RunOut> => {
      const wrapped = await confine([CMD, '/c', inner], {
        mode: 'workspace-write',
        workspaceRoot: ws,
        sessionId: 'sess-live',
      })
      assert.ok(wrapped.argv.some((a) => a.endsWith('runner.ts')),
        `argv 应经 runner 中转，实际 ${JSON.stringify(wrapped.argv)}`)
      // --inherit 必须默认带上：DSH 的 shell 走 PTY，capture 模式会让 PTY 看不到输出
      assert.ok(wrapped.argv.includes('--inherit'),
        'confine 必须默认 --inherit，否则 PTY 起不来（真机踩过）')
      return collect(wrapped.argv)
    }

    // ---- 进程真的起得来（外部程序这条路是通的：cmd 内建 + 输出回传）----
    const inside = await run('echo INSIDE_OK')
    assert.equal(inside.code, 0, `容器里跑 echo 失败，输出 ${JSON.stringify(inside.out.slice(0, 200))}`)
    assert.match(inside.out, /INSIDE_OK/, '输出没回传——链路某一环断了')

    // ---- 写工作区内：可以 ----
    const writeInside = await run('echo ok> in.txt && echo WROTE')
    assert.equal(writeInside.code, 0, '工作区内写应当成功')
    assert.equal(existsSync(join(ws, 'in.txt')), true, '文件没落盘')

    // ---- 写工作区外：被拦 ----
    const writeOutside = await run(`echo x> ${OUTSIDE}`)
    assert.notEqual(writeOutside.code, 0, '写工作区外必须失败')
    assert.equal(existsSync(OUTSIDE), false, '越界文件竟然被创建了——沙箱没生效')

    // ---- 读密钥：被拦，且不泄漏内容 ----
    if (!existsSync(KEY)) {
      assert.fail(`密钥文件不存在（${KEY}），读隔离无法验证——这不是通过`)
    }
    const readKey = await run(`type "${KEY}"`)
    assert.notEqual(readKey.code, 0, '读密钥必须失败')
    assert.doesNotMatch(readKey.out, /sk-|^[A-Za-z0-9_-]{30,}$/m,
      `输出里疑似有密钥内容：${JSON.stringify(readKey.out.slice(0, 120))}`)
  } finally {
    process.env.PRTS_SANDBOX_BACKEND = prev ?? ''
    if (prev === undefined) delete process.env.PRTS_SANDBOX_BACKEND
    await app.dispose()
    try { rmSync(OUTSIDE, { force: true }) } catch { /* 未被创建 */ }
    rmSync(ws, { recursive: true, force: true })
  }
})
