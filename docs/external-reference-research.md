# 外部参考检索与归档

实现本项目没有的能力、做技术选型、或需要为设计补外部依据时，按本文执行。目的是不重复造轮子，同时不把「别人这么做」当论据。

## 何时用

- 准备实现一个本项目没有的能力（记忆、检索、调度、语音、沙箱…）
- 两个以上候选方案要选型
- 想确认「业界怎么解这个问题」
- 需要为设计文档补外部依据

不要用于：语言语法、标准库用法、本仓源码能直接回答的问题。

## 检索

GitHub 三条路分工不同：

- **repo 搜索**看「有没有这个东西」
- **code 搜索**看「它到底怎么实现的」
- **issue 搜索**看「踩过什么坑、维护者怎么回应」

关键词先领域词 + 架构词（如 `episodic memory` + `event sourcing`），再加语言/框架限定。别一上来就加语言限定，会漏掉设计更成熟的异构实现。

网络：本机 GitHub 有 DNS 污染与时好时慢的问题，必要时 `/mirror china`（ghproxy/GitCode）；git clone 走镜像、push 仍走原地址。

论文：arXiv / Papers with Code / Semantic Scholar。优先挑**有开源实现**的论文——能对照代码验证说法。记录 arXiv id 与版本号，论文会改版。

## 评估

不只看 star 数。逐项过：

| 维度 | 看什么 |
|---|---|
| 许可证 | 能否闭源集成。GPL 会传染，专有许可等于只能借鉴设计不能借代码 |
| 活性 | 最近提交时间、issue 是否有人回应、是否 archived |
| 真实度 | 有测试吗、有可跑示例吗、还是只有 README 愿景 |
| 契合度 | 接口能否嵌进现有架构；引入要改几处 |
| 代价 | 依赖树大小、运行时版本要求、长期维护负担 |

结论必须落到四选一并写理由：**复用 / 适配 / 借鉴设计 / 自建**。「参考一下」不算结论。

## 归档

路径固定：`C:\Users\Administrator\Desktop\参考库\<项目名>`

- 记录来源 URL 与**固定 commit**，不记分支名——分支会动，commit 不会
- 归档目录只读，不在里面改代码、不把归档目录当依赖 import
- 新增前先看已有条目，避免重复下载

已有条目（截至 2026-11-01，13 个；`MRAgent` 与 `AMB-agent-memory-benchmark` 为当日新增）：

| 类别 | 目录 |
|---|---|
| agent 运行时与框架 | `Tianshu-harness` `agent-code` `deer-flow` `ruflo` `dsh-superagent-prototype` |
| 记忆与检索 | `hindsight` `mempalace` `codebase-memory-mcp` **`MRAgent`**（论文，arXiv:2606.06036v1，ICML 2026）**`AMB-agent-memory-benchmark`**（评测框架；**license=None**，仅记录来源、未克隆代码） |
| 其他 | `ECC` `hallmark` `Understand-Anything` |
| UI 设计（2026-11-06 新增，服务 `C:\prts-desktop` 改版） | `dsh-skin-prts` `prts-suite` `ArknightsUI-React-Template` |

UI 三仓判定（均为 PRTS/明日方舟同人皮肤仓，蒸馏产物在 `C:\prts-desktop\docs\prts-ui-tokens.md`）：

| 目录 | commit | 四选一 | 理由 |
|---|---|---|---|
| `dsh-skin-prts` | `c135e52` | 借鉴设计 | 完整 PRTS 终端设计 token（五层底阶、`#11AFCF` 青、暗红棕品牌色）+ 签名元素 CSS 手法（硬阴影/斜切/菱形标/扫描线），与桌面端聊天壳结构同构；CC BY-SA 只取参数不搬代码 |
| `prts-suite` | `0f4fcc8` | 借鉴设计 | 环境层元素清单（数据网格/粒子/手套光标/开机动画）；色系是「信息之海」深青变体，未采纳其色板 |
| `ArknightsUI-React-Template` | `302c1f0` | 借鉴设计 | 字体选型参考（Bahnschrift 已入 token）；React/Tailwind 技术栈与本仓 vanilla 渲染器不同构，只取字体清单 |

记忆与检索那一组已做过代码级对账（2026-11-01，对照架构需求 §5.3 的十三项），
逐格证据与判定在 `docs/memory-landscape.md`。三家结论：

| 目录 | 四选一 | 理由 |
|---|---|---|
| `hindsight` | 借鉴设计 | 写时结构化 + 后台巩固 + 结构化库上的四路召回，是 §5.3 最接近的实现样本；但强绑 PostgreSQL（pgvector / JSONB / `db_url.py` 拒绝非 PG），与 TS + `node:sqlite` 的部署假设不兼容 |
| `mempalace` | 借鉴设计 | wings/rooms 分层作用域、协议层「回答前先查」、删除连带清派生索引三项可用；强制 `chromadb` 依赖；README 自称「不做摘要/抽取」与代码冲突（`general_extractor.py` 存在） |
| `codebase-memory-mcp` | 不适用 | 代码库结构记忆。`nodes` DDL 无自由文本列、无主体列、无事实时间列，填不了 §5.3 任何一格 |

对账同时确认四格零覆盖：关系记忆、技能与经验、意图库、「明说 vs 推断」的 provenance。
前两格还有候选没拉（Letta、Generative Agents），后两格在架构需求 §9 的候选表里没有对应条目，判为自建。

上下文装配（§5.3 后半段）与人格情感（§5.1）两块的对账在 `docs/context-and-persona-landscape.md`，两块都判「借鉴设计」，无一处可复用。最值得拿的三条：DSH 的工具结果卸载（spill）、宿主装配的前缀冻结、Tianshu-harness 的全域共享白名单（16 个 `toolWhitelist` 实测去重后只剩 1 种、692 字符）。情感状态量本地零实现，且本轮论文证据只到搜索摘要级（代理 fake-IP 拦截），不能作为动工依据。

## 引用纪律

- 引用外部结论前，用 grep / read_file 独立核实该断言在当前代码库里成立
- 「文档没提 X」≠「X 没做」；「README 说支持 Y」≠「Y 已实现」。要看实现和测试
- 借鉴设计时标注来源与版本，让别人能回到原文
- 归档 ≠ 采纳。采纳必须改代码并跑验证，归档只是素材

## 反模式

- 搜了一堆，设计文档里一个都没引用
- 只看 star 数和 README 就下结论，没读实现
- 把归档目录当依赖路径直接 import
- 抄了设计但改了前提条件，语义已经不对
- 把「别人这么做」当论据，不说为什么适用于当前约束
