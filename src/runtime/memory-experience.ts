/**
 * 耦合边「记忆↔学习」：把任务验收结局构造成可召回的经验事实（DESIGN-08）。
 *
 * ③（DESIGN-04）让技能有了归因回音，DESIGN-05 让同一回音进情感状态（瞬时语气）；
 * 这里让它进记忆（可积累、可召回）：带在场技能的任务验收成功/失败 → 一条
 * confirmationBasis=`verifier` 的经验事实，经**既有** memory-inject 的 fact 通道
 * 按话题相关性召回（M→L 闭合，零新召回路）。
 *
 * 纯函数，不碰数据库：测试用独立构造的输入对照（内部自检不算验证）。在场口径与
 * DESIGN-05 完全一致（selectOutcomeMood 的 skillIds）；无在场技能 → null（D2 门控：
 * 无技能任务的 turn 已在情景记忆，本边是「学习=技能」的信号）。
 */
import type { AssertFactInput } from '../memory/index.ts'

/** 在场技能。标题缺省时回退短 id（与 chat.ts skillShortId 同口径：slice(0, 12)）。 */
export interface ExperienceSkill {
  id: string
  title?: string
}

export interface ExperienceFactInput {
  taskId: string
  outcome: 'success' | 'failure'
  /** 任务标题；缺省/空串回退 taskId（D3）。 */
  taskTitle?: string
  /** 在场技能（selectOutcomeMood 的 skillIds 解析标题后）。空 → null（D2）。 */
  skills: readonly ExperienceSkill[]
  /** 该任务最新结局事件的账本 seq（D4，链上可追溯）。 */
  outcomeSeq?: number
}

/** 重要性基线（D6 待验证假设：成功/失败暂不分档——教训/反例同样有价值）。 */
const EXPERIENCE_IMPORTANCE = 0.5

/**
 * 结局 → 经验事实 input。无在场技能返回 null。
 *
 * 形状（D3）：subject=`我`（人格中性，避免硬编码人格名），predicate=`做过`，
 * object 带标题+结局+在场技能（可召回），slot=标题（话题召回用，assertFact 规范化；
 * **不开 supersedeSameSlot**——每段经历并存不取代）。actor=system，provenance=inferred，
 * confirmationBasis=verifier（来自账本验收，非模型自报），retentionClass=retirable
 * （经验可淡忘，非身份级 permanent）。derivedFromTaskId/outcomeSeq 进载荷（D4，
 * fold 不读 → 重建不变）。
 */
export function buildExperienceFact(input: ExperienceFactInput): AssertFactInput | null {
  if (input.skills.length === 0) return null
  const title = input.taskTitle === undefined || input.taskTitle === '' ? input.taskId : input.taskTitle
  const names = input.skills
    .map((s) => (s.title !== undefined && s.title !== '' ? s.title : s.id.slice(0, 12)))
    .join('、')
  const verdict = input.outcome === 'success' ? '验收通过' : '被驳回'
  return {
    actor: 'system',
    subject: '我',
    predicate: '做过',
    object: `任务《${title}》${verdict}；在场技能：${names}`,
    slot: title,
    provenance: 'inferred',
    confirmationBasis: 'verifier',
    origin: 'live',
    importance: EXPERIENCE_IMPORTANCE,
    retentionClass: 'retirable',
    derivedFromTaskId: input.taskId,
    outcomeSeq: input.outcomeSeq,
  }
}