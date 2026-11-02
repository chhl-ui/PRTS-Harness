/**
 * 记忆模块：模型层事实抽取（巩固管线 Wave 3 的 fact 部分）。
 *
 * 与 `extract.ts` 的分工：那个是**规则型实体抽取**（给关联图打底，零模型）；
 * 这里是**模型型事实抽取**，产出 `mem_facts` 里的 subject/predicate/object。
 *
 * ## 为什么它必须存在
 *
 * `assertFact` 在本轮之前没有任何生产调用方，`mem_facts` 长期为 0。带来两个连锁后果：
 * 生命周期（退役/衰减）没有对象可动、用进废退（强化）没有落点、`prts_memory_recall`
 * 的 fact 通道永远空。所以这一步不是「再添一个功能」，是让已有机制从空转变成可运转。
 *
 * ## 本体边界（刻意很小）
 *
 * 只抽「对话明确支持的长期事实与偏好」，不抽情绪、不抽推测。`provenance` 固定
 * `inferred` + `confirmation_basis` 固定 `model-inferred`——模型抽出来的东西不是
 * 主人明说的，库里的 CHECK 白名单也禁止 `stated` 与 `model-inferred` 同时出现。
 *
 * ## 幂等
 *
 * 不靠水位线保证，靠 `assertFact` 的 identity_key 去重（subject|predicate|bodySha）：
 * 同一句对话重复抽取不会写出第二条。所以中途失败后重跑是安全的，水位线只用来省成本。
 */
import type { TextGenerator } from './generate.ts'
import { normalizeSlotKey } from './correction.ts'

/** 一条抽取结果。`sourceIndex` 只是回溯线索，不参与事实语义。 */
export interface ExtractedFact {
  subject: string
  predicate: string
  object: string
  /**
   * 事实主题的稳定规范名（模型产出，如「咖啡」「实验室」）。
   * 同槽取代的匹配键——真机验证结论：subject|predicate 当槽位会双向失败
   * （泛谓词误杀并存事实、措辞漂移漏杀同主题旧值），必须用语义主题名。
   */
  slot: string
  sourceIndex: number | null
}

export interface FactPromptTurn {
  /** 批次内序号，模型要在 source_index 里引用它。 */
  index: number
  speaker: string
  text: string
}

/** 单条 turn 进 prompt 的字符上限。长 turn 常含关键约束，但不能无限吃上下文。 */
const TURN_CHAR_CAP = 800
const SUBJECT_CAP = 60
const PREDICATE_CAP = 40
const OBJECT_CAP = 600
const SLOT_CAP = 40

export function buildFactPrompt(turns: FactPromptTurn[], existingSlots: string[] = []): string {
  const lines = turns.map((t) => `[${t.index}] (${t.speaker}) ${t.text.slice(0, TURN_CHAR_CAP)}`)
  // 跨批次一致性锚点：更正 turn 在新批次里看不到当初登记的 slot，会自己造
  // 近义词（真机实测：相机→主力相机，旧值漏退役）。把已登记 slot 喂给它，
  // 同主题强制复用——这是 slot 随时间收敛而不是发散的机制。
  const slotVocab = existingSlots.length === 0
    ? ''
    : `\n已登记的 slot：${existingSlots.join('、')}。\n若事实主题与其中某条相同，必须逐字复用该 slot，不要新造近义词。\n`
  return `从下面的对话片段中抽取关于用户的长期有效事实与偏好。

只返回 JSON 数组，不要任何解释文字。每项的结构：
{"subject": "...", "predicate": "...", "object": "...", "slot": "...", "source_index": 0}

规则：
- subject：这条事实关于谁，通常是「博士」或「user」。
- predicate：简短的关系词，如 偏好 / 拥有 / 住在 / 使用 / 正在做。
- object：具体取值，保留产品名、地点、数字等原文，不要改写成抽象概括。
- slot：这条事实主题的**稳定规范名**（2~15 个字符的具体名词）。
  同一主题的不同取值、不同措辞，必须给出**逐字相同**的 slot——
  「喝咖啡只喝美式」和「改喝拿铁」都给「咖啡」；
  「实验室在 B 楼 417」和「搬到 C 楼 203」都给「实验室」；
  「偏好用 polars」给「数据处理库」；「猫叫墨团」给「宠物名」。
  禁止用 偏好 / 拥有 / 使用 / 情况 / 其他 这类泛词当 slot。${slotVocab}
- source_index：这条事实来自哪个带方括号序号的片段。
- 只抽对话**明确支持**的内容，不要推断情绪或没有说过的偏好。
- 没有可抽取的内容时返回 []。

对话：
${lines.join('\n')}`
}

/**
 * 解析模型输出。非法条目计数后丢弃，不整体失败——
 * 一次抽 20 条里有 1 条格式不对，不该让另外 19 条白跑。
 */
export function parseFacts(raw: string): { facts: ExtractedFact[]; skipped: number } {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return { facts: [], skipped: 1 }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return { facts: [], skipped: 1 }
  }
  if (!Array.isArray(parsed)) return { facts: [], skipped: 1 }

  const facts: ExtractedFact[] = []
  let skipped = 0
  for (const item of parsed) {
    const o = item as { subject?: unknown; predicate?: unknown; object?: unknown; slot?: unknown; source_index?: unknown }
    const subject = typeof o.subject === 'string' ? o.subject.trim() : ''
    const predicate = typeof o.predicate === 'string' ? o.predicate.trim() : ''
    const object = typeof o.object === 'string' ? o.object.trim() : ''
    if (subject === '' || predicate === '' || object === '') {
      skipped++
      continue
    }
    // slot 缺失不丢弃整条：事实仍可用，只是失去触发同槽取代的资格——宁漏勿滥。
    const slot = typeof o.slot === 'string' ? normalizeSlotKey(o.slot).slice(0, SLOT_CAP) : ''
    facts.push({
      subject: subject.slice(0, SUBJECT_CAP),
      predicate: predicate.slice(0, PREDICATE_CAP),
      object: object.slice(0, OBJECT_CAP),
      slot,
      sourceIndex: typeof o.source_index === 'number' && Number.isFinite(o.source_index)
        ? Math.trunc(o.source_index)
        : null,
    })
  }
  return { facts, skipped }
}

/** 便捷封装：一批 turn → 模型 → 事实。调用方负责水位线与写入。 */
export async function extractFacts(
  generator: TextGenerator,
  turns: FactPromptTurn[],
  existingSlots: string[] = [],
): Promise<{ facts: ExtractedFact[]; skipped: number }> {
  const raw = await generator.generate(buildFactPrompt(turns, existingSlots))
  return parseFacts(raw)
}
