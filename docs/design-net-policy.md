# 联网策略：白名单 + 服务端搜索的边界（2026-11-03）

## 一、两半，松紧反了

| 路径 | 请求从哪发出 | PRTS 守卫能否看到 | 现状 |
|---|---|---|---|
| 本地 net 工具（fetch / web_search 之类） | 本进程 | ✅ `tools.guard` 逐次判定 | 每次 ask，过于打断 |
| **server-side 搜索**（DeepSeek Anthropic 端点的 `web_search_20250305`） | DeepSeek 后端 | ❌ **完全看不到** | 挂上就等于无声放行 |

第二条是实测结论，不是推断：用现成 key 向 `https://api.deepseek.com/anthropic/v1/messages`
发一个带 `{"type":"web_search_20250305","name":"web_search","max_uses":2}` 的请求，
后端真的执行了 —— 模型自己决定 query（搜了「DeepSeek V4 发布时间」与「release date」两条），
返回真实 URL，计费记录 `server_tool_use.web_search_requests: 2`。

也就是说：**模型可以把记忆库里的对话原文当 query 发出去，而 `Authority` 一无所知。**

## 二、本次改动：本地那半放宽

`AuthorityConfig.netAllowHosts` + 环境变量 `PRTS_NET_ALLOW`：

```bash
PRTS_NET_ALLOW=api.deepseek.com,*.githubusercontent.com
```

- 精确项必须完全相等；`*.example.com` 匹配任意级子域但**不匹配裸域**
- 不做后缀包含判断——`evilgithubusercontent.com` 不会被 `*.githubusercontent.com` 蒙混
- 缺省为空 = 所有联网动作仍要人点头（与改动前完全一致）
- 只影响 `net` 能力，fs / exec 行为不变

开工时会打一行告警说明白名单已启用，避免「为什么这次没问我」变成谜。

## 三、服务端那半：现在接不上，原因是适配器

`config/prts.yml` 里 `llm-deepseek` 用的是 `@deepseek-ai/dsh-llm-deepseek-api-key`
（OpenAI 兼容的 `/chat/completions`），配置项只有 `apiKeyEnv` / `defaultContextWindow` /
`streamIdleTimeoutMs`——**没有声明 server-side tools 的位置**。

要用 server-side 搜索，需要换/加一个走 Anthropic 端点（`/anthropic/v1/messages`）的适配器。
这是 DSH 侧的事，不在本仓。在拿到那个适配器之前，**不要**声称 PRTS 有联网搜索。

## 四、将来接上时的硬要求

1. **默认关闭**，`PRTS_WEB_SEARCH=1` 才挂这个 tool
2. **启动横幅明说**：「服务端搜索已启用：查询内容将发送至 DeepSeek 后端，本地守卫无法拦截」
3. 文档与交接里写清楚它是**守卫覆盖不到的外部动作**——把它写成「已被 K2b 覆盖」是最危险的说法

## 五、DeepSeek Super-agent 架构（走 server-side 搜索查到，供后续参考）

四个特征：连续、高效、主动、持久。

五个模块：

1. **双层架构**：常驻 Router 承接人类交互与全局上下文、只做轻量分派；上下文隔离的 Worker
   并发执行、不直接回复用户，汇报给 Router。Router 可用轻模型，Worker 需最强模型。
   设计哲学：「Session 应当是系统的实现细节，而不应是用户的认知负担」
2. **事件驱动**：输入从提示词扩展为 Trigger（群聊/邮件/代码评论/CI），两级过滤——
   程序层 Fast Path 做确定性筛选，语义层 Slow Path 交模型研判；原则是「规则没允许的不动」；
   另有订阅直通让同一 Thread 的后续事件直达 Worker
3. **面向人的交互**：同步 ReAct Loop 改异步 `start()/stop()`，后台任务不阻塞前台对话；
   Inline & Spill、链式召回、投机执行
4. **计算/状态/环境分离**：计算无状态、状态入库上云，执行环境留在本地只跑轻量 daemon；支持 BYOM
5. **外部 Watchdog**：独立 Control Loop 监控基础设施故障，并由模型判断任务是否陷入无效循环或偏离目标

来源：《Super-agent 设计探索：迈向更自主的 Agent 系统》（DeepSeek Harness 团队）；
原型仓库 `github.com/deepseek-ai/dsh-superagent-prototype`；
媒体报道 ithome / donews / techweb 等（2026-11-01 前后）。

**对 PRTS 的直接映照**：模块 2 的「Fast Path 确定性筛选 + Slow Path 模型研判」正是
`classify` + `Authority` 的分工；模块 5 的外部 Watchdog 对应 `supervisor` + `StopController`。
PRTS 缺的是模块 1 的 Router 层与模块 4 的状态/计算分离。

## 六、另一条断掉的线：shell 沙箱里根本没有网络（2026-11-07 实测）

这不是「策略收紧了」，是**沙箱内的进程出不去**，且与联网策略无关。

**现象**（模型在 pwsh 里实测）：
- `Resolve-DnsName` 返回「拒绝访问」
- `1.1.1.1:443`、`223.5.5.5:53` 直连也都不通
- `Invoke-WebRequest https://example.com` 超时 15s
- 环境里没有代理变量

**对照实验**（同一台机器，非沙箱的 Git Bash）：

| 目标 | 非沙箱 | 沙箱内 |
|---|---|---|
| `https://1.1.1.1` | HTTP 301，2.5s | 不通 |
| `223.5.5.5:53` | 通（经代理返回 fake-IP） | 不通 |

**所以网络本身是通的，是沙箱里的进程出不去。** 直连 IP 也不通这一点很关键——它排除了「只是 DNS 解析失败」，说明拦截在更下层。

**根因**：`dsh-sandbox-windows-acl/lib/runner.js` 只做两件事——受限令牌（`CreateRestrictedToken` + `CreateProcessAsUserW`）与文件 ACL 授权。该文件里的 Win32 调用只有 `CreateProcessAsUserW` / `SetConsoleCtrlHandler` / `SetEnvironmentVariableW`，**没有任何 WFP、防火墙或 socket 过滤**。所以拦截来自令牌本身：它移除了 `Authenticated Users` 与 `INTERACTIVE`/`LOCAL`（注释原文：「BOTH modes drop `Authenticated Users` … and `INTERACTIVE`/`LOCAL`」），而这台机器的流量走本地代理，受限令牌下访问代理端点也失败，于是**连直连 IP 都出不去**。

**结论：不修，用别的路径。**
- `prts_web_search` / `prts_web_fetch`（`src/runtime/web-tools.ts`）跑在 **serve 进程**内，不受沙箱令牌约束；2026-11-07 实测 Firecrawl `/v2/search` 与 `/v2/scrape` 均 HTTP 200。
- pwsh 侧联网的增量收益是零——同样的需求由上面两个工具覆盖，且带正文提取、超时与大小上限。

**如果以后要修**，问题该报给 DSH 而不是本仓：

> `CreateRestrictedToken` 移除了 `Authenticated Users` 与 `INTERACTIVE`/`LOCAL`，导致沙箱内进程无法访问本地代理端点与 DNS Client 命名管道，**所有出站网络失败（含直连 IP）**。文件写限制与网络可达性应当正交——限制文件写不该顺带切断网络。

**别再重复的弯路**：不要把这诊断成「DNS 配置问题」或「代理变量缺失」。变量确实没有，但补上也没用——失效发生在进程能访问什么，不在它读到什么。唯一还能做实诊断的动作是**在沙箱里跑 `whoami /groups`**，看令牌里到底剩哪些组。

### 更正（2026-11-07 同日实测推翻上段的根因与结论）

上段把根因归给 `dsh-sandbox-windows-acl` 的受限令牌。**那个后端不是生产在跑的那个**：
`src/runtime/start.ts:236` 只在 `PRTS_SANDBOX_BACKEND=appcontainer` 时走 appcontainer，
否则回落 `local`；桌面端 `C:\prts-desktop\main.cjs` 把它默认设成 appcontainer。
现场核对：注册表 `AppContainer\Storage` 下只有 `prts.sandbox.test-*`（测试变体），
生产的 `prts.sandbox` 一条命令跑完就被 `dispose()` 删掉——这本身就说明 appcontainer
路径是活的。

**真正的根因**：`src/sandbox/appcontainer.ts` 建 profile 与启动进程时
`capabilities = null` / `CapabilityCount = 0`。没有 `internetClient` 的 AppContainer
连 socket 都创建不出来——表现为直连 IP 失败、DNS 报「拒绝访问」，与上段观察一致，
但机制完全不同（不是令牌、不是代理、不是 DNS）。

实测（真容器，`.rivet/scratch/probe-sandbox-net.ts`）：

| | `1.1.1.1:443` | `127.0.0.1:7892` | DNS | 关代理的 WebClient |
|---|---|---|---|---|
| 修前 | FAIL | TIMEOUT | FAIL | — |
| 修后 | OK | TIMEOUT | OK | `example.com` 正文 577 字节 |

**已修**（`d7b9422`）：`SECURITY_CAPABILITIES` 加 `internetClient`（`S-1-15-3-1` +
`SE_GROUP_ENABLED`）。只加出站，不加内网、不加入站监听。

**修后仍存的边界**：AppContainer 永久禁止 loopback，系统代理 `127.0.0.1:7892`
在沙箱里永远不可达。`CheckNetIsolation LoopbackExempt` 也救不了——`dispose()` 会删除
profile，`-n=<name>` 找不到对象（用户看到的「错误: 参数无效」就是这个）。所以沙箱里
**只走直连**。

.NET 那条路要单独说清楚，因为它和 curl 的读法不同（2026-11-07 pwsh 7.6.9 实测）：

| 客户端 | 默认 | 关代理后 |
|---|---|---|
| `curl.exe` | 直连，200 | — |
| `Invoke-WebRequest` | **挂到超时**（读 WinINET 系统代理） | `-NoProxy` → 200 |
| 裸 `HttpClient` | 同上 | `UseProxy = $false` → 200 |

两个反直觉的点，都实测过：
- **`-Proxy $null` 无效**。`-NoProxy` 才是 pwsh 7 的开关；7.6.9 上实测前者仍走系统代理。
- **环境变量无效**。`NO_PROXY=*` 在进程内第一条就设置仍然失败——.NET 在 Windows 上只读
  WinINET 系统代理，不看环境变量。所以「沙箱注 env 一劳永逸」这条路不存在。

**最终解法**：`config/prts.yml` 的 `terminal-pwsh` 用 `shellArgs` 覆盖默认的
`["-NoLogo","-NoProfile"]`，追加

```
-NoExit -Command "[System.Net.Http.HttpClient]::DefaultProxy = [System.Net.WebProxy]::new()"
```

shell 启动时就把 .NET 的默认代理置空。实测（临时 dataRoot + 真 appcontainer + 真模型）：
`Invoke-WebRequest -Uri https://example.com` **裸调用返回 200**，不需要任何额外参数。

为什么只能在启动参数里做：profile 路被 `DEFAULT_PWSH_ARGS` 里的 `-NoProfile` 挡住，
环境变量路被 .NET 无视——能动的只有 `shellArgs`。`-NoExit` 保证初始化后仍进交互式
shell，PTY 语义不变（实测 pwsh 工具正常往返）。

`curl.exe` / node / git / npm 不读 IE 代理，本来就不受影响。
`config/prts.yml` 的 pwsh 描述已同步：原句「You don't have access to the internet via
this tool」会让模型直接放弃联网。

