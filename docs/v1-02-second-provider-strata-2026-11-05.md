# V1-02 第二家模型提供方：走 Strata（2026-11-05）

**验收原文**（架构需求 §7）：「关闭 DSH 后冷启动、对话、执行任务、读写记忆全部可用；
**切换到第二家模型提供方后同样可用**。」

## 一、第二提供方选型

| 候选 | 结论 |
|---|---|
| 云端第二家（OpenAI / 智谱等） | 需第二个 API key，且记忆正文出境 |
| **Strata + Qwen3.8-Flash-Next（本机 8080）** | **采用**——零 key、OpenAI 与 Anthropic 双协议 |

## 二、协议实测（2026-11-05）

| 端点 | 结果 |
|---|---|
| `GET /v1/models` | 200，`qwen3.8-flash-next-iq3_xxs`，`n_ctx 262144` |
| `POST /v1/messages`（Anthropic，DSH 的 deepseek 适配器用的就是这条） | **200**，933 ms |
| `POST /v1/chat/completions`（OpenAI） | **200**，327 ms |
| `POST /v1/embeddings` | 404（不提供 embedding，见 A5 文档） |

双协议可用意味着**不需要新增 provider 插件配置**：DSH 的 `dsh-llm-deepseek-api-key`
适配器固定走 Anthropic Messages，把 `DEEPSEEK_BASE_URL` 指过去即可。

## 三、切换方法

```sh
# 启动 Strata（与 NInfer 显存互斥，两套不能同时开）
"C:\Users\Administrator\Desktop\Strata-FlashNext.bat"

# 切到第二提供方（PRTS 侧只换环境变量，不改配置、不改代码）
DEEPSEEK_BASE_URL=http://127.0.0.1:8080 \
PRTS_LLM_MODEL=qwen3.8-flash-next-iq3_xxs \
DEEPSEEK_API_KEY=strata-local \
DSH_CONTEXT_WINDOW=32768 \
node src/cli/chat-main.ts
```

## 四、端到端实测

真实 `startRuntime` + 真实 Strata 模型 + 临时数据根，一轮对话：

- 输出：模型正确列出自身可用能力（PowerShell、文件读写、任务流程、提醒、记忆检索、子任务派发），
  并明确「不能自行采用技能或批准任务与验收」——与权限边界一致。
- `共 1 轮`，**exit=0**。

## 五、边界（不要当成已验证）

- **「执行任务」与「读写记忆」未在 Strata 下单独验**：本轮只跑了一轮对话。
  V1-02 原文那四项（冷启动 / 对话 / 执行任务 / 读写记忆）里，后两项需要各自的场景测试。
- **没有配置层的第二 provider 条目**：当前靠环境变量切换。DSH 有 `@deepseek-ai/dsh-llm-pi-ai`
  （OpenAI 兼容适配器），若要做到「配置里同时列两家、按需切换」，需要它的 config schema
  （`$defs/config14` 在 dump 里是空引用，未取到字段名）。
- Strata 与 NInfer 显存互斥（16 GB），同一时刻只能开一套。
- Strata 启动预热 1–2 分钟，常驻占约 47 GB RAM。
