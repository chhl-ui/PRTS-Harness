/**
 * AppContainer provider 的委托层回归。
 *
 * 只验「政策到 confine 的翻译」与「失败必须是可识别的失败」——真正的包装逻辑
 * 在 confine.test.ts，真实执行在 runner.test.ts。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { AppContainerSandboxProvider } from '../../src/sandbox/provider.ts'
import { RUNNER_FAILURE_PREFIX } from '../../src/sandbox/confine.ts'

const RUNNER = 'C:\\prts-system\\src\\sandbox\\runner.ts'
const WS = 'C:\\prts-workspace'

function makePolicy(over: Record<string, unknown> = {}): never {
  return { mode: 'workspace-write', workspaceRoot: WS, sessionId: 'sess-1', ...over } as never
}

function provider(ctx: Context): AppContainerSandboxProvider {
  return new AppContainerSandboxProvider(ctx, { profile: 'PRTS.Sandbox', runnerPath: RUNNER })
}

test('provider: workspace-write 被翻译成 runner argv', async () => {
  const ctx = new Context()
  const p = provider(ctx)
  const out = await p.confine(['cmd.exe', '/c', 'echo hi'], makePolicy())
  assert.equal(out.argv[1], RUNNER, 'argv[1] 应是 runner 脚本')
  assert.deepEqual(out.argv.slice(2, 6), ['--profile', 'PRTS.Sandbox', '--workspace', WS])
  assert.equal(out.argv[6], '--inherit', 'DSH 的 shell 走 PTY，必须 inherit')
  assert.equal(out.argv[7], '--')
  assert.deepEqual(out.argv.slice(8), ['cmd.exe', '/c', 'echo hi'])
  assert.equal(out.enforcement, 'partial')
  assert.deepEqual(out.denialSignatures, [])
  assert.deepEqual(out.runnerFailureRules[0].fatalSignatures, [RUNNER_FAILURE_PREFIX])
})

test('provider: read-only 同样被接受（当前与 workspace-write 同构）', async () => {
  const ctx = new Context()
  const p = provider(ctx)
  const out = await p.confine(['cmd.exe', '/c', 'x'], makePolicy({ mode: 'read-only' }))
  assert.equal(out.argv[1], RUNNER)
})

test('provider: danger-full-access 抛 SandboxUnavailableError，不放行', async () => {
  const ctx = new Context()
  const p = provider(ctx)
  await assert.rejects(
    () => p.confine(['cmd.exe', '/c', 'x'], makePolicy({ mode: 'danger-full-access' })),
    // 必须可识别：放行会得到「以为在沙箱里、其实没有」
    (e: Error) => e.name === 'SandboxUnavailableError' || /danger-full-access|AppContainer/.test(e.message),
  )
})

test('provider: workspace 不可 traverse 时抛 SandboxUnavailableError 而不是普通错误', async () => {
  const ctx = new Context()
  const p = provider(ctx)
  const tempWs = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\ws'
  await assert.rejects(
    () => p.confine(['cmd.exe', '/c', 'x'], makePolicy({ workspaceRoot: tempWs })),
    (e: Error) => e.name === 'SandboxUnavailableError',
    '上游要靠 SANDBOX_UNAVAILABLE 区分「沙箱没配好」与「命令失败」',
  )
})

test('provider: 已取消的信号直接抛出，不做多余工作', async () => {
  const ctx = new Context()
  const p = provider(ctx)
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => p.confine(['cmd.exe'], makePolicy(), ac.signal))
})
