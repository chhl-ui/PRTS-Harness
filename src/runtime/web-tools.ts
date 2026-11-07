/**
 * Firecrawl 联网工具：`prts_web_search` / `prts_web_fetch`。
 *
 * 为什么这条路能通，而 pwsh 不能：这两个工具的代码跑在 **serve 进程**内，用 `fetch`
 * 直接打 HTTP。pwsh 工具断网的根因是 restricted-token 沙箱（`dsh-sandbox-windows-acl`
 * 把 `Authenticated Users` / `INTERACTIVE` 从令牌里移掉，DNS Client 命名管道就进不去），
 * 与本路径无关。
 *
 * **边界（重要）**：查询词与目标 URL 会发送到 Firecrawl（第三方）。
 * 授权按**真实出站**判定：`classify.ts` 的 PROXY_NET_HOSTS 把这两个工具固定映射到
 * `net:api.firecrawl.dev`——不是参数里的目标站点，因为抓页面是 Firecrawl 代取的，
 * 本机连接的始终是 Firecrawl。放行有两条路：`PRTS_NET_ALLOW` 白名单命中（桌面端
 * 默认已配 api.firecrawl.dev，静默放行），或经 E3 审批桥由所有者逐次批准
 * （`start.ts` 的 `tools/pre-execute` 已把 net 纳入）。白名单之外的域名仍会问人。
 *
 * **未逐字核实的点**：Firecrawl `/v2/search` 的响应形状没有拿到完整文档（页面被截断），
 * 所以 `readResults` 兼容 `data.web[]` / `data[]` / `results[]` 三种形态。
 * `/v2/scrape` 的 `{ success, data: { markdown } }` 是核实过的。
 */
import type { ToolRegistry } from './task-tools.ts'

export interface WebToolDeps {
  apiKey: string
  /** 覆盖 base，默认 `https://api.firecrawl.dev/v2`。 */
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** 单次 fetch 返回正文的字符上限，默认 20000。 */
  maxChars?: number
}

export interface WebTools {
  names: readonly string[]
  dispose(): void
}

const DEFAULT_BASE = 'https://api.firecrawl.dev/v2'
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 20
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_CHARS = 20_000

export interface WebResult {
  url: string
  title?: string
  description?: string
}

/** 从三种可能的响应形状里抠出结果数组。坏形状一律返回空数组，由调用方报「没结果」。 */
export function readResults(payload: unknown): WebResult[] {
  const pick = (v: unknown): WebResult[] => {
    if (!Array.isArray(v)) return []
    return v.flatMap((item) => {
      if (typeof item !== 'object' || item === null) return []
      const o = item as { url?: unknown; title?: unknown; description?: unknown; snippet?: unknown }
      if (typeof o.url !== 'string' || o.url === '') return []
      return [{
        url: o.url,
        ...(typeof o.title === 'string' ? { title: o.title } : {}),
        ...(typeof o.description === 'string'
          ? { description: o.description }
          : typeof o.snippet === 'string' ? { description: o.snippet } : {}),
      }]
    })
  }

  const root = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    data?: { web?: unknown } & Record<string, unknown>
    results?: unknown
  }
  return [
    ...pick(root.data?.web),
    ...pick(root.data),
    ...pick(root.results),
  ].filter((r, i, arr) => arr.findIndex((x) => x.url === r.url) === i)
}

/** 只放行 http/https；file: / javascript: / ftp: 一律拒。 */
export function assertHttpUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`prts_web_fetch: url 不是合法 URL：${raw.slice(0, 80)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`prts_web_fetch: 只允许 http/https，收到 ${u.protocol}`)
  }
  return u.toString()
}

export function createWebTools(tools: ToolRegistry, deps: WebToolDeps): WebTools {
  const disposers: (() => void)[] = []
  const names: string[] = []
  const base = (deps.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS

  const register = (definition: Record<string, unknown>): void => {
    const off = tools.register(definition)
    disposers.push(off)
    names.push(String(definition.name))
  }

  /** 统一的 POST：带 Bearer、超时、非 2xx 抛错并带状态码。 */
  const post = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`prts_web: Firecrawl ${path} HTTP ${res.status}: ${text.slice(0, 200)}`)
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new Error(`prts_web: Firecrawl ${path} 返回非 JSON：${text.slice(0, 120)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  register({
    name: 'prts_web_search',
    description:
      '联网搜索。返回若干网页的标题、URL 与摘要。'
      + '当问题涉及实时信息、外部资料、或你不确定的事实需要查证时使用。'
      + '注意：查询词会发送到第三方服务 Firecrawl。'
      + '拿到结果后如需正文，再用 prts_web_fetch 抓具体链接；不要凭标题臆测内容。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，用关键实体，不要整句照抄' },
        limit: { type: 'integer', description: `返回条数 1-${MAX_LIMIT}，默认 ${DEFAULT_LIMIT}` },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                title: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { query?: string; results?: WebResult[] }
        const list = v?.results ?? []
        if (list.length === 0) return [{ type: 'text', text: `「${v?.query ?? ''}」没有搜索结果。` }]
        const body = list
          .map((r, i) => `${i + 1}. ${r.title ?? '(无标题)'}\n   ${r.url}\n   ${(r.description ?? '').slice(0, 200)}`)
          .join('\n')
        return [{ type: 'text', text: `「${v?.query ?? ''}」的搜索结果：\n${body}` }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { query?: unknown; limit?: unknown }
      const query = typeof a.query === 'string' ? a.query.trim() : ''
      if (query === '') {
        throw new Error('prts_web_search: query 不能为空')
      }
      const rawLimit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.floor(a.limit) : DEFAULT_LIMIT
      const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit))

      const payload = await post('/search', { query, limit, sources: [{ type: 'web' }] })
      const results = readResults(payload).slice(0, limit)
      return { query, results }
    },
  })

  register({
    name: 'prts_web_fetch',
    description:
      '抓取指定网页的正文（Markdown）。当你知道确切 URL、需要读全文或核对细节时使用。'
      + '只接受 http/https。正文超过上限会被截断，返回里 truncated=true 表示被截过。'
      + '注意：目标 URL 会发送到第三方服务 Firecrawl。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的网页地址，必须 http/https' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          markdown: { type: 'string' },
          truncated: { type: 'boolean' },
          links: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: unknown) => {
        const v = value as { url?: string; markdown?: string; truncated?: boolean }
        const tail = v?.truncated === true ? '\n\n[正文已截断]' : ''
        return [{ type: 'text', text: `${v?.url ?? ''}\n\n${v?.markdown ?? '(空)'}${tail}` }]
      },
    },
    execute: async (args: unknown): Promise<unknown> => {
      const a = (args ?? {}) as { url?: unknown }
      const raw = typeof a.url === 'string' ? a.url.trim() : ''
      if (raw === '') throw new Error('prts_web_fetch: url 不能为空')
      const url = assertHttpUrl(raw)

      const payload = await post('/scrape', { url, formats: ['markdown'] })
      const data = (payload as { data?: { markdown?: unknown; content?: unknown; links?: unknown } })?.data ?? {}
      const markdown = typeof data.markdown === 'string'
        ? data.markdown
        : typeof data.content === 'string' ? data.content : ''
      const truncated = markdown.length > maxChars
      const links = Array.isArray(data.links)
        ? (data.links as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 50)
        : []

      return {
        url,
        markdown: truncated ? markdown.slice(0, maxChars) : markdown,
        truncated,
        links,
      }
    },
  })

  return {
    names,
    dispose: () => {
      for (const off of disposers.splice(0)) {
        try { off() } catch { /* 注销失败不阻断停机 */ }
      }
      names.length = 0
    },
  }
}
