# V1-12 导出/导入核对（2026-11-05 实测）

**验收原文**（架构需求 §7）：「导出后导入全新安装，记忆、人格设定和任务历史逐项核对一致。」

## 结论

机制与测试此前已有（`test/cli/archive.test.ts` 的 A1–P4：导出 → 空 dataRoot 导入 → 条数与
链状态逐项相等），但**存在一个未覆盖的缺口**：

`exportArchive` 搬了 `memory.sqlite`（记忆）、`core.sqlite`（任务历史）和 DSH profile 的
`cordis.patch.yml`（人设文本快照），**唯独没有 `persona.sqlite`**。而运行时的人格前缀取的
是 `PersonaStore.renderPrefix()`（`src/runtime/start.ts` 用它覆盖 DSH 的 personaPrefix），
不是 profile 文件。也就是说：一旦博士用 `prts persona` 定义过预设，导出→全新安装会丢人格，
而归档自己的核对完全看不出来——它只核对它搬了的东西。

当前真实数据根里 `persona.sqlite` 三张表都是 0 行，所以这个洞还没被踩到。

## 修复

`src/cli/archive.ts`：把 `persona.sqlite` 纳入与 memory/core 同一套处理——`VACUUM INTO`
导出、sha256 入 manifest、`PERSONA_TABLES` 三表计数入档并在导入后逐项核对。
文件落地复用 `manifest.sha256` 的既有复制循环，不需要额外路径。

测试 `test/cli/archive-persona.test.ts` 钉住：定义并激活一个人格预设 → 导出 → 导入全新
dataRoot → `activePreset()` 与 `get('prts').core` 一致。改前实测红
（`全新安装目录里必须有 persona.sqlite`）。

## 真实数据实测（`C:/prts-data`，1.4 MB）

| 项 | 结果 |
|---|---|
| 导出 | 54ms，产出 `core.sqlite` / `manifest.json` / `memory.sqlite` / `persona.sqlite` |
| 导入 | 13ms 到全新目录，无覆盖、无人工干预 |
| 计数 | 12 项逐项相等：`mem_turns` 4、`ledger_events` 3、`audit_events` 2、`tasks` 1、`mem_facts`/`mem_intents`/`mem_profiles`/`mem_summaries`/`mem_vectors` 0、`persona_*` 三表 0 |
| 链 | 导入侧由 `importArchive` 内部校验（`verifyChain`），未报断裂 |

## 边界

- 真实数据根的人格库为空，所以「人格预设跨安装一致」这条由单测覆盖，**没有真实规模数据**。
- 未覆盖：`emotion.sqlite` / `cost.sqlite` / `proactive.sqlite` / `reminders.sqlite`
  不参与归档。它们不属于 V1-12 原文的三项（记忆 / 人格设定 / 任务历史），
  但「导出即可迁移」的产品承诺若要覆盖情感与费用，需要另立条目。
