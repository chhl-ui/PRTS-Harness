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
| **人格设定** | ⚠️ **不在导出范围**——人格的权威源是 DSH 的 `~/.dsh/profiles/desktop/cordis.patch.yml`，属于 harness 侧配置，不在本仓。V1-12 要完整通过，需要另做一个「人格设定导出」步骤，或把它纳入归档 |
| 会话日志（`dsh-home/sessions/`） | ⚠️ 不导出。它属于 DSH 侧，且体积远大于记忆库；V1-12 原文只要求记忆/人格/任务历史 |
| 密钥 | ✅ 不导出（`secrets/*.key` 不入档） |

## 测试覆盖（`test/cli/archive.test.ts`，5 例）

A1 导出产出 manifest + 两库副本且链状态入档 / A2 导入后条数与链逐项一致 /
A3 目标已有库时拒绝 / A4 manifest 被篡改时拒绝 / A5 导出到非空目录时拒绝。

真实往返冒烟：`C:/prts-data`（11-01 结构，缺 mem_intents）→ 导出 → 导入空目录 →
再导出，条数逐项一致。
