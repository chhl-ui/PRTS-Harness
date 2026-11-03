/**
 * 人格设定的**结构**层：对外类型。
 *
 * 两条需求直接落在这里：
 * - 架构需求 §7 V1-09：「人格核心设定未经确认不能被改动」。
 * - 架构需求 §7 V1-04：「切换人格前后任务与权限不变」。
 *
 * 第二条要求落到类型上只有一件事——**人格只有「内容」，没有任何「能力」字段**。
 * 这里没有 capability / grant / tool / task 之类的字段，`PersonaStore` 上也不会有
 * 对应方法：切换人格在机制上就不可能改动任务或权限，因为它压根够不着那两张表。
 * 这不是靠纪律，是靠形状。
 *
 * 人格**内容**（口头禅、播报格式、对博士的态度）需博士审定，本模块只提供载体，
 * 不预设任何默认人设——空库渲染出空字符串，而不是一段编好的人格。
 */

/**
 * 谁能动人格。与账本（模型只能建 draft）、技能（模型只能 propose）同构：
 * 人格是**底线**，只有 owner 能定义、改核心、切换。
 */
export type PersonaActor = { kind: 'owner' } | { kind: 'model'; sessionId: string }

export type PersonaEventKind =
  | 'persona.defined'
  | 'persona.core-changed'
  | 'persona.style-changed'
  | 'persona.switched'

/**
 * 一个预设的当前状态（投影）。
 *
 * `core` 是底线（V1-09 管着它）；`style` 是表达方式。分开存不是为了好看：
 * 两者的改动权限与取证价值不同，混成一个字符串就再也分不出「改了语气」和「改了底线」。
 */
export interface PersonaPreset {
  /** 预设名（'prts' / 'priestess'）。 */
  preset: string
  /** 乐观并发：每次成功变更 +1，调用方改核心须带对的 revision。 */
  revision: number
  /** 核心设定。**未经 owner 确认不可改**，每次改动进链并留前后值。 */
  core: string
  /** 风格。可以为空串（「不加风格」是合法选择）。 */
  style: string
}

/** 改核心 / 改风格时的定位：预设名 + 调用方看到的修订号。 */
export interface PersonaRef {
  preset: string
  revision: number
}

/** `define` 的入参。`style` 省略等价于空串。 */
export interface PersonaDefineInput {
  preset: string
  core: string
  style?: string
}

/**
 * 核心设定的一次取值——`coreHistory` 的元素。
 *
 * 「谁（`by`）、什么时候（`atMs`）、改成了什么（`value`）」三件事齐了，
 * 才叫「悄悄改掉底线要查得出来」。少任何一件，取证面就缺角。
 */
export interface PersonaCoreChange {
  value: string
  by: 'owner' | 'model'
  atMs: number
}

/** `persona_events` 的一行。`seq` 参与哈希，校验时必须原样回填。 */
export interface PersonaEventRow {
  seq: number
  preset: string
  revision: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
  prev_hash: string
  hash: string
}
