/**
 * 密钥来源的优先级。
 *
 * 目标是尽量让明文 key 不出现在磁盘上（这是模型 shell 用 `Get-Content`
 * 就能读到的唯一位置）。优先级按「被随手读到的门槛」从高到低：
 *
 *  1. 凭据管理器（Windows Credential Manager / DPAPI 保护）——磁盘上无明文，
 *     要提取必须写代码调 CredRead，不能 `type` 一下就读走
 *  2. 环境变量——读后必须立刻从本进程环境里删除，否则派生的子进程会继承
 *  3. 文件——向后兼容保留，但会带警告
 *
 * 诚实边界：同用户下的任何持久化存储，理论上都能被同用户的恶意进程提取。
 * 本模块做到的是消除「明文文件可被随手读」，不是消除「同用户主动提取」。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadApiKey } from '../../src/cli/secret.ts'
import type { SecretDeps } from '../../src/cli/secret.ts'

const TARGET = 'PRTS/DeepSeek'
const KEYFILE = 'C:\\prts-data\\secrets\\deepseek.key'
const ENV = 'DEEPSEEK_API_KEY'

function deps(o: {
  cred?: string
  env?: string
  file?: string
  cleared?: string[]
}): SecretDeps {
  return {
    readCredential: () => o.cred,
    readEnv: () => o.env,
    clearEnv: (name) => { o.cleared?.push(name) },
    readFile: () => o.file,
  }
}

describe('loadApiKey', () => {
  it('凭据管理器有值时优先用它，且不再碰文件', () => {
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: deps({ cred: 'key-from-cred', env: 'key-from-env', file: 'key-from-file' }),
    })
    assert.equal(r.key, 'key-from-cred')
    assert.equal(r.source, 'credential')
    assert.deepEqual(r.warnings, [], '凭据管理器路径不该有警告')
  })

  it('凭据为空时回退到环境变量，并且读到后必须清除它', () => {
    const cleared: string[] = []
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: deps({ env: 'key-from-env', file: 'key-from-file', cleared }),
    })
    assert.equal(r.key, 'key-from-env')
    assert.equal(r.source, 'env')
    assert.deepEqual(cleared, [ENV], '读到后必须从进程环境删除，否则子进程会继承')
  })

  it('只剩文件时使用它，但必须给出警告', () => {
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: deps({ file: 'key-from-file' }),
    })
    assert.equal(r.key, 'key-from-file')
    assert.equal(r.source, 'file')
    assert.equal(r.warnings.length, 1, '文件路径必须带警告')
    assert.match(r.warnings[0], /模型 shell/, '警告要说明为什么危险')
  })

  it('空白值视为不存在，继续向下回退', () => {
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: { ...deps({ env: '   ', file: 'key-from-file' }), readCredential: () => '' },
    })
    assert.equal(r.source, 'file')
    assert.equal(r.key, 'key-from-file')
  })

  it('三处都没有时返回 none 且 key 为 undefined，不抛错', () => {
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: deps({}),
    })
    assert.equal(r.key, undefined)
    assert.equal(r.source, 'none')
    assert.equal(r.warnings.length, 1, '没有 key 时必须给出可操作的提示')
  })

  it('凭据管理器抛错（非 Windows / 无 PowerShell）时不让启动失败', () => {
    const d: SecretDeps = {
      readCredential: () => { throw new Error('PowerShell not found') },
      readEnv: () => undefined,
      clearEnv: () => {},
      readFile: () => 'key-from-file',
    }
    const r = loadApiKey({ target: TARGET, keyFile: KEYFILE, envName: ENV, deps: d })
    assert.equal(r.source, 'file', '凭据管理器不可用时应降级，而不是抛错')
    assert.equal(r.key, 'key-from-file')
  })

  it('返回值里永远不回显 key 本身到 warnings', () => {
    const r = loadApiKey({
      target: TARGET,
      keyFile: KEYFILE,
      envName: ENV,
      deps: deps({ file: 'super-secret-value' }),
    })
    for (const w of r.warnings) {
      assert.equal(w.includes('super-secret-value'), false, '警告文本不得包含密钥内容')
    }
  })
})
