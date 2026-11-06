import test from 'node:test'

import assert from 'node:assert/strict'

import { confineArgv } from '../../src/sandbox/confine.ts'
import { parseRunnerArgv } from '../../src/sandbox/runner-args.ts'

/**
 * `/sandbox view`（read-only）下，容器不该再拿 workspace 写权限——
 * 链路是 confine 产出 `--mode` → runner 解析 → appcontainer 按 mode 决定
 * 授 `(OI)(CI)(RX,W)` 还是只授 `(OI)(CI)(RX)`。这两条测链路两端。
 */

function confine(mode: 'read-only' | 'workspace-write') {
  return confineArgv(['pwsh', '-NoProfile', '-Command', 'echo hi'], {
    mode,
    workspaceRoot: 'C:\\ws',
    profile: 'PRTS.Test',
    runnerPath: 'C:\\prts-system\\src\\sandbox\\runner.ts',
  })
}

test('confine 把 policy.mode 透传成 runner 的 --mode（-- 之前）', () => {
  for (const mode of ['read-only', 'workspace-write'] as const) {
    const out = confine(mode)
    const sep = out.argv.indexOf('--')
    const at = out.argv.indexOf('--mode')
    assert.ok(at > 0 && at < sep, `--mode 必须在 -- 之前（${mode}）`)
    assert.equal(out.argv[at + 1], mode, `--mode 值应等于 policy.mode（${mode}）`)
  }
})

test('parseRunnerArgv 解析 --mode；缺省为 workspace-write', () => {
  const ro = parseRunnerArgv([
    '--profile', 'P', '--workspace', 'C:\\ws', '--mode', 'read-only', '--', 'cmd',
  ])
  assert.equal(ro.mode, 'read-only')
  const def = parseRunnerArgv(['--profile', 'P', '--workspace', 'C:\\ws', '--', 'cmd'])
  assert.equal(def.mode, 'workspace-write', '缺省必须是 workspace-write（向后兼容旧 argv）')
})

test('parseRunnerArgv 拒绝未知 --mode（fail-closed，不静默当 workspace-write）', () => {
  assert.throws(
    () => parseRunnerArgv(['--profile', 'P', '--workspace', 'C:\\ws', '--mode', 'bogus', '--', 'cmd']),
    /--mode/,
    '未知 mode 必须抛错：静默放行等于以为有只读其实没有',
  )
})

test('confine 与 runner 两端 --mode 对得上（往返一致）', () => {
  const parsed = parseRunnerArgv(confine('read-only').argv)
  assert.equal(parsed.mode, 'read-only')
  assert.equal(parsed.profile, 'PRTS.Test')
})
