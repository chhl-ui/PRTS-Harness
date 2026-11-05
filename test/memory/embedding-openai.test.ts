/**
 * OpenAI 兼容 embedding 后端（llama.cpp / vLLM 等）：`POST /v1/embeddings`。
 *
 * 为什么需要它（2026-11-05）：现有 `OllamaEmbedder` 打的是 `{base}/api/embed`，
 * 那是 Ollama 专有端点，响应是 `{embeddings: number[][]}`。要摆脱 Ollama 就得补
 * 一个走 OpenAI 标准形状（`{data: [{embedding}]}`）的实现。实测 llama.cpp
 * `llama-server --embedding` 返回 1024 维，与 bge-m3 在 Ollama 下的维度一致，
 * 向量表无需重算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAiCompatibleEmbedder } from '../../src/memory/embedding.ts'

/** 造一个记录请求并返回指定响应的 fetch 替身。 */
function fakeFetch(payload: unknown, status = 200): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; body: unknown }>
} {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetchImpl, calls }
}

test('E1 走 /v1/embeddings，按 OpenAI 形状解析 data[].embedding', async () => {
  const { fetchImpl, calls } = fakeFetch({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] })
  const e = new OpenAiCompatibleEmbedder({ baseUrl: 'http://127.0.0.1:11435', fetchImpl })
  const vecs = await e.embed(['甲', '乙'])
  assert.deepEqual(vecs, [[0.1, 0.2], [0.3, 0.4]])
  assert.equal(calls[0]?.url, 'http://127.0.0.1:11435/v1/embeddings')
  assert.deepEqual(calls[0]?.body, { model: 'bge-m3', input: ['甲', '乙'] })
})

test('E2 返回条数与输入不符时抛错（不返回半份向量）', async () => {
  const { fetchImpl } = fakeFetch({ data: [{ embedding: [0.1] }] })
  const e = new OpenAiCompatibleEmbedder({ fetchImpl })
  await assert.rejects(() => e.embed(['甲', '乙']), /返回形状不对/)
})

test('E3 空向量抛错', async () => {
  const { fetchImpl } = fakeFetch({ data: [{ embedding: [] }] })
  const e = new OpenAiCompatibleEmbedder({ fetchImpl })
  await assert.rejects(() => e.embed(['甲']), /空向量/)
})

test('E4 HTTP 非 2xx 抛错且带状态码（不静默返回零向量）', async () => {
  const { fetchImpl } = fakeFetch({ error: 'boom' }, 500)
  const e = new OpenAiCompatibleEmbedder({ fetchImpl })
  await assert.rejects(() => e.embed(['甲']), /HTTP 500/)
})
