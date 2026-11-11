/**
 * 耦合边 ③：技能 × 任务结局归因（DESIGN-04）。
 *
 * 回答「这条技能用过之后任务成没成」。连接键在写侧已经埋好：`skill.offered`
 * 载荷里的 taskId（提供时从账本 `taskForSession` 读来）；结局来自账本验收事件
 * （`Ledger.outcomeEvents`），**不是模型自报**——claimDone 不算成功。
 *
 * ## 为什么是读时派生视图，不是新事件
 *
 * 写时归因（结局发生时往技能链追加事件）要处理跨库写耦合、钩子幂等、重放去重；
 * 收益只有查询快。技能量级个位数到几十条，读时 join 两条链的成本可忽略，
 * 换来的是：零新写入、零新投影、rebuildProjections 后数字不变、与账本永远一致。
 * 与 `usageStats` / `adoptedBy` 的「查链即可」同风格。
 *
 * ## 语义边界（写死在这里，消费方不得自行放宽）
 *
 * - 归因单位是 (技能, 任务)：技能对任务在场 = 至少一条 offer 带该 taskId。
 *   同任务多条 offer 不重复计数——计数跟着结局回合走。
 * - 每个结局回合给所有在场技能各记一份。**相关性，不是因果**：不做因果拆分，
 *   不自动改技能相位。它是观测证据，给评估与退役用。
 * - 无 taskId 的 offer（没绑任务 / 旧格式事件）不参与归因。
 * - 有 offer 但任务还没结局的技能不出现在结果里——消费方按零处理，
 *   「没回音」与「回音是零」不是一回事，不要替它补零行。
 *
 * 纯函数，不碰数据库：测试用独立构造的事件序列对照（内部自检不算验证）。
 */
import type { OfferRecord, SkillId } from '../skills/index.ts'

/** 账本结局记录（`Ledger.outcomeEvents` 的返回项；taskId 品牌在此结构兼容）。 */
export interface OutcomeRecord {
  seq: number
  taskId: string
  outcome: 'success' | 'failure'
  ts: number
}

/** 一次归因回合：能追到是哪条账本事件给的数。 */
export interface AttributionEpisode {
  taskId: string
  outcome: 'success' | 'failure'
  ts: number
  ledgerSeq: number
}

export interface SkillAttribution {
  success: number
  failure: number
  episodes: AttributionEpisode[]
}

export function attribute(
  offers: readonly OfferRecord[],
  outcomes: readonly OutcomeRecord[],
): Map<SkillId, SkillAttribution> {
  // 技能 → 在场任务集合。Set 天然吃掉同任务的重复 offer。
  const tasksBySkill = new Map<SkillId, Set<string>>()
  for (const o of offers) {
    if (o.taskId === undefined) continue
    let tasks = tasksBySkill.get(o.skillId)
    if (tasks === undefined) {
      tasks = new Set()
      tasksBySkill.set(o.skillId, tasks)
    }
    tasks.add(o.taskId)
  }

  const result = new Map<SkillId, SkillAttribution>()
  for (const outcome of outcomes) {
    for (const [skillId, tasks] of tasksBySkill) {
      if (!tasks.has(outcome.taskId)) continue
      let attr = result.get(skillId)
      if (attr === undefined) {
        attr = { success: 0, failure: 0, episodes: [] }
        result.set(skillId, attr)
      }
      if (outcome.outcome === 'success') attr.success += 1
      else attr.failure += 1
      attr.episodes.push({
        taskId: outcome.taskId,
        outcome: outcome.outcome,
        ts: outcome.ts,
        ledgerSeq: outcome.seq,
      })
    }
  }
  return result
}