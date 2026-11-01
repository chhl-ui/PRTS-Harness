import test from 'node:test'

import assert from 'node:assert/strict'

import { localBackendWarning } from '../../src/sandbox/confine.ts'

/**
 * local 后端在 `C:\` 下的 workspace 上 shell 起不来（`grantWrite` 的
 * SetNamedSecurityInfoW 返回 Win32 5，见 AGENTS.md）。而它恰好是对应测试
 * 之外的**默认**配置，任何人 clone 下来直接跑都会撞上，且报错指向的地方和
 * 真实原因隔了两层。
 *
 * 这里钉住启动警告的判定：默认后端 + 会失败的 workspace 位置 → 必须提醒。
 */

test('local 后端 + C:\\ 下的 workspace → 给出警告', () => {
  const w = localBackendWarning('local', 'C:\\prts-workspace')
  assert.ok(w !== undefined, '应当警告')
  assert.match(w, /PRTS_SANDBOX_BACKEND/, '警告里要给出可执行的开关名')
  assert.match(w, /appcontainer/, '警告里要指出改用哪个后端')
})

test('local 后端 + %TEMP% 下的 workspace → 不警告（那个位置 local 能用）', () => {
  assert.equal(localBackendWarning('local', 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\prts-x\\ws'), undefined)
})

test('appcontainer 后端 → 任何位置都不警告', () => {
  assert.equal(localBackendWarning('appcontainer', 'C:\\prts-workspace'), undefined)
})

test('警告里要提到生效前提（授权脚本或 env），不能只说「可能不可用」', () => {
  const w = localBackendWarning('local', 'C:\\prts-workspace')
  assert.ok(w !== undefined)
  assert.match(w, /grant-sandbox-read|read-path|授权/, '警告应指出还需要一次读授权')
})
