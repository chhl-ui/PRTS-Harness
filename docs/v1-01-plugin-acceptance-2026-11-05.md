# V1-01 插件机制验收（2026-11-05）

**判据原文**（架构需求 §7）：「至少 8 个功能以插件形式加载；**禁用其中任意一个后系统仍能启动并给出明确提示**；配置写错时启动报错。」

## 实测结果

| 判据 | 结果 | 证据 |
|---|---|---|
| 配置写错时启动报错 | ✅ **满足** | 把 `dsh-token-meter` 改成不存在的包名 → `prts: startup failed: 1 required plugin did not activate` |
| 禁用任意一个仍能启动并提示 | ❌ **不满足** | 给 `dsh-attachment-local` 加 `disabled: true` → 同样 `1 required plugin did not activate`，**启动直接失败** |
| ≥8 个功能以插件形式加载 | ⚠️ **定义待定** | 见下 |

## 第三条为什么会「待定」

两种读法给出相反答案：

**读法 A（宽松）**：`config/prts.yml` 里声明了 **30+ 个插件**（dsh-llm / dsh-tools / dsh-agent / dsh-session…），远超 8 个 → 满足。

**读法 B（严格）**：那些是 **DSH 提供的**插件，不是 PRTS 自己的功能。PRTS 的 12 个机制层全部是 `startRuntime` 里硬接的 `attach*` 函数：

```
attachErrorReporter / attachIntentTrigger / attachMemoryInjection / attachAssembly
attachSkillInjection / attachEmotionInjection / attachSessionRecall / attachProactiveRecall
attachTaskReminder / attachToolLoopAudit / attachMemoryScheduler / attachSpill
```

它们**不是插件**——没有注册/卸载契约，取消一个要改源码而不是改配置。按这条读法：**0 个功能以插件形式加载**。

判据里的「功能」指哪一个，原文没有展开。这个选择直接决定 V1-01 通过与否。

## 第二条不满足的性质

不是 bug，是 **fail-closed 设计与 graceful degradation 要求之间的冲突**：

- 当前行为：任何一个插件没激活 → 整个启动失败（宁可不起，也不半残）
- 判据要求：禁用一个后**仍能启动**并给出明确提示

报错文案 `1 required plugin did not activate` 来自 DSH（不在本仓 `src/` 里），本仓只加了 `prts: startup failed:` 前缀。DSH 是否支持把某个插件标成 optional 使系统降级启动，**我没有定位到**（`dsh-app-boot` 的 lib 里没查到 `required` 判定，可能在别的包里）。所以「能不能改」目前是未知，不是「能改但没改」。

## 需要博士定的一件事

三选一：

1. **V1-01 按读法 A 判定通过**（DSH 的 30+ 插件算数），只补「禁用可选插件仍启动」的验证——但要先确认 DSH 有没有 optional 机制。
2. **按读法 B 判定不通过**，把 12 个 `attach*` 机制改造成插件（工作量大，且它们之间有顺序依赖：sessionRecall 必须在 memoryInject 之后）。
3. **修订判据**：承认「核心机制不插件化、可选功能插件化」是合理架构，把 V1-01 的判据改成「可选功能以插件形式加载」。

我倾向第 1 或第 3，理由：`attach*` 那 12 个是 PRTS 的**核心机制**（记忆注入、情感注入、会话重建），它们之间有严格顺序，做成插件反而增加失败模式；而「可选功能插件化」才是判据真正想守的东西（可禁用、可替换、坏了不拖垮主体）。
