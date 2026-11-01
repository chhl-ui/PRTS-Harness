/**
 * confine() 的纯逻辑回归。
 *
 * 这里不启 cordis、不建容器——只验「包装出来的 argv 与四个字段对不对」。
 * 真实执行由 runner.test.ts 覆盖（那边会真的跑起 AppContainer 子进程）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RUNNER_EXIT_SOFTWARE,
  RUNNER_EXIT_USAGE,
  RUNNER_FAILURE_PREFIX,
  confineArgv,
  workspaceTraversalRisk,
} from '../../src/sandbox/confine.ts'

const RUNNER = 'C:\\prts-system\\src\\sandbox\\runner.ts'
const WS = 'C:\\prts-workspace'

function base(over: Partial<Parameters<typeof confineArgv>[1]> = {}) {
  return {
    mode: 'workspace-write' as const,
    workspaceRoot: WS,
    profile: 'PRTS.Sandbox',
    runnerPath: RUNNER,
    execPath: 'C:\\node.exe',
    ...over,
  }
}

test('confine: 产出 runner 形态的 argv，顺序为 exec → runner → 选项 → 分隔符 → 调用方', () => {
  const out = confineArgv(['cmd.exe', '/c', 'echo hi'], base())
  assert.deepEqual(out.argv, [
    'C:\\node.exe',
    RUNNER,
    '--profile', 'PRTS.Sandbox',
    '--workspace', WS,
    '--',
    'cmd.exe', '/c', 'echo hi',
  ])
})

test('confine: enforcement=partial，denialSignatures 为空，runnerFailureRules 认 64/70', () => {
  const out = confineArgv(['cmd.exe', '/c', 'x'], base())
  // 文件效果能管住，但网络默认关闭未逐项验证 → partial，不能写成 full 让上游以为绝对边界
  assert.equal(out.enforcement, 'partial')
  // 越界错误文本随系统语言变化，没有可靠签名；留空，禁掉文本嗅探
  assert.deepEqual(out.denialSignatures, [])
  assert.equal(out.runnerFailureRules.length, 1)
  const rule = out.runnerFailureRules[0]
  assert.deepEqual(rule.allowedExitCodes, [RUNNER_EXIT_USAGE, RUNNER_EXIT_SOFTWARE])
  assert.deepEqual(rule.fatalSignatures, [RUNNER_FAILURE_PREFIX])
})

test('confine: 拒绝 %TEMP% 下的 workspace（AppContainer 无法 traverse 祖先链）', () => {
  const tempWs = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\prts-ws'
  assert.ok(workspaceTraversalRisk(tempWs) !== undefined, '%TEMP% 下的路径应被识别为有风险')
  assert.throws(
    () => confineArgv(['cmd.exe', '/c', 'x'], base({ workspaceRoot: tempWs })),
    /traverse|浅层/,
    '应当在包装阶段就 fail-closed，而不是等 PowerShell 报「当前目录无效」',
  )
})

test('confine: 浅层 workspace 不被误判', () => {
  for (const ws of ['C:\\prts-workspace', 'D:\\work', 'C:\\']) {
    assert.equal(workspaceTraversalRisk(ws), undefined, `${ws} 不该被判为有风险`)
  }
})

test('confine: 非法输入一律 fail-closed', () => {
  assert.throws(() => confineArgv([], base()), /非空的 argv/)
  assert.throws(
    () => confineArgv(['cmd'], base({ mode: 'danger-full-access' as never })),
    /不接受模式/,
    'danger-full-access 不该被 confine 接受——它根本不该走到这里',
  )
  assert.throws(() => confineArgv(['cmd'], base({ workspaceRoot: 'relative\\path' })), /绝对的 workspaceRoot/)
  assert.throws(() => confineArgv(['cmd'], base({ profile: '' })), /非空的 profile/)
  assert.throws(() => confineArgv(['cmd'], base({ runnerPath: 'runner.ts' })), /绝对的 runnerPath/)
})
