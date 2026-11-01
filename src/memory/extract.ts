/**
 * 记忆模块：规则型实体抽取（巩固管线 Wave 2）。
 *
 * 为什么是规则而不是模型：Wave 2 与 Wave 3 分开，是为了让「关联图的骨架」先在
 * 零 API 成本下立起来。规则抽取的召回率不如模型，但它确定性、可测、可重跑，
 * 适合打底——模型层（Wave 3）之后再按证据决定要不要替换。
 *
 * 已知取舍（不假装是完美方案）：
 * - 句首大写词默认跳过。英文里句首大写和专名大写长得一样，没有全局词频信息时
 *   只能二选一；错拒专名比把每句话首词当实体（the / if / when 全进图）代价小。
 * - 单字母与常见虚词进停用表。宁可漏收 "I" 这种，也不要让关联图被噪声塞满。
 * - 每 turn 实体数上限由调用方控制（见 consolidate.ts），本文件只负责抽全。
 */

/** 实体类别。`key` 是检索与建边用的规范化键，`name` 保留原始写法。 */
export type EntityKind = 'proper' | 'quoted' | 'quantity' | 'acronym'

export interface ExtractedEntity {
  /** 规范化键：小写 + 空白折叠。同一实体的不同大小写写法归并到同一个 key。 */
  key: string
  /** 原始写法，保留大小写与符号——给人看的那一份。 */
  name: string
  kind: EntityKind
}

/** 句首常见词与虚词。进了这张表的不当专名。 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'i', 'and', 'but', 'or', 'if', 'when', 'while', 'after', 'before',
  'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they', 'we', 'you',
  'my', 'his', 'her', 'their', 'our', 'your', 'its',
  'what', 'which', 'who', 'whom', 'how', 'why', 'where', 'whose',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'do', 'does', 'did', 'done', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'not', 'no', 'yes', 'also', 'however', 'because',
  'since', 'although', 'though', 'in', 'on', 'at', 'for', 'to', 'from',
  'with', 'by', 'of', 'as', 'so', 'then', 'there', 'here', 'about', 'into',
  'over', 'under', 'than', 'too', 'very', 'just', 'only', 'some', 'any', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'such', 'same',
  'user', 'they', 'them', 'their', 'one', 'two', 'first', 'last', 'next',
])

/**
 * 全大写但显然是普通词的缩写，不进图。
 *
 * 罗马数字是实测加进来的：`Sony A7R IV` 里的 `IV` 会被缩写规则单独收一条，
 * 于是每台带代数的产品都多一个无意义实体，还会跟别的产品名建边。
 * `Sony A7R IV` 整体仍由专名规则收下，不受影响。
 */
/**
 * 高频祈使动词。用于把句首的「动词 + 专名」序列拆开。
 *
 * 为什么需要：多词大写序列是判别专名的主要证据，但 `Choose Adobe Premiere Pro`
 * 这种句首祈使句会整体匹配成功，把动词也收进图——真机实测 `choose` 与 `use`
 * 之间建出了全库权重最高的边。剥掉首词即可，专名部分保留。
 */
const IMPERATIVE = new Set([
  'use', 'choose', 'create', 'look', 'make', 'consider', 'add', 'set', 'try', 'check',
  'keep', 'get', 'take', 'find', 'learn', 'read', 'watch', 'visit', 'install', 'enable',
  'disable', 'select', 'pick', 'avoid', 'start', 'stop', 'open', 'close', 'save', 'delete',
  'run', 'call', 'ask', 'tell', 'give', 'show', 'put', 'go', 'come', 'see', 'know', 'think',
  'ensure', 'note', 'remember', 'have', 'apply', 'focus', 'review', 'practice', 'explore',
  'include', 'remove', 'update', 'verify', 'compare', 'combine', 'stick', 'invest', 'track',
])

const ACRONYM_STOP = new Set([  'I', 'A', 'AN', 'THE', 'AT', 'IN', 'ON', 'TO', 'OF', 'OR', 'BY', 'AS', 'IS', 'IT', 'BE', 'DO', 'IF', 'SO', 'NO', 'OK',
  'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX',
])

/** 数量单位。收录依据：本机 LongMemEval 语料里出现过的单位类型，不是通用全集。 */
const UNITS = 'mm|cm|km|m|kg|g|mg|gb|mb|tb|kb|ms|s|sec|min|mins|h|hr|hrs|%|px|fps|khz|mhz|ghz|hz|v|w|kw|mah|inch|inches|in|ft|feet|miles?|hours?|days?|weeks?|months?|years?'

/**
 * 单双引号分工：双引号与中文引号收，**单引号不收**。
 *
 * 英文单引号绝大多数是撇号（it's / don't / user's），把它当引号短语会抽出
 * `s great that you` 这种东西——真机实测它一度排进 120 万边的前几名。
 * 收益（少数真的用单引号引用）远小于噪声。
 */
const QUOTED = [/["“]([^"”\n]{2,60})["”]/g]
const ACRONYM = /\b[A-Z]{2,5}\b/g
const QUANTITY = new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s?(?:${UNITS})\\b`, 'gi')
/** 句中连续大写开头的词序列（1–4 个词），如 `Adobe Premiere Pro`、`Sony A7R IV`。 */
const PROPER = /\b[A-Z][A-Za-z0-9]*(?:[ -][A-Z][A-Za-z0-9]*){0,3}\b/g

/** key 规范化：小写 + 紧凑空白。同一个词的不同写法必须归一，否则共现边会分裂。 */
export function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 找出「句首词」的位置集合。这些位置上的**单词**大写序列不算专名
 * （见 extractEntities 里对多词序列的例外）。
 *
 * 边界不止 `.` `!` `?`：真机实测只认这三个会让 `- Use a tripod`、`1. Choose ...`
 * 这类列表项的行首动词全部漏进图——`Use` / `Choose` / `Create` / `Make` 一度占据
 * 实体提及榜前列，最高权重的边甚至是 `choose — use`。所以换行、冒号、分号，
 * 以及行首的列表标记（`-` `*` `•` `1.` `2)`）都算句子边界。
 */
function sentenceStarts(text: string): Set<number> {
  const starts = new Set<number>()
  const isBoundary = (ch: string): boolean => /[\n\r.!?:;]/.test(ch)
  let i = 0
  let atStart = true
  while (i < text.length) {
    if (atStart) {
      // 行首空白 + 列表标记一并跳过，落点即句首词
      const m = /^(?:\s|[-*•]|\d+[.)])*/.exec(text.slice(i))
      i += m === null ? 0 : m[0].length
      if (i < text.length) {
        starts.add(i)
        atStart = false
      }
      continue
    }
    if (isBoundary(text[i])) atStart = true
    i++
  }
  return starts
}

/**
 * 抽一条文本里的实体。
 *
 * 同一文本内同一个 key 只返回一次（kind 取首次命中的类别）——提及次数由调用方
 * 按 turn 累加，不在本层重复计，否则「一个 turn 里提了 5 次」会把权重抬成 5，
 * 与「5 个 turn 各提 1 次」混为一谈。
 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (text.trim() === '') return []
  const out = new Map<string, ExtractedEntity>()

  const add = (name: string, kind: EntityKind): void => {
    const key = normalizeKey(name)
    if (key === '' || key.length > 60) return
    if (!out.has(key)) out.set(key, { key, name: name.trim(), kind })
  }

  for (const re of QUOTED) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) add(m[1], 'quoted')
  }

  ACRONYM.lastIndex = 0
  for (const m of text.matchAll(ACRONYM)) {
    if (ACRONYM_STOP.has(m[0])) continue
    add(m[0], 'acronym')
  }

  QUANTITY.lastIndex = 0
  for (const m of text.matchAll(QUANTITY)) add(m[0], 'quantity')

  // 专名：句首只放行多词大写序列。
  // 单看一个句首大写词，英文里无法和 The / She / Can 区分，跳过；
  // 但 "Sony A7R IV" 这种连续 2+ 个大写词几乎必然是专名——一刀切跳过会把
  // 「以产品名开头的短 turn」抽成空集（实测：'Sony A7R IV body.' 零实体）。
  const starts = sentenceStarts(text)
  PROPER.lastIndex = 0
  for (const m of text.matchAll(PROPER)) {
    const at = m.index ?? 0
    const raw = m[0].trim()
    const words = raw.split(/[ -]/)
    let effective = words
    if (starts.has(at)) {
      // 句首单词序列一律跳过：The / She / Can 与专名在这里无法区分
      if (words.length < 2) continue
      // 句首多词序列要**剥前缀**而不是整条丢弃：
      // `The Godox V1` 会被正则整体匹配成一个序列，首词 The 命中停用词表后
      // 若直接丢掉，整句的专名就没了——实测这是最常见的漏抽形态。
      // 剥到第一个非停用词/非祈使动词为止；剥完若只剩一个停用词则仍跳过。
      while (
        effective.length > 1
        && (STOPWORDS.has(effective[0].toLowerCase()) || IMPERATIVE.has(effective[0].toLowerCase()))
      ) {
        effective = effective.slice(1)
      }
      if (effective.length === 1 && STOPWORDS.has(effective[0].toLowerCase())) continue
    }
    const first = effective[0].toLowerCase()
    if (STOPWORDS.has(first)) continue
    const name = effective.join(' ')
    if (name.length < 2) continue
    add(name, 'proper')
  }

  return [...out.values()]
}
