/**
 * O1 回归：真实 deepseek 适配器（dsh-llm-deepseek-api-key）+ 本地假 HTTP 端点。
 *
 * 缺陷形态：驱动路径（test/support/drive.ts）把裸 { content, source } 当消息交给
 * agent.followup，缺 role 字段。适配器 serialize 里 `previous?.role === wireRole`
 * 在首元素上双 undefined 相等 → `previous.content` 抛 TypeError（TRANSPORT），
 * 请求一条都发不出去；非首元素则不抛，静默写出 role:undefined 的 wire message。
 *
 * 两个观测口分开（互不替代）：
 *   hits         —— 假端点收到的请求数（证明请求真的发出去了）
 *   adapterInputs—— 进适配器的 request.messages（证明每个元素 role 合法）
 * 若只观测假端点，hits=0 时根本没有 messages 可查，无法区分「没发请求」与「结构错」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { runTurn } from '../support/drive.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

/** 模型可见的全部合法 role（dsh-llm MessageRoleMap 的键）。 */
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

interface AdapterRequest {
  provider?: string
  model?: string
  messages?: { role?: unknown; content?: unknown }[]
}

/** 第一个 role 非法（缺失/非枚举值）的元素下标；全部合法返回 -1。 */
function firstBadRoleIndex(messages: { role?: unknown }[] | undefined): number {
  if (!Array.isArray(messages)) return 0
  for (let i = 0; i < messages.length; i++) if (!ROLES.has(messages[i]?.role as string)) return i
  return -1
}

const snap = (v: unknown): unknown => {
  try { return JSON.parse(JSON.stringify(v)) } catch { return v }
}

test('O1: 真实适配器经驱动路径 → 假端点收到请求，且进适配器的 messages role 齐全', { skip: !WIN, timeout: 120000 }, async () => {
  const t = makeTmp('prts-o1-')
  const http = await import('node:http')
  let hits = 0
  const wireBodies: AdapterRequest[] = []
  const srv = http.createServer((req, res) => {
    hits++
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try { wireBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as AdapterRequest) } catch { wireBodies.push({}) }
      // 400 = 确定性失败：不诱发重试，同时保证 hits 计数稳定为「至少一次」。
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fake endpoint: o1 probe', type: 'fake' } }))
    })
  })
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as { port: number }).port

  const adapterInputs: AdapterRequest[] = []
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    const dataRoot = join(t.dir, 'data')
    const ws = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(ws, { recursive: true })
    // 只挂真实适配器：不注册 scripted-llm（否则 DUPLICATE_ADAPTER）。
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
      credentials: { DEEPSEEK_API_KEY: 'test-key-123' },
      patches: [{ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${port}/` } }],
    })

    // 观测口：agent-loop 走 llm.prepareCall(...).stream(request)，非 NO_ADAPTER 时
    // 不会落到 llm.stream，故两处都包一层，保持 request 原对象透传。
    const llm = (app.ctx as Context).get('llm') as unknown as {
      prepareCall(c: unknown, s?: unknown): Promise<{ stream(o: unknown): unknown } & Record<string, unknown>>
      stream(o: unknown): unknown
    }
    const origPrepare = llm.prepareCall.bind(llm)
    llm.prepareCall = async (c: unknown, s?: unknown) => {
      const prepared = await origPrepare(c, s)
      return {
        ...prepared,
        stream: (o: unknown) => {
          adapterInputs.push(snap(o) as AdapterRequest)
          return prepared.stream(o)
        },
      }
    }
    const origStream = llm.stream.bind(llm)
    llm.stream = (o: unknown) => {
      adapterInputs.push(snap(o) as AdapterRequest)
      return origStream(o)
    }

    // 驱动路径：runTurn 内部 followup 一条用户消息 → 适配器 → 假端点。
    // 轮次失败是预期的（假端点 400），只断言发出与结构，不断言轮次结果。
    await runTurn(app.ctx as Context, 'o1 probe', { cwd: ws })

    const observed = adapterInputs.map(r => ({
      provider: r.provider,
      model: r.model,
      roles: (r.messages ?? []).map(m => m?.role ?? '<missing>'),
    }))
    console.log('[O1] hits =', hits, '| adapterInputs =', adapterInputs.length, '| roles =', JSON.stringify(observed))

    // (0) 反空断言：适配器一次都没被调用时 firstBadRoleIndex 恒为 -1，绿是假的。
    assert.ok(adapterInputs.length >= 1, `适配器未被调用（hits=${hits}），无法判定 messages 结构`)
    // (a) 假端点真的收到请求。
    assert.ok(hits >= 1, `假端点收到 ${hits} 次请求（期望 ≥1）；roles=${JSON.stringify(observed)}`)
    // (b) 进适配器的每个 messages 元素 role 合法（覆盖「不崩溃但发错结构」的第二形态）。
    for (const [i, r] of adapterInputs.entries()) {
      const bad = firstBadRoleIndex(r.messages)
      assert.equal(bad, -1, `第 ${i} 次适配器调用 messages[${bad}].role 非法：${JSON.stringify(r.messages?.map(m => m?.role ?? '<missing>'))}`)
      assert.ok((r.messages?.length ?? 0) >= 2, `第 ${i} 次适配器调用 messages 过短：${r.messages?.length}`)
    }
    // 线上 payload 同样要求 role 合法（structure 错误的第二道口）。
    for (const [i, b] of wireBodies.entries()) {
      const bad = firstBadRoleIndex(b.messages)
      assert.equal(bad, -1, `第 ${i} 个线上请求 messages[${bad}].role 非法`)
    }
  } finally {
    srv.close()
    if (app) await app.dispose()
    t.cleanup()
  }
})
