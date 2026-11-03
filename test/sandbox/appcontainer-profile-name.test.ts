/**
 * `appContainerProfileName` 的边界与失败路径。
 *
 * `profile-isolation.test.ts` 钉住主契约（生产默认 / 覆盖优先 / pid 隔离 / 幂等）；
 * 这里补它没覆盖的边界：制表符与换行、空串、键存在但值为 undefined、无原型对象、
 * 原型链键名，以及「覆盖值只被裁一次、不被二次加工」这类 trim 实现容易写错的地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRTS_APPCONTAINER_PROFILE,
  appContainerProfileName,
} from '../../src/sandbox/provider.ts'

type Env = Record<string, string | undefined>
const TEST_NAME = 'PRTS.Sandbox.Test-'

test('B1 覆盖值两端的制表符/换行也被裁掉（不只是空格）', () => {
  assert.equal(appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: '\t PRTS.X \r\n' } as Env), 'PRTS.X')
})

test('B2 覆盖值只有制表符/换行也算没给，回落默认', () => {
  assert.equal(
    appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: '\t\n ' } as Env),
    PRTS_APPCONTAINER_PROFILE,
  )
})

test('B3 键存在但值为 undefined：两档都回落默认', () => {
  assert.equal(
    appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: undefined } as Env),
    PRTS_APPCONTAINER_PROFILE,
  )
  assert.equal(
    appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: undefined, NODE_TEST_CONTEXT: undefined } as Env),
    PRTS_APPCONTAINER_PROFILE,
  )
})

test('B4 NODE_TEST_CONTEXT 为空串或纯空白：不触发测试隔离', () => {
  assert.equal(appContainerProfileName({ NODE_TEST_CONTEXT: '' } as Env), PRTS_APPCONTAINER_PROFILE)
  assert.equal(appContainerProfileName({ NODE_TEST_CONTEXT: ' \t' } as Env), PRTS_APPCONTAINER_PROFILE)
})

test('B5 pid 后缀就是十进制 process.pid，且名字里只出现一次 Test-', () => {
  const name = appContainerProfileName({ NODE_TEST_CONTEXT: 'child' } as Env)
  assert.equal(name, `${PRTS_APPCONTAINER_PROFILE}.Test-${process.pid}`)
  assert.equal(name.split('.Test-').length, 2, `Test- 只应出现一次：${name}`)
})

test('B6 无原型对象与原型链键名都不影响解析', () => {
  const bare = Object.create(null) as Env
  bare.NODE_TEST_CONTEXT = 'child-v8'
  assert.ok(appContainerProfileName(bare).startsWith(TEST_NAME))

  // constructor / __proto__ 作为键名不能被当成「已知的 profile 名」而误命中。
  const tricky = { constructor: 'PRTS.Bogus', __proto__: 'PRTS.Bogus' } as unknown as Env
  assert.equal(appContainerProfileName(tricky), PRTS_APPCONTAINER_PROFILE)
})

test('B7 覆盖值只裁空白、不做二次加工（自带 .Test- 也原样返回）', () => {
  assert.equal(
    appContainerProfileName({ PRTS_APPCONTAINER_PROFILE_NAME: ' PRTS.Sandbox.Test-1 ' } as Env),
    'PRTS.Sandbox.Test-1',
  )
})

test('B8 不传参与显式传 process.env 等价', () => {
  assert.equal(appContainerProfileName(), appContainerProfileName(process.env as Env))
  assert.equal(appContainerProfileName(undefined as unknown as Env), appContainerProfileName(process.env as Env))
})
