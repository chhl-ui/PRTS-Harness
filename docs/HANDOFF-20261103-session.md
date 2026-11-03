# 会话交接（2026-11-03）

**会话范围**：记忆模块判据复测与加固 → V1-14 前瞻记忆 → V1-12 导出/导入 → K2b net 守卫。
21 个提交，工作区干净（`git status` 仅剩 `nul` 与 `.rivet/scratch` 探针）。

---

## 一、交付清单

| 提交 | 内容 |
|---|---|
| `a5b0338` | 记忆判据复测：加权混合全量达标（@8 36.9%）、50k cap 下失效（30.9%）、阅读阶段 A/B 净 0 |
| `7bc5a71` | k 曲线：**40.7% 的题前 64 名无 gold**——换 embedding 模型不是第一顺位 |
| `90b14e1` | 索引修复的产品口径 +3.4pp（p=0.15）；参数四组全等 33.9%（调参已死） |
| `a8ac8fa` | **内存向量索引**：绕开 `SEMANTIC_SCAN_CAP` 的 19.9% 截断，预热 247,428 行 / 3.4 s |
| `b9d4dee` | reranker 实测 +10.6pp（p=0.0000），优先级高于换 embedding |
| `df0f6f3` | bge-reranker-v2-m3 实测 43.6%，**输给 22M 的 ms-marco**（44.5%）；sparse 成本 6 小时 |
| `5fa893d` | 产品口径纠正：**@5 / 候选 15**，基线 28.8% → 38.1%（p=0.0000）；真实库 0 turn |
| `bcc4203` | **交叉编码器精排接入**（`PRTS_RERANK=1`），子进程 NDJSON |
| `5ed8e4b` | 记忆模块冻结交接（已验/未验/验收步骤） |
| `f7ce6d6` | V1-14 立项：实测否决 chrono-node 中文（7/10），改「模型给绝对时刻 + 本地校验」 |
| `5d582f8` | V1-14 W1：`mem_intents` 表 + 三个事件 + 状态机 + 时间闸门 |
| `a7f51fc` `929395f` `c7d2c6a` | V1-14 W2：`prts_intent_create/list`（含一次根因修复，见第五节） |
| `c2f37f2` | V1-14 W3：触发注入（挂 pre-step，准点 + 启动补发） |
| `bdab77d` | `/intent` 所有者命令（列出 / 前缀取消 / `--all`） |
| `de1f018` | V1-12 导出/导入（`VACUUM INTO` + sha256 + 逐项核对） |
| `e3feb57` | 人格设定入档（整份 profile，V1-12 三项齐全） |
| `783bdf1` | K2b net 守卫接进 `tools.guard` |
| `1e990d9` | net 白名单（`PRTS_NET_ALLOW`）+ 服务端搜索的边界说明 |

---

## 二、当前各模块状态

| 模块 | 状态 |
|---|---|
| 记忆（检索/巩固/删除/纠正/阅读/精排） | **代码收口**，真实验收未跑 |
| 前瞻记忆 V1-14 | W1–W3 完成，W4 需真实使用 |
| 导出导入 V1-12 | 记忆 / 人格 / 任务历史三项齐全，未做跨机验收 |
| 权限 K2a + K2b(net) | fs 三类 + net 已管辖；**exec / system / tool 仍豁免** |
| 联网搜索 | 本地无工具；server-side 因适配器不支持而接不上 |

### 可复核的关键数字

- 产品口径 @5：**28.8% → rerank 后 38.1%**（+22 题，McNemar p=0.0000）
- 候选池内召回上限：**41.9%**（候选 15 全收，rerank 增量为 0）
- k 曲线：vec@8 30.5% / @32 49.2% / @64 59.3%；**40.7% 前 64 无 gold**
- 索引预热：247,428 行 / dim 1024 / **3.4 s**
- 全量测试：`test/**/*.test.ts` **463 pass / 0 fail**（39.3 s，本会话最后一次实测）
- 真实库 `C:/prts-data/memory.sqlite`：**0 turn / 0 session / 0 向量**

---

## 三、下一步（按优先级）

0. **真实使用推迟到整体完工后（博士 2026-11-03 决定）**。因此开发期只做 **R1 工程完工**
   （测试全绿、typecheck 退出 0、离线基准达标），V1-01…V1-13 属于完工后的 **R2 验收完工**。
   **唯一保留的例外是每周冒烟**：`PRTS_EMBED=1 PRTS_RERANK=1 node src/cli/chat-main.ts`
   发一句「你好」。它防的不是功能退化，是启动链路腐烂——依赖漂移、ACL 授权失效、key 过期、
   沙箱后端在系统更新后变行为，这些全在单测覆盖之外（单测用临时目录 + scripted LLM）。
1. ~~让 PRTS 真正跑起来（V1-13）~~ → 改为 R2 阶段验收，不再作为开发期第一优先。
2. **多条到期提醒的折叠**（未做）。现在 `intent-trigger` 把所有 due 拼成一条墙；超过 N 条应折叠成「另有 X 条待处理」。规则实现，20 行以内。
3. **工具循环检测**（未做）。`supervisor` 只答「进程活着吗」，不答「是否原地打转」。接在 `tools/result` 上：连续 N 次相同工具 + 参数近似 → 标记疑似循环 → 交 `StopController`。
4. **索引粒度**（记忆唯一还有 17pp 空间的方向）。但 v2.11 的 session 两阶段粗筛已被实测否决（38.8% → 34.0%），不能重走。

---

## 四、四个零代码的验收项（未开工）

V1-05 情感、V1-07 主动回忆、V1-09 进化、V1-11 终端语音——`src/` 下对
emotion / proactive / evolution / voice 全部零命中。其中只有 V1-07 是记忆的自然延伸。

---

## 五、本会话踩过的坑（都已修，但会复发，记下来）

1. **`output.render` 缺失 → 症状离原因一整条生命周期**。`dsh-tools` 的 `register` 要求
   `output` 带 `render` 函数，只给 `schema` 会抛 TypeError；抛错点在 `layers.effect` 里
   被咽掉，启动不报错，但 effect 停在不完整状态，`ctx.fiber.dispose()` 时清理链断掉，
   排在后面的 `memory.close()` / `ledger.close()` 全不执行 → 两个 sqlite 句柄泄漏 →
   临时目录清理 EPERM。**新增工具一律用 `outSchema()`，不要手写 `output`。**
2. **sha256 必须在 `verifyChain()` 之后算**。链检查打开的是可写连接，SQLite 会在这时
   把 WAL checkpoint 回主库；早算一步会得到与落地文件不符的哈希。
3. **跨版本导入的 `-1`**。旧库没有新表时 `countIn` 返回 -1，新库会建表计数 0，
   拿 0 与 -1 比会把正常迁移判成失败——核对时跳过 -1。
4. **不要用 python `str.replace` 打补丁**（无 assert 会静默失败）。本会话出现过两次：
   一次 patch 未生效（`grep -c` 才发现），一次把字符串里的 `\n` 变成真换行导致语法错。
   **含转义的代码改动一律走 `edit_file`，不经过 shell 拼接。**
5. **对照实验要干净**。上一版把 SP5 的 EPERM 误判为「注册额外工具导致 DSH 脆弱」，
   依据是加了一个 dummy 工具也复现——但那个 dummy 同样缺 `render`，等于用同一个 bug
   复制了一次现象。隔离变量时，对照组必须是**合规实现**。

---

## 六、证据边界（不要当成已验证）

- **真实 chat 只跑过一次**：发「你好，请只回复两个字：收到」，得到「收到」。除此之外
  所有对话链路的效果判断都来自离线基准与单测。
- **Super-agent 架构来自二手转述**（prototype 仓库 + ithome/donews/techweb），
  未读原始技术文档全文。所以「文章未提权限模型」≠「它没有权限模型」。
- **服务端搜索的边界**：DeepSeek 的 Anthropic 端点**实测会真的执行 `web_search_20250305`**
  （模型自选 query、返回真实 URL、计费 `web_search_requests: 2`），但 PRTS 当前
  `llm-deepseek` 走 OpenAI 兼容适配器，**没有挂 server-side tool 的位置**。
  换适配器前，不得声称 PRTS 有联网搜索。
- **V1-16 的 P95 ≤ 1s 未测**。已有的延迟数据是单点（索引预热 3.4 s、rerank 热进程 5 ms/3 对），
  不是装配链路的 P95。

---

## 七、接手第一件事

```bash
cd C:/prts-system && npm run typecheck        # 应为 exit 0
node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" | tail -5   # 基线 463 pass / 0 fail
node src/cli/prts.ts archive export --data-root C:/prts-data --out /tmp/check   # 冒烟
PRTS_EMBED=1 PRTS_RERANK=1 node src/cli/chat-main.ts   # 带记忆与精排的真实会话
```

最后一条是重点：**带 `PRTS_EMBED=1` 与 `PRTS_RERANK=1` 跑一次真实对话**，看启动日志里
是否有 `[prts] memory vector index warmed: 247428 rows`，以及精排是否按预期生效。
这两条一旦在真实会话里跑通，V1-06 的验收才算真正开始。
