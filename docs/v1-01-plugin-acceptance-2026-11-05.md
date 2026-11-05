# V1-01 插件机制验收（2026-11-05，**已更正**）

**判据原文**（架构需求 §7）：「至少 8 个功能以插件形式加载；禁用其中任意一个后系统仍能启动并给出明确提示；配置写错时启动报错。」

> **本文档推翻了初版结论。** 初版写「配置写错时启动报错 ✅」，那是错的——当时把临时配置放在
> `/tmp` 与 `%TEMP%` 下测试，而 **DSH 从 config 文件所在目录解析依赖**，于是 32 个插件全部
> `Cannot find package`，报错其实是「依赖解析全崩」，不是「配置写错被识别」。真正的测试必须把
> 临时配置放在 `config/` 目录内。

## 实测结果（配置都放在 `config/` 内）

| 判据 | 结果 | 证据 |
|---|---|---|
| ≥8 个功能以插件形式加载 | ✅（按读法 A） | `config/prts.yml` 声明 30+ 个 DSH 插件 |
| 禁用任一插件仍能启动并提示 | ❌ **不满足** | 给 `dsh-attachment-local` 加 `disabled: true` → `prts: startup failed: 1 required plugin did not activate`，**起不来** |
| 配置写错时启动报错 | ❌ **不满足** | 把 `dsh-token-meter` 改成不存在的包名 → **系统正常启动**，只有 `compaction-basic` 打印 `pending (waiting for service: tokenMeter)`，无报错、无退出码 |

## 一个反常的不一致（这才是真正的问题）

| 操作 | 危险程度 | 系统反应 |
|---|---|---|
| 把插件名写错（包不存在） | 高——功能静默缺失 | **放行启动** |
| 主动 `disabled: true` 禁用 | 低——用户有意的决定 | **拒绝启动** |

更危险的那个更宽松，更安全的那个更严格。判据期望的恰好反过来：「禁用一个仍能启动，且给出明确提示；配置写错要报错」。

根因方向（未深挖）：DSH 对「resolve 失败」与「disabled」两条路径的处理不对称——前者被吞成「该插件未激活」，后者被计入 required 校验。两条都在 DSH 内部，本仓 `src/` 里没有对应代码（`startup failed` 文案来自 `boot()`）。

## 一个好消息：指名信息其实存在

`e.cause` 是 `AggregateError: Plugin activation failures`，其 `errors` 数组里**逐条带包名与原因**：

```
Failed plugins (32):
  deepseek-llm-api-extensions
    Package: @deepseek-ai/dsh-deepseek-llm-api-extensions
  ...
```

所以「指名插件」这件事不需要新建机制，只需要在 PRTS 侧把 `e.cause.errors` 展开到顶层错误信息里。当前顶层只有一句 `1 required plugin did not activate`，把最有用的细节丢掉了。

## 建议

1. **顶层报错带上插件名**（低成本、高价值）：`startRuntime` 捕获 boot 错误时，若 `cause.errors` 存在则拼进 message。
2. **让 `disabled` 不参与 required 校验**（若 DSH 支持区分），否则「禁用」这个动作本身不可用。
3. **插件 resolve 失败不应静默**：至少打警告。当前写错包名会安静地少一个功能。
4. 判据文字建议改为：「配置写错时启动报错（**指名具体插件**）；禁用一个**可选**插件后系统降级启动并提示」。

## 未验证

- DSH 是否有 `optional` 标记可让某个插件缺失时不阻断启动——没找到（`dsh-app-boot` 的 lib 里没有 `required` 判定，可能在别的包）。
- 上述建议 2/3 是否可在不修改 DSH 的前提下实现——未探。
