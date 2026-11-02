/**
 * 记忆模块：更正标记（correction marker）的词表判定。
 *
 * 动机是 V1-06 的 F10：主人说「我最近改喝拿铁了，不再喝美式」，这句话里
 * 没有「咖啡」两个字，BM25/FTS 在「我喝咖啡有什么习惯」这类查询下根本召不回它。
 * 语义检索（Wave 2/3）是根治路径；在它落地之前，「最近说过要改」是最高优先级的
 * 记忆信号——这类 turn 该被钉进注入，该触发同槽事实的取代，而不是按字面分数排队。
 *
 * 两个消费方必须共用同一张表，否则「注入钉住的」和「抽取触发取代的」口径漂移：
 * - `store.recentCorrections()`：注入层的预留名额（memory-inject.ts）。
 * - `consolidateFacts` → `assertFact(supersedeSameSlot)`：模型层抽取时，
 *   带标记的来源 turn 才允许触发同槽旧事实退役（store.ts 注释）。
 *
 * 纪律：**宁可漏判，不可误判**。词表刻意收得很窄——把普通陈述误判成更正
 * 会挤占注入名额、误退役并存事实；漏判的代价只是退回原有检索路径。
 * 词表只增不减地演进：每加一个词都要给出它不会误伤日常用语的论证。
 */

/** 中文子串标记。全部是「放弃旧值/改用新值」的强信号，日常陈述几乎不会自然出现。 */
const ZH_MARKERS = [
  '不再',   // 不再喝美式 / 不再用 pandas
  '改喝',   // 改喝拿铁
  '改成',   // 改成 C 楼 203
  '改为',
  '换成',   // 换成索尼
  '换了',   // 换了实验室
  '搬到',   // 搬到 C 楼（地点更正的高频形态）
  '更名',   // 猫更名了
  '纠正',   // 纠正一下
  '更正',   // 更正一下
  '记错',   // 你记错了 / 我上次说错了的口语形态
]

/** 英文整词/短语标记（不区分大小写）。用正则边界避免 "knows" 误中 "no"。 */
const EN_MARKERS = [
  /no longer/i,            // I no longer drink americano
  /switched? to/i,         // switched to latte / I switch to
  /instead of/i,           // latte instead of americano
  /correct(?:ion|ed)?:/i,  // "correction:" 这种显式声明
  /i'?ve changed/i,        // I've changed labs
]

/** 判定一条用户 turn 是否携带更正标记。只用于 user turn——assistant 的转述不做依据。 */
export function looksLikeCorrection(text: string): boolean {
  for (const m of ZH_MARKERS) {
    if (text.includes(m)) return true
  }
  for (const re of EN_MARKERS) {
    if (re.test(text)) return true
  }
  return false
}

/**
 * 事实主题槽位 key 的规范化。
 *
 * 为什么不再用 `subject|predicate` 当槽位：真机抽取（2026-11-02，q38-gsq-iq3s）
 * 暴露了谓词匹配的双向失败——「偏好」这类泛谓词让拿铁把 polars 误退役
 * （不同主题同谓词），「拥有→住在」的措辞漂移又让实验室更正漏退役
 * （同主题不同谓词）。槽位改由抽取模型直接产出语义主题名（美式/拿铁→「咖啡」），
 * 匹配只在规范化后的 slot 上做，谓词退化为展示字段。
 *
 * 规范化很轻：trim + 折叠空白 + 小写。CJK 字符不受小写影响；`|` 剥掉防止
 * 与 identity_key 的分隔符歧义。空输入返回空串——调用方据此放弃取代
 * （宁漏勿滥：模型没给 slot 时绝不退回谓词匹配，否则 polars 事故重演）。
 */
export function normalizeSlotKey(slot: string): string {
  return slot.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\|/g, '')
}
