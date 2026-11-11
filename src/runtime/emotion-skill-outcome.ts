/**
 * 耦合边「学习→情感」：技能成败的情绪回音（DESIGN-05）。
 *
 * ③（DESIGN-04）让技能有了观测回音（`/skill show` 的归因数字）；这里让同一个
 * 回音进情感状态：带在场技能的任务验收成功/失败 → 一条 skill-outcome 情绪。
 *
 * 在场口径与 ③ 完全一致：至少一条 offer 携带该 taskId。注入只 offer active
 * 技能（`skill-inject.ts`），所以「在场」就是「已采用且被提供进这个任务」。
 * 不查结局时刻的相位——之后 retire/reject 不回溯抹掉当时的回音。
 *
 * 纯函数，不碰数据库：测试用独立构造的 offer 序列对照（内部自检不算验证）。
 */
import type { OfferRecord, SkillId } from '../skills/index.ts'

export interface OutcomeMood {
  valence: number
  arousal: number
  label: string
}

/** 欣慰：强于「被认可」(0.35)——学到的做法奏效是成长的直接信号。数值可调（D4）。 */
const GRATIFIED: OutcomeMood = { valence: 0.5, arousal: 0.35, label: '欣慰' }
/** 失落：低唤醒，区别于 error 的高唤醒「受挫」（emotion-trigger.ts 的既有区分）。 */
const DOWN: OutcomeMood = { valence: -0.35, arousal: 0.3, label: '失落' }

export interface OutcomeMoodSelection {
  mood: OutcomeMood
  /** 在场技能（去重，按首次提供顺序）。reason 审计用。 */
  skillIds: SkillId[]
}

/**
 * 任务结局 → 情绪选择。无在场技能返回 null——调用方回退既有 owner-feedback，
 * 行为逐字不变（D3：一次结局只写一条，覆盖语义下连写两条等于第一条白写）。
 */
export function selectOutcomeMood(
  offers: readonly OfferRecord[],
  taskId: string,
  outcome: 'success' | 'failure',
): OutcomeMoodSelection | null {
  const skillIds: SkillId[] = []
  const seen = new Set<SkillId>()
  for (const o of offers) {
    if (o.taskId !== taskId || seen.has(o.skillId)) continue
    seen.add(o.skillId)
    skillIds.push(o.skillId)
  }
  if (skillIds.length === 0) return null
  return { mood: outcome === 'success' ? GRATIFIED : DOWN, skillIds }
}