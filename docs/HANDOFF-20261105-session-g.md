# 会话交接（2026-11-05 第七段）

**写给完全没有上下文的新会话**：本文自包含，不引用任何未落字的对话。

**起点**：上一份是 `docs/HANDOFF-20261105-session-f.md`（第六段，HEAD 约 `7247793`）。
**本段范围**：Wave 3 收尾后的全部工作——真机端到端、`/new`、授权翻牌、冒烟体检、
V1-17 基线回归、V1-18 宿主装配 vs 模型自管、本地 27B 复跑、全量挂起修复、文档漂移修正。

---

## 一、当前状态（2026-11-05 收尾实测）

| 项 | 值 | 证据 |
|---|---|---|
| HEAD | `01195d5` | `git log --oneline -1` |
| 全量测试 | **796 pass / 0 fail**，3 连跑全绿、0 挂起 | `/tmp/final3_1..3.log` |
| typecheck | `tsc -p .` 0 错误 | `/tmp/tc8.log` |
| 工作树 | tracked 干净；未跟踪只有 `.rivet/`、`nul` | `git status` |

测试命令：`node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/all.log 2>&1; echo "TEST_EXIT=$?"`。

---

## 二、本段提交（按时间）

| 提交 | 内容 |
|---|---|
| `e482473` | `/switch` 会话切换（agent/sessionId 可替换、丢旧会话 pending 审批） |
| `b484678` | Wave 3 分派器（`dispatcher.ts` 并发池 + `/dispatch` 命令） |
| `55b0f61` | 客户端寿命与运行时寿命解耦（`terminal-server` 会话代际 + `chat-serve` accept 循环 + `runChat` 续接复用 agent） |
| `36f3fd5` | T3 dispose 入 finally（第一次挂起修复）+ 交接文档 session-f |
| `bad1fc1` | 授权翻牌：未注册会话写权限 `defer` → **deny**（6 个 fixture 补注册、2 条特性化断言翻转） |
| `4941f0b` | `/switch` 与分派器真机端到端（真实 runtime + scripted LLM，判据是 assistant/message 归属） |
| `0ff9149` | `/new` 新建会话（先注册后 create、失败释放、与 `/switch` 共用 `applySwitch`） |
| `68fea49` | dispatcher barrier 构造（消除并发时序假设） |
| `f6163cc` | `chat-client` 断线自动重连（重读 endpoint + 退避 + `/exit` 主动退出） |
| `7247793` | 交接文档补冒烟体检结果（真实 key 下 exit=0） |
| `440acd2` | 文档漂移修正（AGENTS.md 定位段、README 状态与 K2a 范围、交接未做清单） |
| `c11d478` | **V1-17 基线回归 + V1-18 首轮**（DeepSeek，n=30） |
| `d95655b` | **V1-18 本地 27B 复跑**（零 API key）+ `PRTS_LLM_MODEL` 覆盖 |
| `01195d5` | **全量偶发挂起修复**（T1/T2 dispose、after 容错、transcript 按条数等待、spawnSubtask 摘要轮询） |

---

## 三、已完成的验证（带证据，不要当"未验证"处理）

| 项 | 结果 | 出处 |
|---|---|---|
| 全量基线 | 796/796 × 3 连跑，0 挂起 | `01195d5` 之后 |
| 全量挂起根因链 | 单文件第 8 次复现（exit=124）→ 三链修复 → 单文件 10 连跑 0 挂起 | session-f §三「第二次定位」 |
| V1-17 检索基线 | any@8 **38.8%**、all@8 23.4%、MRR 0.2424、556ms/题——与 §9.3 的 v2.8 逐项一致，**未漂移** | `docs/design-memory-v1.md` §9.3 |
| V1-18 DeepSeek n=30 | 宿主 46.7%（14/30） vs 自管 43.3%（13/30）；宿主 input token +27% | `docs/v1-18-host-vs-self-2026-11-05.md` §二 |
| V1-18 本地 27B n=30 | 宿主 50.0%（15/30） vs 自管 43.3%（13/30）；宿主 input token +25% | 同文档 §五 |
| 冒烟体检 | 最小 + 完整（EMBED/RERANK）均 exit=0，key 从凭据管理器读出 | 同文档 / session-f §五 |

---

## 四、未完成事项（本段重点）

### 4.1 可立即做（无外部阻塞、判据可自动化）

| # | 项 | 判据 / 命令 |
|---|---|---|
| 1 | **V1-18 扩样到 100+ 题**（本地零成本） | `LOCAL=1 N=100 OUT=... node scripts/eval-v1-18-ab.mjs`；约 1.5-2 小时。当前 n=30 差 1-2 题无统计意义 |
| 2 | **V1-16 检索延迟破线** | `single-session-assistant` 1019ms/题 > 1 秒线（§9.3）。修法方向：降 RRF 候选宽度 `limit*4 → limit*2`，用 `scripts/eval-longmemeval-retrieval.mjs` 量化，分数下降则不采用 |
| 3 | **V1-12 导入导出核对** | 机制已有（`src/cli/` 导出/导入），缺「导出 → 全新安装 → 逐项核对」实测 |
| 4 | **V1-17 持续回归** | 每次改检索策略重跑 `scripts/eval-longmemeval-retrieval.mjs`，结果追加 §9.3 表 |
| 5 | **K2b：exec/tool/system 能力判定** | 守卫当前只过滤 `fs.*` + `net.*`（`start.ts:406-407`）；工作量大，需先设计 |

### 4.2 需要真实使用或外部条件

| 项 | 阻塞 |
|---|---|
| 常驻 Router 第二步（多入口并发、Router 上下文预算） | 设计明确「验收指标只能在真实使用中取，属 R2 之后」（`design-superagent-fusion.md` §四） |
| W1 停机权 | 等真实误报率数据（设计写明） |
| V1-02 第二提供方 | 缺第二个 provider key |
| V1-11 语音 | 音频栈 |
| V1-04 普瑞赛斯人格 | 人格文本待博士审定 |
| V1-05 情感样本 | 需博士提供 10 个情境样本 |
| V1-15 主题目录 | section + 10 题内容待定 |
| V1-10 真实任务 | 科研/日常各一个真实成果 |
| V1-07 七天试用 | 博士盲评 ≥70% |
| V1-09 真实进化流程 | 机制已有，缺一次真实「经验→候选→评估→采用」+ 回退演练 |
| V1-13 连续使用 | 自动化部分已有（`v1-13-daily-soak`），人工部分待真实使用 |

### 4.3 本段新增的局限（不要当成已验证）

- **V1-18 本地版判分是同模型自判**（`q38-gsq-iq3s` 判自己），偏差比 DeepSeek 版更大；
  两版绝对分数不可直接比较，只能看方向。
- **V1-18 n=30 样本不足**：准确率差 1-2 题在噪声内；要判断差异需 100+ 题。
- **「模型自管」是简化版**：无自动注入 + `prts_memory_recall` 工具，**不是** MemGPT 式换页；
  结论不能外推到「完整自管」。
- **挂起修复不是统计证明**：3 连跑全绿、单文件 10 连绿，但概率上仍可能复现；接手先跑 3 连确认。
- 全量挂起修复覆盖已知三类路径（dispose 泄漏 / 半截日志 / after EPERM），若再挂按
  session-f §三的纪律定位，不要直接重跑。

---

## 五、本段关键决定（下一个人必须知道）

1. **授权翻牌已落地**：`decideSessionScoped` 的未注册分支 = deny。生产只有 `runChat` 一处
   `agents.create`（注册后进入主循环），未注册会话在生产不出现。
2. **客户端寿命解耦**：`terminal-server` 的 `accept()` 每次客户端连接是一代会话；断开只结束本代，
   `close()` 才是终局；`runChat` 优先复用 `agents.get(sessionId)`，续接时 `seenSeq` 对齐日志最大 seq。
3. **本地模型接线**（零 key）：
   - `DEEPSEEK_BASE_URL=http://127.0.0.1:11434`（Ollama 的 `/v1/messages` 兼容 Anthropic 协议）
   - `PRTS_LLM_MODEL=q38-gsq-iq3s`
   - `DSH_CONTEXT_WINDOW=32768`（Ollama 实际窗口；不设会按 1M 预算注入后被静默截断）
   - Ollama **不常驻**：先 `"%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve`
4. **V1-18 实验协议**：同一批分层题、同库（origin 改 live）、两种模式（默认注入 vs `PRTS_MEMORY_INJECT_BUDGET=0` + recall 工具），
   判分 `scripts/eval-longmemeval.py`；token 从 `agent/assistant-stream` 的 usage chunk 统计（session 日志不一定写 usage）。
5. **挂起修复的三链**：测试里「创建资源后断言」一律 `try/finally` 释放；日志读取按**期望条数**等待且不累加；
   after/cleanup 失败不把文件标红。产品侧 `spawnSubtask` 读摘要要轮询落盘（3s）。

---

## 六、接手第一件事

```sh
cd C:/prts-system
npm run typecheck
for i in 1 2 3; do node --disable-warning=ExperimentalWarning --test "test/**/*.test.ts" > /tmp/t$i.log 2>&1; echo "run $i exit=$?"; grep -E "^ℹ (tests|pass|fail)" /tmp/t$i.log; done
```

期望：typecheck 0 错误、**796/796 × 3、0 挂起**。

两条都过之后，从 §4.1 挑一项：优先 **V1-18 扩样 100+**（零成本、把首轮的方向性结论做成统计结论）
或 **V1-16 延迟破线**（V1 硬指标、判据明确）。
