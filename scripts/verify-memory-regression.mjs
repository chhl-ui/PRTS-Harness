#!/usr/bin/env node
/**
 * V1-17 记忆检索回归守卫。
 *
 * **判据原文**（架构需求 §7）：「在 LongMemEval、LoCoMo 中至少一个基准上建立首次分数基线；
 * 之后每次修改记忆或检索策略都重跑，**分数下降则不采用**。」
 *
 * 这个脚本补的就是「之后每次」——在此之前，重跑全靠人记得，没有任何强制点。
 *
 * ## 为什么用零容差
 *
 * 检索是确定性的（FTS5 + LIKE + 固定排序，无采样），同一份代码同一份库必然给出同一批数字。
 * 所以任何下降都是真实变化，不需要留「噪声余量」——留了反而会掩盖小幅退化。
 * 唯一例外是样本数变化：换样本集必须显式 `--update`，否则拒绝比较（比较不同分母没有意义）。
 *
 * ## 用法
 *
 * ```sh
 * npm run verify:memory                # 跑全量并与基线对比，下降则退出码 1
 * npm run verify:memory -- --update    # 有意改动后重建基线
 * LIMIT_Q=50 npm run verify:memory     # 快速冒烟（分母变了，只与同分母基线比）
 * ```
 *
 * 前置：`C:/prts-benchmark/memory-s.sqlite`（s_cleaned 全量 246,607 turn）与源数据。
 * 缺了会由 eval 脚本报错，本脚本不猜。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const BASELINE = process.env.BASELINE ?? 'bench/memory-baseline.json'
const OUT = join(tmpdir(), `mem-regression-${process.pid}.json`)
/** 这三项任一下降即「分数下降」。any32/all32 作参考但不设门——它们不是验收口径。 */
const HARD = ['any8', 'all8', 'mrr']

const update = process.argv.includes('--update')

const run = spawnSync(
  process.execPath,
  ['--disable-warning=ExperimentalWarning', 'scripts/eval-longmemeval-retrieval.mjs'],
  { env: { ...process.env, OUT }, stdio: 'inherit' },
)
if (run.status !== 0) {
  console.error('\n评测脚本本身失败，没有可比对的分数。')
  process.exit(2)
}

let cur
try {
  cur = JSON.parse(readFileSync(OUT, 'utf8'))
} catch (e) {
  console.error(`\n评测没有产出结果文件（${OUT}）：${e instanceof Error ? e.message : String(e)}`)
  process.exit(2)
}

const stamp = { ...cur, establishedAt: new Date().toISOString() }

if (!existsSync(BASELINE)) {
  mkdirSync(dirname(BASELINE), { recursive: true })
  writeFileSync(BASELINE, JSON.stringify(stamp, null, 2))
  console.log(`\n基线已建立：${BASELINE}（n=${cur.n}）`)
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'))
if (base.n !== cur.n) {
  console.error(`\n样本数变了（基线 n=${base.n} vs 本次 n=${cur.n}）。换样本集请显式 --update，不同分母不能比。`)
  process.exit(2)
}

console.log('\n=== V1-17 回归对比 ===')
let failed = 0
for (const k of HARD) {
  const b = base[k]
  const c = cur[k]
  const delta = c - b
  const bad = delta < 0
  if (bad) failed += 1
  const sign = delta >= 0 ? '+' : ''
  console.log(
    `${k.padEnd(6)} 基线 ${b.toFixed(4)} → 本次 ${c.toFixed(4)}  ${sign}${delta.toFixed(4)}  ${bad ? '下降' : 'ok'}`,
  )
}

if (update) {
  writeFileSync(BASELINE, JSON.stringify(stamp, null, 2))
  console.log(`\n基线已更新：${BASELINE}`)
  process.exit(0)
}

if (failed > 0) {
  console.error(`\n${failed} 项低于基线——按 V1-17，本次改动不应采用。`)
  process.exit(1)
}
console.log('\n全部不低于基线。')
process.exit(0)
