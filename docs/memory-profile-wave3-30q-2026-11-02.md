# 画像闭环 30 题全量复测（2026-11-02）

对 `single-session-preference` 全部 30 条题（该题型在评测集里的全量，不是抽样）重跑三组对照，
用于检验交接文档「画像 4/10 vs 纯 turn 1/10」这个结论。

---

## 结论（先说最重要的）

**前序「画像把 1/10 提到 4/10」不成立**：本轮同一批前 10 题，纯 turn 就有 4/10，
画像也是 4/10。30 题全量口径下画像 bm25 **反而比纯 turn 少 1 题**。

| 组 | 配置 | 30 题答对 | 相对 A |
|---|---|---|---|
| A | 纯 turn | **10/30 (33.3%)** | — |
| B | A + 画像（bm25，profileQuota=4） | **9/30 (30.0%)** | −3.3pp |
| C | B + 画像向量（semanticTopK=8） | **11/30 (36.7%)** | +3.3pp |

- 画像单独（bm25）**无增益**，与「画像检索是 preference 题的解」这一判断相冲突。
- 向量在画像之上多救 2 题（9→11），净效果相对纯 turn 只有 +1 题。
- **n=30 上 1 题的差异不足以支撑任何方向断言**。C 组多出的 11 题里，54026fce / 6b7dfb22 /
  1c0ddc50 是纯向量救回，1da05512 是向量弄丢——互有进出，不是单向提升。

## 三类信息分列

### 已核实（附来源）

- 判分器**独立复核** 12/12 = 100%（`.rivet/scratch/probe-judge-calib.mjs`，N=6 → 6 正例 + 6 负例）
- 30 题三组数字来自 `.rivet/scratch/wave3-30.log` 与 `.rivet/scratch/profile-wave3-30.json`，
  逐题判定见后文附表
- 画像生成：30 题共 833 条画像（origin=benchmark），向量化 833/833 成功
- 前 10 题的分组结果（本轮）：A 4/10、B 4/10、C 4/10 —— 与交接文档的 A 1/10 **不可复现**

### 为什么与交接文档矛盾

交接文档的对照「同 10 题纯 turn 检索 = 1/10」没有留存同口径的复现命令与配置。
本轮用同一脚本、同一判分器、同一 limit（8）跑前 10 题，纯 turn 是 4/10。两个可能：

1. 交接那次的「1/10」来自另一条链路（例如 fact 组或 10 题之外的配置）；
2. 或者来自 v2.16 的旧探针（自写排序，不是生产 `search()`）——交接文档自己也警告过
   「本会话三次用 A 验证、用 B 实现」。

无论哪种，**该对照都不能再作为「画像有效」的证据**。这正好复现了交接文档记录的第 1 条教训的变体：
小样本（n=10）+ 不可复现的对照 = 结论不可迁移。

### 未知（未解决清单）

1. **画像为什么在 30 题上没有增益**：833 条画像 / 30 题 ≈ 28 条/题，`profileQuota=4` 只取 4 条，
   其余被闸门挡掉。是闸门太窄，还是画像质量不够，本轮没有区分实验。
2. **1 题级别的差异是否稳定**：n=30 上 ±1 题完全在噪声内。要判定向量是否真有增益，
   需要把 30 题扩到 `single-session-preference` 之外的偏好类题（评测集没有更多），
   或换成多次判分取一致率。
3. **画像与 turn 的重复**：同一 session 既进 turn 池又进画像池时，两类命中内容高度重叠，
   画像没有提供「turn 里没有的信息」——这是增益为零的最可能解释，未验证。
4. **833 条 benchmark 画像仍在真机库里**（origin=benchmark，默认不进生产检索）。
   是否清理留给下一轮决定；备份在 `.rivet/scratch/profile-backup-1793550922889.json`。

## 本轮同时修正的数据问题

`probe-profile-wave3.mjs` 此前写画像时不传 `origin`，导致实验产物被标成 `live`。本轮：

- 历史 267 条画像一次性改判 `origin='benchmark'`（可回滚：`UPDATE mem_profiles SET origin='live' WHERE origin='benchmark'`）
- 删除前先备份到 `.rivet/scratch/profile-backup-*.json`
- 新写入的 833 条显式标 `origin='benchmark'`
- 清理只删 `origin='benchmark'` 的行，不碰任何真实生产记忆

## 逐题判定

| 题号 | A turn | B 画像 | C 向量 |
|---|---|---|---|
| 8a2466db | Y | Y | Y |
| 06878be2 | n | n | n |
| 75832dbd | n | n | n |
| 0edc2aef | Y | Y | Y |
| 35a27287 | Y | n | n |
| 32260d93 | n | n | n |
| 195a1a1b | Y | Y | Y |
| afdc33df | n | n | n |
| caf03d32 | n | n | n |
| 54026fce | n | n | **Y** |
| 06f04340 | Y | Y | Y |
| 6b7dfb22 | n | n | **Y** |
| 1a1907b4 | n | n | n |
| 09d032c9 | n | n | n |
| 38146c39 | n | n | n |
| d24813b1 | n | n | n |
| 57f827a0 | n | Y | Y |
| 95228167 | n | n | n |
| 505af2f5 | n | n | n |
| 75f70248 | n | n | n |
| d6233ab6 | n | n | n |
| 1da05512 | Y | Y | **n** |
| fca70973 | n | n | n |
| b6025781 | Y | Y | Y |
| a89d7624 | n | Y | Y |
| b0479f84 | n | n | n |
| 1d4e3b97 | n | n | n |
| 07b6f563 | Y | Y | Y |
| 1c0ddc50 | Y | n | **Y** |
| 0a34ad58 | Y | n | n |

## 复现命令

```sh
cd /c/prts-system

# 判分器校准（改判分 prompt 后必跑）
N=6 node --disable-warning=ExperimentalWarning .rivet/scratch/probe-judge-calib.mjs

# 30 题全量（约 20 分钟，零 API；本地 27B 生成画像 + bge-m3 向量 + 判分）
N=30 node --disable-warning=ExperimentalWarning --max-old-space-size=8192 .rivet/scratch/probe-profile-wave3.mjs
```
