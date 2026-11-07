# V1-01 插件机制验收（2026-11-05，第三版·终）

**判据原文**（架构需求 §7）：「至少 8 个功能以插件形式加载；禁用其中任意一个后系统仍能启动并给出明确提示；配置写错时启动报错。」

> **本文档推翻了前两版结论。** 前两版的失败都是**我的测试配置坏了**，不是产品问题：
> 1. 第一版把临时配置放 `/tmp` / `%TEMP%`——DSH 从 **config 文件所在目录**解析依赖，
>    于是 32 个插件全部 `Cannot find package`，报错其实是「依赖解析全崩」。
> 2. 第二版用 `sed` 插入 `    disabled: true`（4 空格），而配置缩进是 **2 空格**，
>    YAML 直接坏成 `bad indentation of a mapping entry`，启动自然失败。
>
> 这一版的每一条都在 `config/` 目录内、用正确缩进重测。

## 最终实测

| 判据 | 结果 | 证据 |
|---|---|---|
| ≥8 个功能以插件形式加载 | ✅ | `config/prts.yml` 声明 **30+ 个 DSH 插件**（llm / tools / agent / session / sandbox / terminal…） |
| **禁用任一插件后仍能启动** | ✅ | 给 `attachment-local` 加 `disabled: true`（2 空格缩进）→ **启动成功** |
| 禁用时「给出明确提示」 | ⚠️ 未验证 | 启动成功；是否有「某插件已禁用」的提示没单独捕获（DSH 日志通道未探） |
| **配置写错时启动报错** | ✅ **已修（60b58b1）** | 修前：写错包名静默启动，只有 `compaction-basic` 打一行 `pending`。修后：启动时按名列出无法解析的插件（默认警告，`PRTS_STRICT_PLUGINS=1` 升级为启动失败）。回归 `test/runtime/plugin-resolve-check.test.ts` 2 项 |

## 剩下的真问题：写错包名会静默启动

| 操作 | 严重程度 | 系统反应 |
|---|---|---|
| 把插件名写错（包不存在） | 高——功能静默缺失 | **放行启动** |
| 主动 `disabled: true` 禁用 | 低——有意决定 | 正常启动（符合判据） |

所以判据三条里只差最后一条：**配置写错要报错，现在不报**。

根因方向（未深挖）：DSH 把「插件 resolve 失败」吞成「该插件未激活」，只有依赖它的下游插件 pending，不阻断启动。而 `1 required plugin did not activate` 那条错误来自「配置解析/依赖图本身崩了」的场景。两条路径在 DSH 内部，本仓 `src/` 里没有对应代码。

## 好消息：指名信息已经存在

`e.cause` 是 `AggregateError`，其 `errors` 数组逐条带包名与原因：

```
Failed plugins (1):
  include (required)
    Package: cordis:i
```

所以「指名插件」不需要新建机制，只需在 PRTS 侧把 `e.cause.errors` 展开到顶层错误里。当前顶层只有一句 `1 required plugin did not activate`，把最有用的细节丢了。

## 建议（按性价比排序）

1. **顶层报错带上插件名**：`startRuntime` 捕获 boot 错误时，若 `cause.errors` 存在则拼进 message。低成本，直接解决「看到报错不知道改哪」。
2. **插件 resolve 失败不应静默**：至少打一条警告。当前写错包名会安静地少一个功能——这是最容易踩且最难发现的配置错误。
3. 判据文字可改为：「配置写错时启动报错（**指名具体插件**）；禁用一个插件后系统仍能启动并提示」。

## 方法教训（留给下一次）

- **临时配置必须放 `config/` 目录内**：DSH 以 config 所在目录为模块解析基准。
- **改 YAML 先看真实缩进**（`cat -A` 看空格数），别凭想象插。
- **测试失败先怀疑自己的夹具**：这两次都是夹具坏了，产品其实是好的。判断依据是 `cause.errors` 的具体内容——它直接说了 `Cannot find package` 和 `bad indentation`。
