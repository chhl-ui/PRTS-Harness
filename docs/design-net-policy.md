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
