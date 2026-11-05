/**
 * NInfer ↔ DSH 协议适配代理（本地实验基础设施，不是产品代码）。
 *
 * 为什么需要它（2026-11-05 抓包实证）：
 * - DSH 的 `dsh-llm-deepseek` 适配器走 Anthropic `/v1/messages`，发出
 *   `"thinking":{"type":"enabled"}` 但**不带 `budget_tokens`**；
 * - NInfer 对 `thinking` 做严格校验：`enabled` 必须配 ≥1024 的整数
 *   `budget_tokens`，否则 400 `thinking.budget_tokens must be an integer of at least 1024`。
 *   Ollama 的 `/v1/messages` 兼容层忽略该字段，所以换端点后才暴露。
 * - 另外 DSH 按 `DSH_CONTEXT_WINDOW` 推 `max_tokens`（262144 窗口 → 256000），
 *   远超本地 27B 的单次输出能力。
 *
 * 本代理只做三件事，其余请求与响应（含 SSE 流）原样透传：
 * 1. `thinking.type === 'enabled'` 且缺 `budget_tokens` → 补 `THINKING_BUDGET`（默认 8192，
 *    与启动脚本 `--default-thinking-budget 8192` 一致）。
 * 2. `max_tokens` 超过 `MAX_OUTPUT_TOKENS`（默认 32768）→ 压到上限。
 * 3. 响应 usage 里的 `cache_creation_input_tokens` / `cache_read_input_tokens` 为 `null` 时
 *    改写为 0——NInfer 发 null，而 DSH 的流式解析要求 number，收到 null 报
 *    `MALFORMED_RESPONSE: invalid cache_creation_input_tokens`。
 *
 * 同一个代理对 OpenAI `/v1/chat/completions`（判分器用）透明转发，不改写。
 *
 * 用法：
 *   PORT=18201 UPSTREAM_PORT=18200 node scripts/ninfer-adapter.mjs
 *   LOCAL=1 LOCAL_BASE=http://127.0.0.1:18201 ... scripts/eval-v1-18-ab.mjs
 */
import { createServer, request } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.PORT ?? 18201)
const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 18200)
const THINKING_BUDGET = Number(process.env.THINKING_BUDGET ?? 8192)
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 32768)
const LOG = process.env.ADAPTER_LOG ?? 'C:/prts-benchmark/ninfer-adapter.log'

writeFileSync(LOG, '')
function log(entry) {
  appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
}
log({ event: 'start', PORT, UPSTREAM_PORT, THINKING_BUDGET, MAX_OUTPUT_TOKENS })

/** 只改 /v1/messages 的 body；解析失败就原样返回（让上游去报错，不吞错）。 */
function adaptBody(url, raw) {
  if (!url.startsWith('/v1/messages')) return { body: raw, patched: null }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { body: raw, patched: null } }
  const patched = {}
  if (parsed?.thinking?.type === 'enabled' && parsed.thinking.budget_tokens === undefined) {
    parsed.thinking.budget_tokens = THINKING_BUDGET
    patched.thinkingBudget = THINKING_BUDGET
  }
  if (typeof parsed?.max_tokens === 'number' && parsed.max_tokens > MAX_OUTPUT_TOKENS) {
    patched.maxTokensFrom = parsed.max_tokens
    parsed.max_tokens = MAX_OUTPUT_TOKENS
    patched.maxTokensTo = MAX_OUTPUT_TOKENS
  }
  if (patched.thinkingBudget === undefined && patched.maxTokensTo === undefined) return { body: raw, patched: null }
  return { body: JSON.stringify(parsed), patched }
}

/**
 * usage 的 null 计数改成 0。
 * Anthropic 官方允许这些字段为 null，NInfer 确实发 null；但 DSH 的解析把它们当 number。
 * 只改「null → 0」这一种情形，其它值一律不动。
 */
function patchUsage(obj) {
  const usage = obj?.usage ?? obj?.message?.usage
  if (!usage || typeof usage !== 'object') return false
  let changed = false
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (usage[key] === null) { usage[key] = 0; changed = true }
  }
  return changed
}

/** SSE 单行：只改 `data: {...}` 里的 usage，其它行原样返回。 */
function patchSseLine(line) {
  const trimmed = line.replace(/\r$/, '')
  if (!trimmed.startsWith('data:')) return line
  const payload = trimmed.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return line
  let obj
  try { obj = JSON.parse(payload) } catch { return line }
  return patchUsage(obj) ? `data: ${JSON.stringify(obj)}` : line
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const { body, patched } = adaptBody(req.url ?? '/', raw)
    log({ event: 'request', url: req.url, method: req.method, bytesIn: raw.length, patched })
    const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` }
    if (body !== raw) headers['content-length'] = String(Buffer.byteLength(body))
    const proxyReq = request({
      host: '127.0.0.1', port: UPSTREAM_PORT, path: req.url, method: req.method, headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      res.flushHeaders?.()
      const isAnthropic = (req.url ?? '').startsWith('/v1/messages')
      const contentType = String(proxyRes.headers['content-type'] ?? '')
      if (isAnthropic && contentType.includes('text/event-stream')) {
        // 流式：按行缓冲后改写 usage，跨 chunk 的行边界必须接住。
        proxyRes.setEncoding('utf8')
        let buffer = ''
        proxyRes.on('data', (chunk) => {
          buffer += chunk
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) res.write(`${patchSseLine(part)}\n`)
        })
        proxyRes.on('end', () => {
          if (buffer !== '') res.write(patchSseLine(buffer))
          res.end()
          log({ event: 'response', url: req.url, status: proxyRes.statusCode, streamed: true })
        })
      } else if (isAnthropic) {
        // 非流式：整体缓冲，改完再发（不能这时先 writeHead 后就 pipe）。
        const chunks = []
        proxyRes.on('data', (c) => chunks.push(c))
        proxyRes.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8')
          try {
            const obj = JSON.parse(text)
            if (patchUsage(obj)) text = JSON.stringify(obj)
          } catch { /* 非 JSON 响应原样发 */ }
          res.end(text)
          log({ event: 'response', url: req.url, status: proxyRes.statusCode, streamed: false })
        })
      } else {
        proxyRes.pipe(res)
        proxyRes.on('end', () => log({ event: 'response', url: req.url, status: proxyRes.statusCode }))
      }
    })
    proxyReq.on('error', (error) => {
      log({ event: 'proxy-error', url: req.url, message: String(error) })
      if (res.headersSent === false) {
        res.writeHead(502, { 'content-type': 'application/json' })
      }
      res.end(JSON.stringify({ error: { message: String(error), type: 'proxy_error' } }))
    })
    proxyReq.end(body)
  })
})

server.listen(PORT, '127.0.0.1', () => {
  log({ event: 'listening', url: `http://127.0.0.1:${PORT}` })
  console.log(`ninfer-adapter listening on http://127.0.0.1:${PORT} -> ${UPSTREAM_PORT}`)
  console.log(`thinking budget ${THINKING_BUDGET} / max output ${MAX_OUTPUT_TOKENS} / log ${LOG}`)
})
