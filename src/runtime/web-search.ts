/**
 * server-side `web_search` 接线。
 *
 * 事实基础（2026-11-07 实测）：
 * - 端点是 DeepSeek 的 Anthropic 兼容接口 `/anthropic/v1/messages`
 * - `tools: [{type:'web_search_20250305', name:'web_search', max_uses:N}]` 被接受（HTTP 200）
 * - 返回里出现 `server_tool_use` 与 `web_search_tool_result` 块，模型据结果作答
 * - `type` **必须带日期后缀**：裸 `web_search` 会被 422 拒掉
 *
 * 本地这一侧只做一件事：往请求体里加 `tools` 字段。搜索本身在服务端执行，
 * 本仓不实现抓取、不解析网页。
 *
 * **安全边界（重要）**：启用后查询内容会离开本机、发送到 DeepSeek 后端，
 * K2a/K2b 的本地守卫**看不到这一步**。所以默认关闭，只有 `PRTS_WEB_SEARCH=1`
 * 才挂这个字段——这是唯一开关。别在文档里把它写成「已被 K2b 覆盖」。
 */
export interface WebSearchDeps {
  /** 覆盖开关；缺省读 `PRTS_WEB_SEARCH === '1'`。 */
  enabled?: boolean
  /** 单次请求最多搜索几次，默认取 `PRTS_WEB_SEARCH_MAX_USES` 或 3。 */
  maxUses?: number
}

/** 与 `DeepSeekLlmApiExtensionRegistry.register` 的结构型接口（避免跨包类型合并）。 */
export interface ExtensionRegistryLike {
  register(field: string, provider: unknown): unknown
}

/** web_search 工具声明；`type` 带日期是硬要求。 */
export function webSearchTool(maxUses: number): Record<string, unknown> {
  return { type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }
}

/**
 * 按需注册 `tools` 字段。返回 disposer；未启用时返回 `undefined`（不注册任何东西）。
 */
export function registerWebSearch(
  registry: ExtensionRegistryLike | undefined,
  deps: WebSearchDeps = {},
): (() => Promise<void>) | undefined {
  const enabled = deps.enabled ?? process.env.PRTS_WEB_SEARCH === '1'
  if (!enabled) return undefined
  if (registry === undefined) {
    // 只在「开了却拿不到服务」时报一行：静默跳过会让人以为搜索生效了，
    // 而实际上请求里根本没有 tools 字段，排查起来毫无线索。
    console.error('[prts] PRTS_WEB_SEARCH=1 但找不到 deepseekLlmApiExtensions 服务，搜索未挂载')
    return undefined
  }

  const raw = deps.maxUses ?? Number(process.env.PRTS_WEB_SEARCH_MAX_USES ?? '3')
  // 非法值回落 3：max_uses 配成 0 或 NaN 等于「挂了个不会用的工具」，比不挂更迷惑。
  const maxUses = Number.isFinite(raw) && raw >= 1 ? Math.min(20, Math.floor(raw)) : 3

  const disposer = registry.register('tools', {
    prepare: () => ({ value: [webSearchTool(maxUses)] }),
  })
  return disposer as (() => Promise<void>) | undefined
}
