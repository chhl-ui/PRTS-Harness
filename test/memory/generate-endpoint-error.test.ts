/**
 * 摘要生成端连不上时，错误必须可诊断。
 *
 * ## 现场（2026-11-09 真机）
 *
 * 模型在真实会话里两次尝试 `prts_memory_summarize`，两次都只拿到 `fetch failed`，
 * 于是它只能说「会话摘要写两次都返回 fetch failed」，没有任何可行动信息。
 *
 * 根因探针实测：
 *
 * ```
 * message   : fetch failed                 ← undici 的包装
 * cause.code: ECONNREFUSED
 * cause.msg : connect ECONNREFUSED 127.0.0.1:8080
 * ```
 *
 * 真原因在 `cause` 里，而 `memory-tools.ts` 的「本地模型可能未启动」提示是**死代码**——
 * `deps.generator()` 永远返回一个 `OpenAIGenerator` 实例（构造不发请求），
 * 所以那个 `undefined` 分支永不触发。
 *
 * 这里钉住的不是「服务起没起」，而是「连不上时说的话能不能用」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OllamaGenerator, OpenAIGenerator } from '../../src/memory/generate.ts'

/** 造一个 undici 风格的连接失败：message 是 fetch failed，真原因在 cause。 */
function connRefused(): Error {
  const e = new TypeError('fetch failed')
  ;(e as unknown as { cause: unknown }).cause = {
    code: 'ECONNREFUSED',
    message: 'connect ECONNREFUSED 127.0.0.1:8080',
  }
  return e
}

test('GE1 连不上端点：错误带 baseUrl 与 cause code，而不是裸 fetch failed', async () => {
  const g = new OpenAIGenerator({
    baseUrl: 'http://127.0.0.1:8080/v1',
    fetchImpl: (async () => { throw connRefused() }) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => g.generate('说一个字'),
    (err: Error) => {
      assert.notEqual(err.message, 'fetch failed', '不得原样透出 undici 的包装消息')
      assert.match(err.message, /127\.0\.0\.1:8080/, `消息里要有实际连的地址：${err.message}`)
      assert.match(err.message, /ECONNREFUSED/, `消息里要有 cause code：${err.message}`)
      assert.match(err.message, /PRTS_SUMMARY_BASE|未启动/, `要给出下一步：${err.message}`)
      assert.ok((err as { cause?: unknown }).cause !== undefined, '原始错误要挂在 cause 上，便于排查')
      return true
    },
  )
})

test('GE2 HTTP 非 2xx 的错误消息保持不变（不误伤既有路径）', async () => {
  const g = new OpenAIGenerator({
    baseUrl: 'http://x/v1',
    fetchImpl: (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch,
  })
  await assert.rejects(() => g.generate('x'), /HTTP 502/)
})

test('GE3 Ollama 路径同样翻译连接失败——不是只有 OpenAI 那条被包装', async () => {
  const g = new OllamaGenerator({
    baseUrl: 'http://127.0.0.1:11434',
    fetchImpl: (async () => { throw connRefused() }) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => g.generate('x'),
    (err: Error) => {
      assert.notEqual(err.message, 'fetch failed', '不得原样透出 undici 的包装消息')
      assert.match(err.message, /11434/, `要指出实际端点：${err.message}`)
      assert.match(err.message, /Ollama/, `要指出该起什么：${err.message}`)
      return true
    },
  )
})
