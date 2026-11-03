/**
 * 情感状态的**结构**层：对外类型。
 *
 * 架构需求 §7 V1-05 的原文是三句话，前两句直接落在这个文件的形状里：
 * 「状态持久化，重启后保留」→ `EmotionState` 就是全部可持久化字段，没有任何
 * 进程内缓存字段、没有句柄、没有闭包状态；重开库读到的对象与关闭前逐字段相等。
 * 「情感变化不改变任何事实性回答」→ 这里**只有**两个连续维度加一个标签，
 * 没有 task / grant / skill / memory 之类的引用字段。情绪够不着事实层，
 * 是形状保证的，不是纪律保证的。
 *
 * 第三句「博士认可情感反应得体的至少 8 个」是人工验收，本模块只提供载体与
 * 运动规律（衰减），不预设「什么情况下该高兴」——空库渲染空串，而不是编一个默认心情。
 *
 * 与 `persona/types.ts` 的关键差别是 actor：人格只有 owner 能动，情绪多一个 `system`。
 * 这不是放宽，是错位——事件驱动的情绪（任务失败后的低落）必须由系统写入；
 * 让模型自己写，等于给了它一个「今天心情不好所以少答两条」的旋钮。
 */

/**
 * 谁能动情绪。
 *
 * - `owner`：博士本人。唯一能表达「我现在的心情」的来源。
 * - `system`：进程内的事件驱动通道，必须报出 `component`（哪个组件判定的），
 *   否则一条匿名情绪无从追溯，取证面就缺角。
 *
 * 模型不在其列——`{ kind: 'model', sessionId }` 会被 `EmotionStore.update` 抛 FORBIDDEN，
 * 且抛在任何写入之前（状态与 revision 一个字节都不变）。
 */
export type EmotionActor = { kind: 'owner' } | { kind: 'system'; component: string }

/**
 * 事件种类。目前只有一种：状态的整条覆盖。
 *
 * 情绪没有「撤回」，只有下一次覆盖与时间衰减——把 update 拆成
 * raised/lowered/reset 三种会让「当前是什么」需要重放算术，而情感的正确形态
 * 恰恰是「最近一次判定就是全部真相 + 时间把强度抹平」。
 */
export type EmotionEventKind = 'emotion.updated'

/**
 * 一个时刻的情绪状态（`emotion_state` 单行投影）。
 *
 * `updatedAt` 是衰减的零点，**不因衰减改变**：衰减是读时计算，
 * 一旦把衰减结果写回 `updatedAt`，同一个库在「读了几次」之后会给出不同历史，
 * 而链上一个字节都没变——那是无声漂移。
 */
export interface EmotionState {
  /** 效价 ∈ [-1, 1]：负=不快，正=愉快。 */
  valence: number
  /** 唤醒度 ∈ [0, 1]：0=低能量的平静，1=高度激活。 */
  arousal: number
  /** 情绪标签（「愉快」「焦虑」）。进表达层，不进事实层。 */
  label: string
  /** 事件时刻（毫秒）。衰减零点，不因衰减改变；label 同理。 */
  updatedAt: number
  /** 每次成功覆盖 +1。重放时靠它校验事件链与投影的顺序一致性。 */
  revision: number
}

/**
 * `update` 的入参。
 *
 * `reason` 必须有：情绪变化要留「为什么」，否则「悄悄改掉自己的底线」那种审计
 * 就退化成一个无来源的数值。`atMs` 省略等价于 `Date.now()`——测试要能钉住衰减零点，
 * 生产路径不该由调用方指定时间。
 */
export interface EmotionUpdateInput {
  valence: number
  arousal: number
  label: string
  reason: string
  atMs?: number
}

/** `emotion_events` 的一行。`seq` 参与哈希，`verifyChain` 必须原样回填。 */
export interface EmotionEventRow {
  seq: number
  revision: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
  prev_hash: string
  hash: string
}
