/**
 * 记忆模块：文本生成后端（巩固管线的模型层）。
 *
 * 与 `embedding.ts` 的 `Embedder` 同构：抽象出接口，生产用本地 Ollama，
 * 测试注入假实现——否则每个巩固用例都要起一个 27B 模型，测试会变成不可跑。
 */

export interface TextGenerator {
  readonly model: string
  generate(prompt: string): Promise<string>
}

export interface OllamaGeneratorOptions {
  baseUrl?: string
  model?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 本地 Ollama 生成后端。
 *
 * **必须传 `think: false`**：实测 2026-11-02，qwen3 这类带 thinking 的模型在默认模式下
 * 会把 `num_predict` 全部烧在思考过程上，输出被截断，一条 JSON 都拿不到
 * （451 token 全是推理，`/no_think` 后缀也无效）。关掉后 4.2 秒/批、输出合法。
 */
export class OllamaGenerator implements TextGenerator {
  readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: OllamaGeneratorOptions = {}) {
    // 不用参数属性：项目只允许可擦除语法（AGENTS.md「语法约束」）。
    this.model = opts.model ?? 'q38-gsq-iq3s'
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? 300_000
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async generate(prompt: string): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          think: false,
          options: { num_predict: 1500, temperature: 0 },
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`memory: generate HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const j = await res.json() as { response?: unknown }
      if (typeof j.response !== 'string') throw new Error('memory: generate 返回缺 response 字段')
      return j.response
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 从模型输出里抠出 JSON 数组。
 *
 * 模型经常在数组前后加解释文字或 ``` 围栏——直接 JSON.parse 会失败，
 * 而失败被吞掉就会表现为「抽不出东西」，与「确实没有可抽的」无法区分。
 * 所以这里尽力而为地取第一个 `[` 到最后一个 `]`，解析失败返回空数组由调用方计数。
 */
export function extractJsonArray(raw: string): unknown[] {
  const s = raw.replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('[')
  const b = s.lastIndexOf(']')
  if (a < 0 || b <= a) return []
  try {
    const v = JSON.parse(s.slice(a, b + 1))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
