/**
 * 测试并发隔离：AppContainer profile 名不能是全局常量。
 *
 * 事实（2026-11-03 复现）：同一台机器上并发跑两个 `node --test`，
 * `test/sandbox/` 里会有一个进程失败——
 *   `prts runner: CreateProcessW(AppContainer) 失败：C:\Windows\System32\cmd.exe`
 * 根因是 `src/sandbox/provider.ts:29` 把 profile 名硬编码成 `PRTS.Sandbox`，
 * 而 `deriveAppContainerSid(name)`（`appcontainer.ts:252`）把它派生成一个
 * Windows **用户级全局** SID。两个进程同时用它创建容器进程就会相互踩。
 *
 * 生产是单进程，不受影响；只有「同一台机器上并发跑测试」会暴露。
 *
 * 修法（本文件钉住的契约）：profile 名改成按环境解析——
 * 1. 显式覆盖 `PRTS_APPCONTAINER_PROFILE_NAME` 优先（给运维与特殊场景留口子）
 * 2. 检测到 node --test 上下文时按 pid 隔离，不改造生产行为
 * 3. 其余情况仍返回 `PRTS.Sandbox`
 *
 * 「按 pid 隔离」不是稳妥的权宜：`node --test` 每个测试文件是一个独立子进程，
 * pid 天然唯一，两个并发 runner 的 pid 必然不同。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRTS_APPCONTAINER_PROFILE,
  appContainerProfileName,
} from '../../src/sandbox/provider.ts'

type Env = Record<string, string | undefined>

test('PI1 生产默认不变：没有测试上下文也没有覆盖时，仍是 PRTS.Sandbox', () => {
  assert.equal(PRTS_APPCONTAINER_PROFILE, 'PRTS.Sandbox', '常量本身不能改，生产代码与文档都在引用它')
  assert.equal(appContainerProfileName({} as Env), 'PRTS.Sandbox')
})

test('PI2 显式覆盖优先', () => {
  assert.equal(appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: 'PRTS.Custom' } as Env), 'PRTS.Custom')
})

test('PI3 覆盖值两端空白被裁掉', () => {
  assert.equal(appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: '  PRTS.Custom  ' } as Env), 'PRTS.Custom')
})

test('PI4 空白覆盖值等于没给，回落默认', () => {
  assert.equal(appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: '   ' } as Env), 'PRTS.Sandbox')
  assert.equal(appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: '' } as Env), 'PRTS.Sandbox')
})

test('PI5 node --test 上下文里按 pid 隔离——两个并发 runner 不能共用一个 profile', () => {
  const name = appContainerProfileName({ NODE_TEST_CONTEXT: 'child-v8' } as Env)
  assert.notEqual(name, 'PRTS.Sandbox', '测试上下文里必须偏离全局默认名')
  assert.ok(name.startsWith('PRTS.Sandbox.Test-'), `应以 PRTS.Sandbox.Test- 开头，实得 ${name}`)
  assert.ok(name.includes(String(process.pid)), `名字里要带 pid，实得 ${name}`)
})

test('PI6 显式覆盖优先于测试上下文隔离', () => {
  const name = appContainerProfileName({
    PRTS_APPCONTAINER_PROFILE_NAME: 'PRTS.Explicit',
    NODE_TEST_CONTEXT: 'child-v8',
  } as Env)
  assert.equal(name, 'PRTS.Explicit')
})

test('PI7 同一进程内幂等：两次调用得到同一个名字', () => {
  const env = { NODE_TEST_CONTEXT: 'child-v8' } as Env
  assert.equal(appContainerProfileName(env), appContainerProfileName(env))
})

test('PI8 不带参数的调用等价于读 process.env（生产路径的形状）', () => {
  // 生产里调用方不传参：`appContainerProfileName()` 必须直接读 process.env。
  const name = appContainerProfileName()
  assert.equal(typeof name, 'string')
  assert.ok(name.length > 0)
})
