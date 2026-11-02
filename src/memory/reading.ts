/**
 * 记忆模块：「阅读」阶段的上下文组织（`memory-roadmap` P1）。
 *
 * 检索阶段只回答「哪些证据相关」，阅读阶段回答「怎么摆给模型看」。
 * 平铺 top-k 有两个实测失败形态：
 * - 同一主题的新旧值散落在不同名次里，模型自己拼不出「美式 → 拿铁」的
 *   更新关系（V1-06 靠更正钉住 + 模型内省才答对，见 memory-inject.ts）；
 * - 答案分散在同一会话的多条 turn 里，top-5 只取到其中一条
 *   （roadmap `830ce83f` 的失败形态）。
 *
 * 本模块把命中按共享的聚合键连成「卡片」，组内按时间升序，最近一条标
 * 「最新」。聚合键从强到弱：
 *  1. fact 的 `slot`——模型抽取产出的主题名（`correction.ts`），「咖啡」
 *     把美式与拿铁放进同一张卡；
 *  2. turn 的实体提及（`mem_mentions` × `mem_entities`）——规则抽取以
 *     拉丁/数字实体为主，中文覆盖有限，所以还有第 3 条兜底；
 *  3. turn 正文包含某命中 fact 的 slot 名——「我喜欢美式咖啡」包含
 *     slot「咖啡」，中文实体不进 mentions 时仍能聚合；
 *  4. fact 的 `sourceTurnIds`——更正 turn 是由它抽出的新事实的来源，
 *     必然同卡；
 *  5. 同 `sessionId` 的 turn/summary 兜底成「会话卡」。
 * 分不出组的命中保持平铺，与旧格式逐字一致（评测口径不变）。
 *
 * 纪律：
 * - 纯本地拼接，无模型调用（roadmap：「成本：纯本地拼接」）；
 * - 「最新 / 较早」只陈述记录时间先后，不主张真值——同槽并存事实
 *   （两台相机）是合法状态，措辞用「记录」而非「正确值」；
 * - 聚合失败的命中一律退回平铺，宁可少组不可错组。
 */
import { normalizeSlotKey } from './correction.ts'
import type { FactMeta, MemoryHit, TurnEntityMention } from './types.ts'

export interface ReadingDeps {
  /** `fact_id` → 元数据（`store.factMeta`）。缺省时 fact 命中只剩平铺。 */
  factMeta?: ReadonlyMap<string, FactMeta>
  /** `turn_id` → 实体提及（`store.turnEntities`）。 */
  turnEntities?: ReadonlyMap<string, readonly TurnEntityMention[]>
  /**
   * 实体提及数超过此值视为枢纽、不做聚合键（默认 64）。
   * "Python" 这类全库高频实体会把无关命中连成大卡——它提供的是
   * 「这两个命中都提过 Python」，不是「它们讲同一件事」。
   */
  hubMentionLimit?: number
}

export interface ReadingCard {
  kind: 'topic' | 'session' | 'single'
  /** topic 为主题名（fact slot 优先），session 为描述语，single 为空。 */
  title: string
  /** 组内按时间升序；未知时间排最前——不许它冒称「最新」。 */
  hits: MemoryHit[]
}

export interface ReadingRender {
  /** 是否出现了多命中卡片——调用方据此换头部措辞。 */
  grouped: boolean
  /** 卡片小节 + 平铺尾巴；无分组时是与旧格式逐字一致的编号列表。 */
  body: string
}

const DEFAULT_HUB_LIMIT = 64

function timeOf(hit: MemoryHit, meta: FactMeta | undefined): number | null {
  if (hit.kind === 'fact') return meta?.validFromMs ?? meta?.recordedAtMs ?? null
  return hit.occurredAtMs ?? null
}

function fmtTime(hit: MemoryHit, t: number | null): string {
  if (t !== null) return new Date(t).toISOString()
  return hit.occurredRaw ?? '时间未知'
}

/** 把命中归组成卡片。卡片顺序 = 组内最好名次命中在原列表里的位置。 */
export function organizeReading(hits: readonly MemoryHit[], deps: ReadingDeps = {}): ReadingCard[] {
  const hubLimit = deps.hubMentionLimit ?? DEFAULT_HUB_LIMIT
  if (hits.length <= 1) {
    return hits.map((h) => ({ kind: 'single' as const, title: '', hits: [h] }))
  }

  // 并查集：共享聚合键的命中进同一组。
  const parent = hits.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] }
    return i
  }
  const union = (a: number, b: number): void => {
    const ra = find(a); const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const indexById = new Map(hits.map((h, i) => [h.id, i]))

  // ---- 主题键收集 ----
  const topicHits = new Map<string, number[]>()     // 规范化主题键 → 命中下标
  const topicName = new Map<string, string>()       // 规范化键 → 展示名
  const factSlotKeys = new Set<string>()            // 来自 fact slot 的键（标题优先 + 正文兜底）
  const hitKeys = new Map<number, string[]>()       // 命中下标 → 它贡献过的主题键
  const addTopic = (key: string, name: string, i: number, fromFact: boolean): void => {
    if (key === '') return
    const list = topicHits.get(key) ?? []
    list.push(i)
    topicHits.set(key, list)
    if (!topicName.has(key)) topicName.set(key, name)
    if (fromFact) factSlotKeys.add(key)
    const mine = hitKeys.get(i) ?? []
    mine.push(key)
    hitKeys.set(i, mine)
  }

  for (const [i, h] of hits.entries()) {
    if (h.kind !== 'fact') continue
    const slot = deps.factMeta?.get(h.id)?.slot
    if (slot !== null && slot !== undefined && slot !== '') {
      addTopic(normalizeSlotKey(slot), slot, i, true)
    }
  }
  for (const [i, h] of hits.entries()) {
    if (h.kind !== 'turn') continue
    for (const e of deps.turnEntities?.get(h.id) ?? []) {
      if (e.mentionCount > hubLimit) continue
      addTopic(normalizeSlotKey(e.key), e.name, i, false)
    }
  }
  // 兜底：turn 正文含某命中 fact 的 slot 名（中文实体不进 mentions 的现实路径）。
  if (factSlotKeys.size > 0) {
    for (const [i, h] of hits.entries()) {
      if (h.kind !== 'turn') continue
      const lower = h.text.toLowerCase()
      for (const key of factSlotKeys) {
        if (key.length >= 2 && lower.includes(key)) addTopic(key, topicName.get(key) ?? key, i, false)
      }
    }
  }
  for (const idxs of topicHits.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])
  }

  // ---- fact 的来源 turn 与 fact 同卡 ----
  for (const [i, h] of hits.entries()) {
    if (h.kind !== 'fact') continue
    for (const tid of deps.factMeta?.get(h.id)?.sourceTurnIds ?? []) {
      const j = indexById.get(tid)
      if (j !== undefined) union(i, j)
    }
  }

  // ---- 会话兜底：只收容没进主题卡的 turn/summary ----
  const groupSize = new Map<number, number>()
  for (let i = 0; i < hits.length; i++) {
    const r = find(i)
    groupSize.set(r, (groupSize.get(r) ?? 0) + 1)
  }
  const sessionHits = new Map<string, number[]>()
  for (const [i, h] of hits.entries()) {
    if (h.kind !== 'turn' && h.kind !== 'summary') continue
    if (h.sessionId === undefined) continue
    if ((groupSize.get(find(i)) ?? 0) > 1) continue
    const list = sessionHits.get(h.sessionId) ?? []
    list.push(i)
    sessionHits.set(h.sessionId, list)
  }
  for (const idxs of sessionHits.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])
  }

  // ---- 组装卡片 ----
  const groups = new Map<number, number[]>()
  for (let i = 0; i < hits.length; i++) {
    const r = find(i)
    const list = groups.get(r) ?? []
    list.push(i)
    groups.set(r, list)
  }
  const cards: ReadingCard[] = []
  for (const idxs of groups.values()) {
    const members = idxs.map((i) => hits[i])
    if (members.length === 1) {
      cards.push({ kind: 'single', title: '', hits: members })
      continue
    }
    // 卡片类别：任一成员有主题键 → topic；否则是同会话兜底 → session。
    // 标题只用「本组成员实际贡献的键」——turn 可带多个实体，不能把别的
    // 卡的主题名借过来。fact slot 名优先（模型产出的主题名比实体名稳定）。
    const keyScore = new Map<string, number>()
    for (const i of idxs) {
      for (const k of hitKeys.get(i) ?? []) {
        keyScore.set(k, (keyScore.get(k) ?? 0) + (factSlotKeys.has(k) ? 2 : 1))
      }
    }
    // 连接键（≥2 个成员贡献）是卡片的真实主题，优先；其次 fact slot；
    // 最后是单成员孤键（它没连上任何东西，但当标题仍比「会话」准确）。
    let topicTitle = ''
    let best = -1
    for (const [k, score] of keyScore) {
      if (score > best) { best = score; topicTitle = topicName.get(k) ?? k }
    }
    const sorted = [...members].sort((a, b) => {
      const ta = timeOf(a, a.kind === 'fact' ? deps.factMeta?.get(a.id) : undefined)
      const tb = timeOf(b, b.kind === 'fact' ? deps.factMeta?.get(b.id) : undefined)
      if (ta === null && tb === null) return 0
      if (ta === null) return -1
      if (tb === null) return 1
      return ta - tb
    })
    cards.push({
      kind: topicTitle === '' ? 'session' : 'topic',
      title: topicTitle === '' ? `同一会话的 ${members.length} 条记录` : topicTitle,
      hits: sorted,
    })
  }
  // 卡片位置 = 组内成员在原名次里的最前下标（钉住的更正仍在最前）。
  cards.sort((a, b) => {
    // 每个卡片的代表下标：组内任一成员的最小原下标。
    const pa = Math.min(...a.hits.map((h) => indexById.get(h.id) ?? Number.MAX_SAFE_INTEGER))
    const pb = Math.min(...b.hits.map((h) => indexById.get(h.id) ?? Number.MAX_SAFE_INTEGER))
    return pa - pb
  })
  return cards
}

/** 组内一行：`  - [kind] 时间 · 标记 — 文本`。fact 有 meta 时补主谓展示。 */
function cardLine(hit: MemoryHit, meta: FactMeta | undefined, tag: string): string {
  const t = timeOf(hit, meta)
  const text = hit.kind === 'fact' && meta !== undefined
    ? `${meta.subject}·${meta.predicate}：${hit.text}`
    : hit.text
  return `  - [${hit.kind}] ${fmtTime(hit, t)}${tag} — ${text}`
}

/**
 * 渲染命中。无分组时返回与旧平铺逐字一致的 `N. [kind] 时间 — 文本` 编号列表；
 * 有分组时输出 `【主题】` 小节（组内时间升序、最近一条标「最新」）+
 * `其他命中：` 编号尾巴。
 */
export function renderReading(hits: readonly MemoryHit[], deps: ReadingDeps = {}): ReadingRender {
  const cards = organizeReading(hits, deps)
  const hasGroup = cards.some((c) => c.hits.length > 1)
  const flatLine = (h: MemoryHit, i: number): string => {
    const meta = h.kind === 'fact' ? deps.factMeta?.get(h.id) : undefined
    return `${i + 1}. [${h.kind}] ${fmtTime(h, timeOf(h, meta))} — ${h.text}`
  }
  if (!hasGroup) {
    return { grouped: false, body: hits.map(flatLine).join('\n') }
  }

  const lines: string[] = []
  const singles: MemoryHit[] = []
  for (const card of cards) {
    if (card.hits.length === 1) { singles.push(card.hits[0]); continue }
    const times = card.hits.map((h) => timeOf(h, h.kind === 'fact' ? deps.factMeta?.get(h.id) : undefined))
    const known = times.filter((t): t is number => t !== null)
    // 只有主题卡标新旧：会话卡是同一场对话的碎片不是「取值」，
    // 标了反而暗示冲突。且要至少两个不同时间点才谈得上新旧。
    const mark = card.kind === 'topic' && new Set(known).size >= 2
    const newest = mark ? Math.max(...known) : null
    lines.push(`【${card.title}】`)
    card.hits.forEach((h, i) => {
      const t = times[i]
      const tag = !mark || t === null ? '' : (t === newest ? ' · 最新' : ' · 较早')
      lines.push(cardLine(h, h.kind === 'fact' ? deps.factMeta?.get(h.id) : undefined, tag))
    })
  }
  if (singles.length > 0) {
    lines.push('其他命中：')
    singles.forEach((h, i) => lines.push(flatLine(h, i)))
  }
  return { grouped: true, body: lines.join('\n') }
}
