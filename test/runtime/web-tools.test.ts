/**
 * Firecrawl 联网工具（search + fetch）。
 *
 * 为什么这条路可行：这两个工具的代码跑在 **serve 进程**里，用 `fetch` 直接打 HTTP。
 * pwsh 工具的断网是 restricted-token 沙箱造成的（移掉 Authenticated Users / INTERACTIVE
 * 导致 DNS Client 命名管道进不去），与本路径无关。
 *
 * 边界：查询内容会发到 Firecrawl（第三方）。`classify.ts:23` 会把工具名归到 net，
 * 但 `start.ts` 的 guard 目前只过滤 fs.* —— net 审批门尚未接线。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWebTools } from '../../src/runtime/web-tools.ts'

interface Captured {
  name: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function fakeRegistry(): { registry: { register(d: unknown): () => void }; get(name: string): Captured } {
  const defs = new Map<string, Captured>()
  return {
    registry: {
      register(d: unknown): () => void {
        const def = d as Captured
        defs.set(def.name, def)
        return () => { defs.delete(def.name) }
      },
    },
    get(name: string): Captured {
      const d = defs.get(name)
      if (d === undefined) throw new Error(`未注册的工具: ${name}（已注册 ${[...defs.keys()].join(',')}）`)
      return d
    },
  }
}

/** 记录请求并返回预设响应的假 fetch。 */
function fakeFetch(status: number, body: unknown): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test('WT1 prts_web_search：带 Bearer key 打 /v2/search，返回标题与 URL', async () => {
  const { impl, calls } = fakeFetch(200, {
    success: true,
    data: { web: [{ url: 'https://a.example/1', title: 'A', description: '摘要 A' }] },
  })
  const { registry, get } = fakeRegistry()
  createWebTools(registry as never, { apiKey: 'fc-test', fetchImpl: impl })

  const out = await get('prts_web_search').execute({ query: '莱茵生命 设计', limit: 3 }) as {
    results?: Array<{ url: string; title?: string; description?: string }>
  }

  assert.equal(calls.length, 1)
  assert.ok(calls[0]?.url.endsWith('/v2/search'), `应打 v2/search，实际 ${calls[0]?.url}`)
  const headers = calls[0]?.init?.headers as Record<string, string>
  const auth = headers.Authorization ?? headers.authorization
  assert.equal(auth, 'Bearer fc-test')
  const sent = JSON.parse(String(calls[0]?.init?.body)) as { query: string; limit: number }
  assert.equal(sent.query, '莱茵生命 设计')
  assert.equal(sent.limit, 3)

  assert.equal(out.results?.length, 1)
  assert.equal(out.results?.[0]?.url, 'https://a.example/1')
  assert.equal(out.results?.[0]?.title, 'A')
})

test('WT2 search 响应形状兼容：data.web / data[] / results[] 都能解析', async () => {
  const shapes: unknown[] = [
    { data: { web: [{ url: 'u1', title: 't1' }] } },
    { data: [{ url: 'u2', title: 't2' }] },
    { results: [{ url: 'u3', title: 't3' }] },
  ]
  for (const body of shapes) {
    const { impl } = fakeFetch(200, body)
    const { registry, get } = fakeRegistry()
    createWebTools(registry as never, { apiKey: 'k', fetchImpl: impl })
    const out = await get('prts_web_search').execute({ query: 'q' }) as { results?: Array<{ url: string }> }
    assert.equal(out.results?.length, 1, `形状 ${JSON.stringify(body).slice(0, 40)} 应解析出 1 条`)
  }
})

test('WT3 prts_web_fetch：打 /v2/scrape，返回 markdown 并按上限截断', async () => {
  const long = 'x'.repeat(5000)
  const { impl, calls } = fakeFetch(200, { success: true, data: { markdown: long, links: ['https://a'] } })
  const { registry, get } = fakeRegistry()
  createWebTools(registry as never, { apiKey: 'fc', fetchImpl: impl, maxChars: 100 })

  const out = await get('prts_web_fetch').execute({ url: 'https://example.com' }) as {
    url?: string
    markdown?: string
    truncated?: boolean
    links?: string[]
  }

  assert.ok(calls[0]?.url.endsWith('/v2/scrape'))
  const sent = JSON.parse(String(calls[0]?.init?.body)) as { url: string; formats: string[] }
  // URL 会被规范化（补尾部斜杠），比 hostname 而不是比原串
  assert.equal(new URL(sent.url).hostname, 'example.com')
  assert.deepEqual(sent.formats, ['markdown'])

  assert.equal(out.markdown?.length, 100, '应截断到 maxChars')
  assert.equal(out.truncated, true)
  assert.deepEqual(out.links, ['https://a'])
})

test('WT4 非 2xx 抛错并带状态码，不返回空结果', async () => {
  const { impl } = fakeFetch(401, { error: 'invalid token' })
  const { registry, get } = fakeRegistry()
  createWebTools(registry as never, { apiKey: 'bad', fetchImpl: impl })
  await assert.rejects(() => get('prts_web_search').execute({ query: 'q' }), /401/)
  await assert.rejects(() => get('prts_web_fetch').execute({ url: 'https://a' }), /401/)
})

test('WT5 空 query / 非 http(s) url 一律拒绝', async () => {
  const { impl } = fakeFetch(200, {})
  const { registry, get } = fakeRegistry()
  createWebTools(registry as never, { apiKey: 'k', fetchImpl: impl })

  await assert.rejects(() => get('prts_web_search').execute({ query: '   ' }), /query/)
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x', '']) {
    // 两种拒绝路径：空串走「url 不能为空」，非 http(s) 走协议校验
    await assert.rejects(() => get('prts_web_fetch').execute({ url: bad }), /url|http\/https/)
  }
})

test('WT6 search 结果条数受 limit 上限约束，不乱要', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ url: `u${i}`, title: `t${i}` }))
  const { impl, calls } = fakeFetch(200, { data: { web: many } })
  const { registry, get } = fakeRegistry()
  createWebTools(registry as never, { apiKey: 'k', fetchImpl: impl })
  const out = await get('prts_web_search').execute({ query: 'q', limit: 999 }) as { results?: unknown[] }
  const sent = JSON.parse(String(calls[0]?.init?.body)) as { limit: number }
  assert.ok(sent.limit <= 20, `limit 应被夹到 ≤20，实际 ${sent.limit}`)
  assert.ok((out.results?.length ?? 0) <= 20)
})
