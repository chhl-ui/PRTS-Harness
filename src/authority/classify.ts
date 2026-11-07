import { raise } from './errors.ts'
import { cap } from './capability.ts'
import { normalizePath } from './paths.ts'
import type { Capability } from './types.ts'

function absFilePath(args: unknown, tool: string): string {
  if (args === null || typeof args !== 'object') {
    raise('INVALID_INPUT', `${tool}: args must be an object`)
  }
  const p = (args as { file_path?: unknown }).file_path
  if (typeof p !== 'string' || p.trim() === '') {
    raise('INVALID_INPUT', `${tool}: file_path must be a non-empty string`)
  }
  return normalizePath(p) // 非绝对路径在这里抛 INVALID_INPUT
}

/**
 * 工具名里出现这些词就当作联网动作（K2b）。
 *
 * 判据是「宁可误判成 net，不可漏判」：误判的代价是多重一次审批，
 * 漏判的代价是一次 fetch 把记忆库里的对话带出去且没有任何人知道。
 */
const NET_TOOL = /(?:^|[^a-z])(web|search|fetch|http|crawl|browser|net|api)(?:[^a-z]|$)/i

/**
 * 第三方代理类联网工具：真实出站是代理服务本身，不是参数里的目标站点。
 *
 * 为什么必须单独登记：`netHost` 只能从参数里找 url/href/uri/endpoint。
 * `prts_web_search` 的参数只有 query/limit，取不到 host 就退化成 `net:*`；
 * 而 `hostAllowed('*')` 恒 false（authority.ts:114），白名单对它永远不生效，
 * 审批提示上也看不出要连哪个站。
 *
 * `prts_web_fetch` 虽然带 url，但抓页面是 Firecrawl 代取——本机连接的仍然是
 * api.firecrawl.dev。按目标站授权等于对着错的边界做判定。
 */
const PROXY_NET_HOSTS: Record<string, string> = {
  prts_web_search: 'api.firecrawl.dev',
  prts_web_fetch: 'api.firecrawl.dev',
}

/** 从参数里尽力取 host；取不到返回 `*`（表示「任意域名」，仍会走授权判定）。 */
function netHost(args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const a = args as Record<string, unknown>
    for (const key of ['url', 'href', 'uri', 'endpoint']) {
      const v = a[key]
      if (typeof v !== 'string' || v.trim() === '') continue
      try {
        // hostname 而不是 host：端口不该参与授权比较（同一域名的 :443 与 :8080 是同一方）。
        return new URL(v).hostname === '' ? '*' : new URL(v).hostname
      } catch { /* 不是合法 URL，试下一个字段 */ }
    }
  }
  return '*'
}

/**
 * DSH rc.2 工具参数名（已核实，见 PR/AGENTS 报告）：
 * read/read_image/write/edit → file_path；pwsh → command；working_directory → 可选 cd。
 */
export function classify(tool: string, args: unknown): Capability[] {
  switch (tool) {
    case 'read':
    case 'read_image':
      return [cap.fsRead(absFilePath(args, tool))]
    case 'write':
    case 'edit':
      return [cap.fsWrite(absFilePath(args, tool))]
    case 'pwsh':
      if (args === null || typeof args !== 'object'
        || typeof (args as { command?: unknown }).command !== 'string'
        || (args as { command: string }).command.trim() === '') {
        raise('INVALID_INPUT', 'pwsh: command must be a non-empty string')
      }
      return [cap.execShell()]
    case 'working_directory':
      // 只改变会话 cwd 状态，不产生文件系统副作用（可切任意已存在目录，见报告说明）
      return []
    default:
      if (typeof tool !== 'string' || tool === '') raise('INVALID_INPUT', 'tool must be a non-empty string')
      // K2b：联网类工具归 net（无 grant 即 ask）。放在 tool 之前判，
      // 否则 MCP 的 web_search 之类会一直落到 tool 分支、永远拿不到 net 的授权语义。
      // 代理类先判：它们的 host 由代码决定，不看参数（见 PROXY_NET_HOSTS）。
      // 用 hasOwn 而不是直接索引——模型可以把工具名传成 'constructor' 之类。
      const proxyHost: string | undefined = Object.hasOwn(PROXY_NET_HOSTS, tool)
        ? PROXY_NET_HOSTS[tool]
        : undefined
      if (proxyHost !== undefined) return [cap.net(proxyHost)]
      if (NET_TOOL.test(tool)) return [cap.net(netHost(args))]
      return [cap.tool(tool)]
  }
}
