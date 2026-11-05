/**
 * 记忆模块：向量化与相似度。
 *
 * 为什么需要（v2.17 对照实验，2026-11-01）：
 *   120 条归纳画像 × 3 道 preference 题，目标画像在 bm25 下的排名是 16 / 未命中 / 未命中，
 *   bm25 分数从 0.0213 平铺到 0.0191（区分度 <12%）——在短画像上基本失去分辨力。
 *   同一批数据换向量余弦，目标画像排名 4 / 1 / 14，top-8 可答性由 0/3 变为 2/3。
 *
 * 边界：向量只对**派生项**（fact / profile）生效，不对 turn 生效。
 *   turn 是 24.6 万级，全量余弦不划算；且 turn 检索的瓶颈在粒度不在语义（v2.11 已证）。
 *
 * 传输格式：SQLite 用 BLOB 存 float32 **小端**。必须显式指定字节序——
 * `Float32Array` 的底层视图跟随平台，换机器读同一份库会得到乱码向量且不报错。
 */

/** 向量化后端。`model` 参与向量表的主键语义：换模型必须重算，不能混用。 */
export interface Embedder {
  readonly model: string
  embed(texts: string[]): Promise<number[][]>
}

export interface OllamaEmbedderOptions {
  /** 默认 `http://127.0.0.1:11434`。 */
  baseUrl?: string
  /** 默认 `bge-m3`（本机已装，1024 维，CPU 推理约 20ms/条）。 */
  model?: string
  /** 单次请求超时，默认 30s。**超时要抛错**，不能静默返回零向量。 */
  timeoutMs?: number
  /** 便于测试注入。 */
  fetchImpl?: typeof fetch
}

/**
 * 本地 Ollama 后端。
 *
 * 选它而不是云端：DeepSeek 没有 embedding 端点（`/v1/embeddings` 404，2026-11-01 实测），
 * 而本地推理零成本、不消耗用户 API key——用户的硬约束是「非必要不要调 PRTS 的 key」。
 */
export class OllamaEmbedder implements Embedder {
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OllamaEmbedderOptions = {}) {
    // 不用参数属性：项目只允许可擦除语法（AGENTS.md「语法约束」）。
    this.model = opts.model ?? 'bge-m3'
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * 批量向量化。用 `/api/embed`（批量端点）而不是 `/api/embeddings`（单条）——
   * 后者 120 条要走 120 次往返，本机实测单条 56ms、批量几乎线性摊薄。
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        throw new Error(`memory: embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const j = await res.json() as { embeddings?: unknown }
      const vecs = j.embeddings
      if (!Array.isArray(vecs) || vecs.length !== texts.length) {
        throw new Error(`memory: embedding 返回形状不对，期望 ${texts.length} 条`)
      }
      for (const v of vecs) {
        if (!Array.isArray(v) || v.length === 0) throw new Error('memory: embedding 返回空向量')
      }
      return vecs as number[][]
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface OpenAiCompatibleEmbedderOptions {
  /** 默认 `http://127.0.0.1:11435`（llama.cpp `llama-server --embedding`）。 */
  baseUrl?: string
  /** 默认 `bge-m3`。维度由模型决定（bge-m3 = 1024）。 */
  model?: string
  /** 单次请求超时，默认 30s。**超时要抛错**，不能静默返回零向量。 */
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * OpenAI 兼容后端（llama.cpp / vLLM 等）。
 *
 * 与 `OllamaEmbedder` 的差别只有两处：路径 `/v1/embeddings`、响应形状
 * `{data: [{embedding}]}`。维度由模型决定——实测 llama.cpp 下 bge-m3 仍为
 * **1024 维**，与 Ollama 侧一致，所以换后端不需要重算向量表。
 *
 * 为什么要它（2026-11-05）：`OllamaEmbedder` 打的是 Ollama 专有端点
 * `{base}/api/embed`，模型提供方一旦不是 Ollama（NInfer / Strata 都没有
 * embedding 端点，实测 404），向量路就没有后端可用。
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAiCompatibleEmbedderOptions = {}) {
    this.model = opts.model ?? 'bge-m3'
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11435').replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: ctrl.signal,
      })
      if (!res.ok) {
        throw new Error(`memory: embedding HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const j = await res.json() as { data?: unknown }
      const rows = j.data
      if (!Array.isArray(rows) || rows.length !== texts.length) {
        throw new Error(`memory: embedding 返回形状不对，期望 ${texts.length} 条`)
      }
      const out: number[][] = []
      for (const row of rows) {
        const v = (row as { embedding?: unknown })?.embedding
        if (!Array.isArray(v) || v.length === 0) throw new Error('memory: embedding 返回空向量')
        out.push(v as number[])
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  }
}

/** float32 小端 BLOB 编码。用 DataView 显式定序，不依赖平台字节序。 */
export function encodeVector(v: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(v.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < v.length; i++) dv.setFloat32(i * 4, v[i], true)
  return out
}

/** 与 `encodeVector` 成对的解码。长度不是 4 的倍数说明 BLOB 已损坏，直接报错。 */
export function decodeVector(b: Uint8Array): Float32Array {
  if (b.length % 4 !== 0) throw new Error(`memory: 向量 BLOB 长度 ${b.length} 不是 4 的倍数`)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out = new Float32Array(b.length / 4)
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true)
  return out
}

/**
 * 余弦相似度。维度不等时抛错而不是截断——静默截断会让「换了模型但没重算」
 * 这种错误变成「分数莫名变低」，排查成本远高于一次显式失败。
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) {
    throw new Error(`memory: 向量维度不一致 ${a.length} vs ${b.length}（换模型后必须重算向量）`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}
