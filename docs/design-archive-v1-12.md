# V1-12 导出/导入（归档）

**验收原文**：「导出后导入全新安装，记忆、人格设定和任务历史逐项核对一致。」

```bash
prts archive export --data-root <d> --out <dir> [--force]
prts archive import --data-root <d> --archive <dir> [--force]
```

## 归档形态

```
<out>/
  manifest.json     # 格式版本、导出时刻、各表条数、两库 sha256、记忆链状态
  memory.sqlite     # VACUUM INTO 生成的一致副本
  core.sqlite       # 任务账本 + 审计链
```

## 三个设计决定

### 1. `VACUUM INTO` 而不是复制文件

SQLite 在 WAL 模式下，`-wal` 里可能还有未合并的页。直接 `copyFileSync` 会得到一个
**落后于真实状态**的库——症状是「导入后少了几条最近的记忆」，而且不报错。
`VACUUM INTO` 由 SQLite 自己保证副本与当前状态一致。

### 2. sha256 钉住内容

manifest 里记每个副本的哈希，导入前逐个核对。归档在传输或存放期间被动过
（哪怕尾部追加一个字节）就拒绝，不拿坏数据覆盖真实记忆。

**踩过的坑**：哈希必须在 `verifyChain()` **之后**算。链检查打开的是可写连接，
SQLite 会在这时把 WAL checkpoint 回主库；早算一步就会得到一个和落地文件对不上的哈希，
症状是「导出自检通过、导入时 sha 校验失败」。

### 3. 拒绝覆盖

- 导出到非空目录 → 拒绝（`--force` 放行）
- 导入到已有库的位置 → 拒绝（`--force` 放行）

两个方向都不可逆，宁可让调用方显式清场。

## 跨版本迁移

旧库可能没有新版本才加的表（例如 `mem_intents`）。`countIn` 对不存在的表返回 `-1`，
导入核对时**跳过 `-1`**：新库会把表建出来、计数为 0，拿 0 与 -1 比会把一次正常迁移
判成失败。这条是真实库冒烟时发现的（`C:/prts-data` 是 11-01 的结构，没有 mem_intents）。

## 核对方式

导入后不是「大概成功」，而是逐项断言：

1. 每个 `mem_*` 表的条数与 manifest 相等
2. `MemoryStore.verifyChain()` 必须 ok（事件链是记忆的事实来源，链断则投影不可信）
3. `core.sqlite` 的 `ledger_events` / `audit_events` 条数与 manifest 相等

任何一项不符都抛错，不返回部分成功。

## 已知边界

| 项 | 状态 |
|---|---|
| 记忆（turn/fact/profile/summary/intent/向量） | ✅ 全部随库搬走 |
| 任务历史（ledger + audit） | ✅ 两个库都在 core.sqlite |
| **人格设定** | ✅ 已覆盖（`--persona-path` / `PRTS_PERSONA_PATH`）。见下节 |
| 会话日志（`dsh-home/sessions/`） | ⚠️ 不导出。它属于 DSH 侧，且体积远大于记忆库；V1-12 原文只要求记忆/人格/任务历史 |
| 密钥 | ✅ 不导出（`secrets/*.key` 不入档） |

## 测试覆盖（`test/cli/archive.test.ts`，5 例）

A1 导出产出 manifest + 两库副本且链状态入档 / A2 导入后条数与链逐项一致 /
A3 目标已有库时拒绝 / A4 manifest 被篡改时拒绝 / A5 导出到非空目录时拒绝。

真实往返冒烟：`C:/prts-data`（11-01 结构，缺 mem_intents）→ 导出 → 导入空目录 →
再导出，条数逐项一致。

## 人格设定（2026-11-03 补）

人格不是独立文件——它嵌在 DSH profile 的 `cordis.patch.yml` 里：`agent-preset` 插件配置的
`persona.prefix`（一段多行 YAML 块）。2026-10-30 之前的 `dsh-system-prompt.personaPrefix`
已被删除（同文件第 33-40 行记了原因：preset 里的 `dsh-persona` 用同名 section 注册，
agent scope 会遮蔽部署级配置，写在那里对 standard preset 完全不生效）。

**做法：整份 profile 文件入档，不抽 persona.prefix。**

```bash
prts archive export --data-root <d> --out <dir> --persona-path <cordis.patch.yml>
prts archive import --data-root <d> --archive <dir> [--persona-path <落点>] [--force-persona]
```

为什么整份而不是只抽那一段：

- 抽出来要 YAML 解析 + 回写，**回写一旦格式漂移人设就静默失效**——这类失败没有任何报错，
  只表现为「它说话不像它了」。
- 整份复制 + sha256 比对，把「有没有变」变成可判定的；差异交给用户用 diff 看，
  而不是让程序替人决定哪些配置该合并。

为什么不像其他配置那样写默认路径：猜错位置会把别人的 profile 覆盖掉。所以
`--persona-path` 与 `PRTS_PERSONA_PATH` 二者都没有时，**不导出人格**，并在输出里明说。

导入策略：

| 目标状态 | 行为 |
|---|---|
| 不存在（全新安装） | 写入 —— 这是 V1-12「导入全新安装后人设一致」的实现路径 |
| 已存在且哈希相同 | 不动作，报告「已存在且一致」 |
| 已存在且不同 | **拒绝**，除非 `--force-persona`。不做 YAML 合并 |

实测（2026-11-03）：真实 profile `cordis.patch.yml`（15,239 bytes）→ 导出 → 导入到新落点 →
`diff` 逐字节一致。
