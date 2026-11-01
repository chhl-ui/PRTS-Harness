import test from 'node:test'

import assert from 'node:assert/strict'

import { confineArgv } from '../../src/sandbox/confine.ts'
import { parseRunnerArgv } from '../../src/sandbox/runner-args.ts'

/**
 * AppContainer 需要能读 spill 根才能回读卸载结果（实测：`Test-Path` 对 spill 文件
 * 返回 Access is denied）。链路是 confine 产出 `--read-path` → runner 解析 →
 * appcontainer 的 `extraReadPaths` 授权。这两条测的是链路的两端。
 */

function confine(readPaths?: readonly string[]) {
  return confineArgv(['pwsh', '-NoProfile', '-Command', 'echo hi'], {
    mode: 'workspace-write',
    workspaceRoot: 'C:\\ws',
    profile: 'PRTS.Test',
    runnerPath: 'C:\\prts-system\\src\\sandbox\\runner.ts',
    readPaths,
  })
}

test('confine 把多个 readPaths 展开成多个 --read-path', () => {
  const out = confine(['C:\\spill', 'C:\\other'])
  const flags = out.argv.filter((a) => a === '--read-path')
  assert.equal(flags.length, 2, '应有两条 --read-path')
  assert.ok(out.argv.includes('C:\\spill'))
  assert.ok(out.argv.includes('C:\\other'))
})

test('--read-path 必须出现在 -- 分隔符之前（属于 runner 参数，不是命令参数）', () => {
  const out = confine(['C:\\spill'])
  const sep = out.argv.indexOf('--')
  assert.ok(sep > 0, '必须保留 -- 分隔符')
  const readAt = out.argv.indexOf('--read-path')
  assert.ok(readAt > 0 && readAt < sep, '--read-path 必须在 -- 之前')
})

test('没有 readPaths 时不产生 --read-path', () => {
  assert.equal(confine().argv.includes('--read-path'), false)
  assert.equal(confine([]).argv.includes('--read-path'), false)
})

test('命令本体原样保留在 -- 之后', () => {
  const out = confine(['C:\\spill'])
  const sep = out.argv.indexOf('--')
  assert.deepEqual(out.argv.slice(sep + 1), ['pwsh', '-NoProfile', '-Command', 'echo hi'])
})

test('parseRunnerArgv 解析多个 --read-path', () => {
  const parsed = parseRunnerArgv([
    '--profile', 'PRTS.Test',
    '--workspace', 'C:\\ws',
    '--read-path', 'C:\\a',
    '--read-path', 'C:\\b',
    '--', 'pwsh', '-c', 'echo hi',
  ])
  assert.deepEqual(parsed.readPaths, ['C:\\a', 'C:\\b'])
  assert.equal(parsed.profile, 'PRTS.Test')
  assert.deepEqual(parsed.command, ['pwsh', '-c', 'echo hi'])
})

test('parseRunnerArgv 没有 --read-path 时返回空数组', () => {
  const parsed = parseRunnerArgv(['--profile', 'P', '--workspace', 'C:\\ws', '--', 'cmd'])
  assert.deepEqual(parsed.readPaths, [])
})

test('confine 与 runner 两端对得上（往返一致）', () => {
  const out = confine(['C:\\spill-a', 'C:\\spill-b'])
  const parsed = parseRunnerArgv(out.argv)
  assert.deepEqual(parsed.readPaths, ['C:\\spill-a', 'C:\\spill-b'])
  assert.equal(parsed.profile, 'PRTS.Test')
  assert.equal(parsed.workspace, 'C:\\ws')
})
