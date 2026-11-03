# 会话交接（2026-11-03 第二段）

**写给完全没有上下文的新会话**：本文自包含，不引用任何未落字的对话。读者看不到上一个会话的消息。

**范围**：工作区装配 ⑧ 的计量与跳过记录、工具循环检测、到期提醒折叠、循环检测落审计。5 个提交。

**触发本文的原因**：极限思考（`interference_search`）在本工作区不可用，根因是会话工作目录不是 git 仓库。博士手动把工作目录切到 `C:\prts-system` 后重开会话，本文是新会话的入口。

---

## 一、当前状态（2026-11-03 22:52 实测）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | 写本文时 `a894caf`；本文自身提交后为 `486908b`（核对时以 `git log --oneline -1` 为准） | `git log --oneline -1` |
| 分支 | `main` | — |
| 工作树 | tracked 干净；未跟踪项只有 `.rivet/scratch` 探针与一个 `nul` | `git status --porcelain` |
| 全量测试 | **494 pass / 0 fail**，40.1s，exit 0 | `node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"` |
| 类型检查 | `tsc -p .` exit 0 | `npm run typecheck` |
| 规模 | src 84 个 `.ts`；test 93 个测试文件 | `find` + `wc -l` |

---

## 二、本次 5 个提交

| 提交 | 内容 |
|---|---|
| `83c0272` | **注入清单落链**：每轮记忆注入后写 `injection.recorded` 事件（命中 id、种类分布、渲染后正文长度、条数上限）。**只计量，不裁剪** |
| `39d21c7` | **工具循环检测**：`ToolLoopGuard` 按 sessionId 分桶统计「同工具 + 同参数指纹」连续次数，达阈值 5 标记 suspect |
| `95f5062` | **到期提醒折叠**：超过 3 条折成「另有 N 条」，`maxVisible` 可配；折叠只改显示，`markFired` 仍遍历全部 |
| `37b75e9` | **注入跳过留痕**：`query-too-short` / `no-hit` 两条早退路径写 `outcome:'skipped'`；读取侧 `injectionRecords({outcome})`，旧事件缺 `outcome` 按 `injected` 读 |
| `a894caf` | **循环检测落审计**：`tool.loop.suspected` 进审计链；`attachToolLoopAudit(guard, sink)` 两层分离；sink 复用 `Authority` 的写连接（`get auditLog()`） |

### 关键设计决定（改之前先读）

- **⑧ 只计量不裁剪**：预算裁剪（③）是唯一会改变模型可见内容、且退化不报错的动作，没有 `used_chars` 真实分布前不做。三席评审（天权/天机/瑶光）一致。
- **`seen` 只登记真正进正文的命中**（`memory-inject.ts` 的 `injectedHitIds`）。将来加裁剪必须先把裁剪做在 `hits` 上再登记 seen，否则被裁条目会被永久记为已注入，该会话从此不再提它且不报错。
- **跳过记录只记两种**：`query-too-short`、`no-hit`。reject / step 重放 / messages 空属于「没有装配需求」，不记。
- **事件写失败不得阻断注入**：`recordOnce` 有独立 try/catch；不能落进 `memory-inject.ts` 的外层 catch（那里 `return decision` 会连带丢掉注入）。
- **`fold.ts` 的 `default` 抛错**：新增事件种类必须在 `applyMemoryEvent` 里显式接住，否则 `recordInjection` 会在同一事务里抛错回滚。

---

## 三、模块状态

### 已做

| 模块 | 状态 |
|---|---|
| 记忆检索/巩固/删除/纠正/阅读/精排 | 代码收口；产品口径 @5 28.8% → rerank 后 38.1% |
| 前瞻记忆 V1-14（W1–W3） | 表 + 状态机 + 触发注入 + `/intent` 命令 |
| 导出导入 V1-12 | 记忆/人格/任务历史三项齐全 |
| 工具结果卸载 `src/spill` | 完成 |
| 权限 K2a + K2b(net) | `authority.ts:176-190`：`system` / `exec` / `tool` 都有判定（README 里「暂不判定」那段已过期） |
| 上下文装配 ⑧（清单） | 注入与跳过都留痕；缺另三条早退 |

### 未做

| 项 | 阻塞 |
|---|---|
| ③ 预算裁剪 | 等 `used_chars` 真实分布；8000 这类常量两端都不成立 |
| ② 顺序通道 | `includeRuntimeContext` 打开后模型是否真看到未验证（探针 `markerIndex: -1`） |
| ⑥ 子任务上下文 | 依赖权限收窄能力（父会话 grant 对子会话直接生效） |
| ⑦ 跨会话连续（S4） | 无设计定稿：数据源怎么拼成「上次聊到哪里」 |
| 循环检测的自动动作 | 需真实误报率样本，现在样本通道（审计链）刚建好 |
| V1-05 情感 / V1-07 主动回忆 / V1-09 进化 / V1-11 语音 | `src/` 下 emotion / proactive / evolution / voice 各 **0 命中** |
| H3 shell 读隔离 | 四条系统层路径实测证伪；剩「专用账号 + 自研 spawn 层」，待架构决策 |

---

## 四、接手第一件事

```bash
cd C:/prts-system
npm run typecheck                                             # 期望 exit 0
node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts"   # 期望 494 pass / 0 fail
```

两条都绿之后，**验证极限思考在本目录可用**（这是本次切目录的目的）：

```
interference_search(action="search", task="<小且判据明确的任务>", verify="node --test <某个测试文件>")
```

preflight 应该通过（`git rev-parse --show-toplevel` 在 `C:\prts-system` 返回 `C:/prts-system`）。

### 极限思考在本工作区不可用的根因（别重复排查）

- `interference_search` 用**会话工作目录**解析仓库（内部 `resolveRepo()` 调 `git rev-parse --show-toplevel`），schema 里**没有 cwd 参数**。
- 会话在 `C:\tianshu` 时该命令 fatal；在 `C:\prts-system` 时正常。
- **两条被否决的替代方案**：
  - 在 `C:\tianshu` 里 `git init`：preflight 会过，但写工看到的是 `C:\tianshu` 的树（`tools` / `node_modules` / `.rivet`），PRTS 代码一行不在其中，搜索跑空。而且它建议的 `git add -A` 会把整个 `node_modules` 塞进索引。
  - 改天枢安装目录让它支持跨目录：`rivet-runtime\integrity.json` 有 298 个文件的 sha256 清单，改 bundle 会 integrity-blocked（该机器上发生过四次启动被拦）。

---

## 五、踩过的坑（会复发）

1. **`fold.ts` 的 `default` 抛错**。新增 `MemoryEventKind` 必须同步在 `applyMemoryEvent` 加分支，否则事件写入在同一事务里抛错回滚，而 `memory-inject` 的外层 catch 会把它连同注入一起吞掉——症状是「注入消失」，不是「报错」。
2. **`{...store}` 展开会丢原型方法**。测试里想 spy 一个 store 方法不能用展开（`search` 会变 undefined），用 `Proxy` 或 `Object.assign(Object.create(store), {...})`。
3. **不要用 python/shell 打补丁改代码**。本次会话犯过一次：加 import 用了 `python str.replace`（有 assert 锚点、事后 grep 验证了），但违反 `HANDOFF-20261103-session.md` 第五节「含转义的代码改动一律走 `edit_file`」。
4. **改一段声明时 `old_string` 多包一行会静默删掉它**。本次误删过 `authority.ts` 的 `protectedRoots` 字段声明，靠 `tsc` 抓回来。改声明块前先 `read_file` 看清边界。
5. **`StopController` 的 S1 会 `cancelAllTurns`**（`src/stop/index.ts` 的 `stop()`），所以循环检测没接自动停止——一次误报杀整轮对话。

---

## 六、证据边界（不要当成已验证）

- **真实 chat 只跑过一次**（2026-11-03 之前）：发「你好」，得到「收到」。所有对话链路的效果判断都来自离线基准与单测。
- **真实库 `C:/prts-data/memory.sqlite` 是 0 turn / 0 session / 0 向量**。
- **`used_chars` 没有任何真实分布**：新增的注入清单只在测试库里产生过数据。
- **`tool.loop.suspected` 没有真实样本**：阈值 5 是设计文档建议值，未被真实负载验证。
- **`tool.loop.suspected` 的校验只探过两条路径**：合法事件接受、空 `sessionId` 拒绝；`count` 非整数、`fingerprint` 为空未覆盖。
- **记忆 38.1% 是离线基准数字**，不是使用级结论。

---

## 七、文档位置

- 设计与计划：`C:\Users\Administrator\Desktop\设计和计划\`（先读其中 `README.md`）
- 仓内最新：`docs\context-assembly-status.md`（七条对账与 S1–S5 切片）、`docs\design-superagent-fusion.md`（五模块对账、W1–W3、否决清单）
- 资产总索引：`C:\Users\Administrator\Desktop\PRTS-INDEX.md`（注意：其中「85 pass」等验证数字已过期，以 `npm test` 当前输出为准）
