/**
 * server-side web_search 接线。
 *
 * 判据来自 2026-11-07 的实测：`type` 必须带日期后缀（裸 `web_search` 会 422），
 * 未启用时一个字段都不能注册（默认关闭是硬要求）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerWebSearch, webSearchTool } from '../../src/runtime/web-search.ts'

function fakeRegistry(): {
  register(field: string, provider: unknown): (() => Promise<void>)
  calls: Array<{ field: string; provider: unknown }>
} {
  const calls: Array<{ field: string; provider: unknown }> = []
  return {
    calls,
    register(field: string, provider: unknown) {
      calls.push({ field, provider })
      return async () => {}
    },
  }
}

test('WS1 webSearchTool：type 必须带日期后缀', () => {
  const tool = webSearchTool(3)
  assert.equal(tool.type, 'web_search_20250305', '裸 web_search 会被后端 422')
  assert.equal(tool.name, 'web_search')
  assert.equal(tool.max_uses, 3)
})

test('WS2 默认关闭：未启用时一个字段都不注册', () => {
  const prev = process.env.PRTS_WEB_SEARCH
  delete process.env.PRTS_WEB_SEARCH
  try {
    const reg = fakeRegistry()
    const off = registerWebSearch(reg)
    assert.equal(off, undefined, '未启用应返回 undefined')
    assert.equal(reg.calls.length, 0, '默认关闭是硬要求：不注册任何字段')
  } finally {
    if (prev !== undefined) process.env.PRTS_WEB_SEARCH = prev
  }
})

test('WS3 显式启用：注册 tools 字段，prepare 返回正确声明', async () => {
  const reg = fakeRegistry()
  const off = registerWebSearch(reg, { enabled: true, maxUses: 5 })
  assert.notEqual(off, undefined)
  assert.equal(reg.calls.length, 1)
  assert.equal(reg.calls[0]?.field, 'tools')
  const provider = reg.calls[0]?.provider as { prepare(): { value: unknown[] } }
  const prepared = provider.prepare()
  assert.deepEqual(prepared.value, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
})

test('WS4 maxUses 非法值回落 3，不做「挂了个不会用的工具」', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const reg = fakeRegistry()
    registerWebSearch(reg, { enabled: true, maxUses: bad })
    const provider = reg.calls[0]?.provider as { prepare(): { value: Array<{ max_uses: number }> } }
    assert.equal(provider.prepare().value[0]?.max_uses, 3, `maxUses=${bad} 应回落 3`)
  }
})

test('WS5 registry 缺失时返回 undefined，不抛错', () => {
  assert.equal(registerWebSearch(undefined, { enabled: true }), undefined)
})
