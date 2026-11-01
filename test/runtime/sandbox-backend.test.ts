/**
 * 沙箱后端开关回归。
 *
 * 只验「开关拨到 appcontainer 时 ctx.sandbox 确实换成了我们的 provider，且
 * confine 产出 runner argv」——不启动真实 shell（那需要模型驱动，属于另一层）。
 *
 * 环境变量是进程级的，测试之间会互相污染，所以每条用例都在 finally 里还原。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startRuntime } from '../../src/runtime/start.ts'
import { prtsYml, PATCHES } from '../support/composition.ts'
import { makeTmp } from '../support/tmp.ts'

const CMD = 'C:\\Windows\\System32\\cmd.exe'

async function withBackend<T>(backend: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PRTS_SANDBOX_BACKEND
  if (backend === undefined) delete process.env.PRTS_SANDBOX_BACKEND
  else process.env.PRTS_SANDBOX_BACKEND = backend
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.PRTS_SANDBOX_BACKEND
    else process.env.PRTS_SANDBOX_BACKEND = prev
  }
}

test('沙箱后端：默认仍是 local，ctx.sandbox 来自 dsh-sandbox-local', { timeout: 180000 }, async () => {
  await withBackend(undefined, async () => {
    const t = makeTmp('sb-local-')
    const dataRoot = join(t.dir, 'data')
    const ws = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(ws, { recursive: true })
    const app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: PATCHES,
    })
    try {
      assert.equal(app.sandboxBackend, 'local', '未设置开关时应保持既有后端')
      const sandbox = app.ctx.get('sandbox') as { confine?: unknown } | undefined
      assert.ok(sandbox !== undefined, 'dsh-sandbox-local 应当已注册 ctx.sandbox')
      assert.equal(typeof sandbox?.confine, 'function')
    } finally {
      await app.dispose()
      t.cleanup()
    }
  })
})

test('沙箱后端：appcontainer 时 ctx.sandbox 换成我们的 provider，confine 产出 runner argv', { timeout: 180000 }, async () => {
  await withBackend('appcontainer', async () => {
    const t = makeTmp('sb-ac-')
    const dataRoot = join(t.dir, 'data')
    // workspace 必须在祖先链可 traverse 的浅层路径：%TEMP% 下 AppContainer 读不到，
    // confine 会（正确地）以 SANDBOX_UNAVAILABLE 拒绝。
    const ws = join('C:\\', `prts-sb-ac-${process.pid}-${Date.now()}`)
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(ws, { recursive: true })
    const app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal', patches: PATCHES,
    })
    try {
      assert.equal(app.sandboxBackend, 'appcontainer')
      const sandbox = app.ctx.get('sandbox') as {
        confine?: (a: readonly string[], p: unknown) => Promise<{ argv: string[]; enforcement: string }>
      } | undefined
      assert.ok(sandbox !== undefined && typeof sandbox.confine === 'function',
        'appcontainer 后端下 ctx.sandbox 必须提供 confine')

      const out = await sandbox.confine([CMD, '/c', 'echo hi'], {
        mode: 'workspace-write',
        workspaceRoot: ws,
        sessionId: 'sess-sb',
      })
      assert.ok(out.argv.some((a) => a.endsWith('runner.ts')),
        `argv 里应出现 runner 脚本，实际 ${JSON.stringify(out.argv)}`)
      assert.equal(out.enforcement, 'partial')
    } finally {
      await app.dispose()
      rmSync(ws, { recursive: true, force: true })
      t.cleanup()
    }
  })
})
