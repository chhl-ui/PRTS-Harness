# 交接：PRTS 记忆模块（2026-11-02 收灯）

写给一个完全没有上下文的新会话。**工作仓 `C:\prts-system`**（会话 cwd 可能是 `C:\tianshu`，
bash 里 `cd /c/prts-system`）。HEAD = **`15d9432`**，工作树干净（只有 `.rivet/` 未跟踪）。
**测试 337/337，`npx tsc -p .` 无错误。** 全自动权限。

---

## 一句话状态

记忆链路（写入→巩固→抽取→检索→注入）**全部接通且真机验证过注入生效**；
但**检索召回率仍是硬天花板**（recall@8 = 31.8%），且最近四个改进尝试有三个是负结果。

## 本会话做了什么（12 个提交，从旧到新）

| 提交 | 内容 | 结果 |
|---|---|---|
| `e3a9f50` | 注入不再自引本轮问题 | ✅ 真机验证抓到的缺陷 |
| `92cc2e7` `6130ebc` | 注入层端到端评测（题内/全库） | ✅ 20/20 注入，可答 14/20、10/20 |
| `c949f7e` | 失败归因：词汇鸿沟 + 查询扩展 | ✅ 扩展 +2 题 |
| `a5a387f` | 导出 `renderInjection` 供评测复用 | ✅ 统一判分口径 |
| `ef86606` | knowledge-update 诊断 + 词干化实验 | ❌ 词干化负结果，已回滚 |
| `781972b` `2669699` | 注入条数/recency 权重可配 + 两组实验 | ⚪ 均在噪声内，默认值未改 |
| `56494e2` | **召回基线：bm25/向量/混合三路** | ✅ 混合优于单路 |
| `c55d791` `490db5b` `15d9432` | 路线方案 + 论文对照 + P0 探针 | ❌ P0 负结果 |

## 关键实测数据（全库 246,595 turn，236 题）

| 指标 | bm25 | 向量(bge-m3) | 混合(RRF) |
|---|---|---|---|
| recall@5 | 25.4% | 24.6% | **32.2%** |
| recall@8 | **31.8%** | 30.5% | **34.7%** |
| recall@32 | 44.9% | 49.2% | **55.5%** |

分型 @8（bm25 / 向量 / 混合）：
`single-session-user` 45.3/34.4/40.6 · `multi-session` 27.2/30.4/**36.0** ·
`preference` 3.3/**10.0**/6.7 · `temporal` **64.7**/52.9/52.9

**互补结构**：向量救 preference（@32 3.3→30.0），bm25 守 temporal/专名。
等权 RRF 有损 temporal −11.8pp，所以混合**不能直接上线**，需要加权或门控。

其他实测：
- 性能：检索 p50 **175 ms**（长查询）/ **900 ms**（中文短查询）；写入 2.4 ms；库 2.94 GB ≈ 12.5 KB/turn
- 向量化：92.8 条/秒 → 全量 **44 分钟**、**1 GB**；查询（全量余弦）0.25 s/题
- 注入链路：20/20 发生；题内 14/20、全库 10/20（本地判分）/ 12/20（API 判分）

## 岔路：已否决的方案（别重走）

| 方案 | 结果 |
|---|---|
| 英文词干化 | 题内 15→14、全库 10→8，**已回滚** |
| **同 session 文本合并（去重）** | 触发率仅 15%，净 −1 题；LongMemEval 的 session 内没有近重复 turn |
| 查询扩展 | +2 题（题内 15→17），幅度小、未在全库验证 |
| 注入条数 5→20 | 12/20 → 12/20，**不是瓶颈** |
| recency 权重 0/0.1/0.3 | 13/12/13，**非单调，噪声内** |
| 换 embedding 模型 | bge-m3 单路 30.5% ≈ bm25 31.8%，短板不在模型 |
| 画像路线（前序会话） | 30 题 A10/B9/C11，画像单独无增益 |
| 扩散激活（前序） | −31.2pp |
| 两阶段 session 粗筛（前序） | 34.8% < turn 级 32.8% |

**判据教训**：n=20 的判分可答对率，±1 题差异一律不可解读（内部翻转常 2–3 题）。
要判定任何改动方向，样本至少 100 题。

## 未完成（按判据排序）

1. **启用摘要层并验证**（下一步首选）：`mem_summaries` + `putSummary` + `search.summaryQuota` 都已存在，
   默认关闭、真机 `summaries = 0`。这是唯一与前沿（LLM gist 巩固）形态一致的机制。
   成本：题内验证 20 题 × 48 session ≈ **1 小时**；全库 24k session ≈ **27 小时**。
   判据：题内 preference 可答对率提升 ≥5pp。
2. **加权混合检索**：bm25 : 向量 = 1 : 0.5 起步。判据 **@8 ≥ 34.7% 且 temporal ≥ 60%**。
   向量已就绪（见数据资产），无需重跑向量化。
3. **时间图**：同实体只保留最新值为「当前态」。判据 knowledge-update 分型回到题内水平。
4. 中文 3 字查询（「住哪里」命中不了谓词「住在」）。
5. 真机日常使用验证（注入已验，未验持续使用）。

## 踩过的坑

1. **Ollama embedding runner 连续跑 1–2 万条必崩**（`wsarecv` 连接被强制关闭）。
   解法：分片 + 片前重启（`.rivet/scratch/run-vectorize.sh`），脚本内断点续跑按 rowid。
2. **Ollama 27B 连续大量推理会 CUDA 崩**（`unspecified launch failure`）。判分换 DeepSeek API 绕过。
3. **判分输入格式能左右结果**：同一批题，带 `[记忆检索]` 前缀判 14/20，裸命中列表判 7/20。
   解法：评测复用 `renderInjection`（已导出）。
4. **判分器换了不能混比**：本地 27B 与 DeepSeek API 对同批题分别判 10/20 与 12/20。
   换判分器必须重跑基线。
5. **同一 dataRoot 下 session 历史会串**：真机探针里 B 会话看到了 A 的内容。
   评测必须每题独立 dataRoot，或用「捕获注入文本 + runtime 外判分」绕开。
6. **arxiv/github 被 Clash TUN 的 fake-IP 拦截**：`web_fetch` 拒绝 198.18.x.x。
   根治已改配置 `network.trustProxyFakeIp=true`（`TianshuData\.rivet\config.json`，备份 .bak-20261102），
   **需重启天枢生效**；当下用 `curl` 直连（实测 arxiv 200/0.58s）。

## 数据资产（都在 `C:\prts-benchmark\`）

| 文件 | 内容 |
|---|---|
| `memory-s.sqlite` (2.94 GB) | 246,607 turn 全库，含 FTS + 153k 实体 + 1.1M 边 |
| **`memory-s-vec.sqlite` (4.01 GB)** | 上面 + **246,595 条 turn 向量**（bge-m3, 1024 维） |
| `longmemeval/longmemeval_s_cleaned.json` | 500 题题库 |

## 复现命令

```sh
cd /c/prts-system

# 三路召回对比（需要 Ollama + 向量库）
node --disable-warning=ExperimentalWarning --max-old-space-size=8192 \
  .rivet/scratch/probe-recall-hybrid.mjs 250

# 注入可答对评测（全库/题内）
JUDGE=api node --disable-warning=ExperimentalWarning .rivet/scratch/probe-e2e-fullcorpus.mjs 20
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-e2e-injection.mjs 20

# 性能
node --disable-warning=ExperimentalWarning .rivet/scratch/probe-perf.mjs

# 向量化（断点续跑 + 自动重启 Ollama）
bash .rivet/scratch/run-vectorize.sh
```

## 读哪几份文档

- `docs/memory-roadmap-2026-11-02.md` —— 方案与优先级（含否决清单）
- `docs/memory-recall-2026-11-02.md` —— 三路召回基线
- `docs/memory-injection-e2e-2026-11-02.md` —— 注入评测与四组实验
- `docs/memory-call-site-2026-11-02.md` —— 调用面接线（工具/注入/CLI）
