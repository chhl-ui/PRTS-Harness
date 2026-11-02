/**
 * 记忆模块：巩固管线（Wave 2，规则部分）。
 *
 * 定位：把 turn 流变成可供扩散激活使用的关联图骨架——实体、共现边、主题计数，
 * 用一个水位线记录处理到哪。**不调用任何模型**，Wave 3 才接提炼。
 *
 * 三条硬不变量（对应计划 Wave 2 的验证条目，测试逐条钉住）：
 *   1. **幂等**：游标只前进；同一批 turn 不会被处理两次，因此重复跑结果一致。
 *   2. **水位线不越界**：写入的游标取自实际取到的最后一行的 rowid，永远 <= max(rowid)。
 *   3. **取消不写半成品**：一批 = 一个事务，实体/边/主题与游标推进同生共死。
 *      取消检查只在事务**外**，所以不存在「数据写了但游标没推进」或反过来的中间态。
 *
 * 为什么不走事件链：巩固依赖 turn 正文，而正文外置在 mem_bodies（链外，设计稿 §6.2
 * 路线 D）。把正文烤进事件会破坏链上只留 body_ref + sha256 的形状。因此本模块的
 * 产物与 mem_profiles 同类——链外派生项，不参与 rebuildProjections。
 */
import type { DatabaseSync } from 'node:sqlite'
import { extractEntities, type ExtractedEntity } from './extract.ts'
import { extractJsonArray, type TextGenerator } from './generate.ts'
import { writeProfile } from './write.ts'

const DEFAULT_SCOPE = 'prts'
const DEFAULT_BATCH_TURNS = 100
const DEFAULT_MAX_TURNS = 1000
/**
 * 每 turn 参与建边的实体上限。
 *
 * 边是两两组合：N 个实体产生 N(N-1)/2 条。一句长对话轻松抽到 20+ 个实体，
 * 那就是 190 条边，而其中绝大多数是「同一个句子里出现过」这种弱关联。
 * 截到 8 个 → 最多 28 条边，噪声与体积都可控。
 * 排序取 mention 权重更高的（本层只有单次出现，按抽取顺序：quoted > acronym > quantity > proper）。
 */
const DEFAULT_MAX_ENTITIES_PER_TURN = 8

export interface ConsolidateOptions {
  scope?: string
  /** 每批处理多少 turn，也就是一个事务的粒度。默认 100。 */
  batchTurns?: number
  /** 本次调用最多处理多少 turn；达到即停（留待下次）。默认 1000。 */
  maxTurns?: number
  /** 每 turn 参与建边的实体上限。默认 8。 */
  maxEntitiesPerTurn?: number
  /** 取消信号。只在批与批之间检查——批内中断会留下半成品。 */
  signal?: AbortSignal
}

export interface ConsolidateResult {
  turns: number
  /**
   * 本批处理的**实体提及次数**（同一实体在多个 turn 出现会累加）。
   * 去重后的实体总数看 `consolidationStats().entities`——两者不是一个口径，
   * 真机实测 2000 turn 下前者 6688、后者 4005，混用会把体积估算错一倍。
   */
  entityMentions: number
  /** 本批写入/更新的**边次数**；不同边数看 `consolidationStats().links`。 */
  linkUpdates: number
  /** 本批写入/更新的**主题提及次数**；不同主题数看 `consolidationStats().topics`。 */
  topicMentions: number
  /** 处理完后的游标（= 最后一条已处理 turn 的 rowid）。 */
  cursor: number
  /** `budget` 表示还有未处理的 turn，下次接着跑即可。 */
  stopped: 'done' | 'budget' | 'cancelled'
}

/** 读当前水位线。库里没有该 scope 的行时返回 0（等价于从头开始）。 */
export function readConsolidationCursor(db: DatabaseSync, scope = DEFAULT_SCOPE): number {
  const row = db.prepare('SELECT cursor_turn_rowid AS c FROM mem_consolidation WHERE scope = ?')
    .get(scope) as { c: number } | undefined
  return row?.c ?? 0
}

/** 巩固产出的规模统计——排查「扩散激活没效果」时第一个要看的东西。 */
export function consolidationStats(db: DatabaseSync, scope = DEFAULT_SCOPE): {
  cursor: number
  maxRowid: number
  entities: number
  links: number
  topics: number
  mentions: number
  budgetSpent: number
} {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c
  const cursorRow = db.prepare('SELECT cursor_turn_rowid AS c, budget_spent AS b FROM mem_consolidation WHERE scope = ?')
    .get(scope) as { c: number; b: number } | undefined
  return {
    cursor: cursorRow?.c ?? 0,
    maxRowid: one('SELECT COALESCE(MAX(rowid),0) AS c FROM mem_turns WHERE scope = ' + "'" + scope.replace(/'/g, "''") + "'"),
    entities: one('SELECT COUNT(*) AS c FROM mem_entities'),
    links: one('SELECT COUNT(*) AS c FROM mem_links'),
    topics: one('SELECT COUNT(*) AS c FROM mem_topics'),
    mentions: one('SELECT COUNT(*) AS c FROM mem_mentions'),
    budgetSpent: cursorRow?.b ?? 0,
  }
}

interface PendingTurn {
  rid: number
  turnId: string
  /** 事件发生时间。`occurred_raw` 解析失败时为 0（见 selectUnconsolidated 的注释）。 */
  atMs: number
  body: string
}

/**
 * 取游标之后的一批 turn。删除过的行跳过——它们的正文已被清空，抽不出东西。
 *
 * 时间只用 `occurred_at_ms`：`mem_turns` 没有 `recorded_at_ms` 列（那是 `memory_events`
 * 的字段，投影层没冗下来。实测教训：按 memory_events 的形状想当然写 join 会报
 * `no such column`）。解析失败时兜底 0 而非 `Date.now()`——用当前时间会让同一批
 * turn 两次巩固得到不同的 `first_seen_ms`，「重复跑结果一致」这条不变量就破了。
 */
function selectUnconsolidated(
  db: DatabaseSync, scope: string, cursor: number, limit: number,
): PendingTurn[] {
  return db.prepare(
    `SELECT t.rowid AS rid, t.turn_id AS turnId, COALESCE(t.occurred_at_ms, 0) AS atMs, b.body AS body
       FROM mem_turns t
       JOIN mem_bodies b ON b.body_ref = t.body_ref
      WHERE t.scope = ? AND t.rowid > ? AND t.deleted_at_ms IS NULL
        AND b.body IS NOT NULL AND b.body != ''
      ORDER BY t.rowid
      LIMIT ?`,
  ).all(scope, cursor, limit) as unknown as PendingTurn[]
}

/** 无向边规范化：只存 from < to 一份。存双向会让权重在两个方向上各算一次。 */
function undirected(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

/** 只有专名与引号短语算「主题」；数量与缩写是噪声（"50mm" 不是一个话题）。 */
function isTopicKind(kind: ExtractedEntity['kind']): boolean {
  return kind === 'proper' || kind === 'quoted'
}

/**
 * 跑一批巩固。同步执行：本层是纯规则计算，没有 IO 可等。
 *
 * 达到 `maxTurns` 而仍有剩余时返回 `stopped: 'budget'`——调用方负责循环，
 * 不要在这里自作主张跑完全库（24.6 万 turn 会让一次调用长时间占住事件循环）。
 */
export function runConsolidation(db: DatabaseSync, opts: ConsolidateOptions = {}): ConsolidateResult {
  const scope = opts.scope ?? DEFAULT_SCOPE
  const batchTurns = Math.max(1, opts.batchTurns ?? DEFAULT_BATCH_TURNS)
  const maxTurns = Math.max(0, opts.maxTurns ?? DEFAULT_MAX_TURNS)
  const maxEntities = Math.max(2, opts.maxEntitiesPerTurn ?? DEFAULT_MAX_ENTITIES_PER_TURN)

  let cursor = readConsolidationCursor(db, scope)
  let turns = 0
  let entityMentions = 0
  let linkUpdates = 0
  let topicMentions = 0
  let stopped: ConsolidateResult['stopped'] = 'done'

  const upsertEntity = db.prepare(
    `INSERT INTO mem_entities (entity_key, scope, name, kind, mention_count, first_seen_ms, last_seen_ms)
     VALUES (?,?,?,?,1,?,?)
     ON CONFLICT(entity_key) DO UPDATE SET
       mention_count = mention_count + 1,
       last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`,
  )
  const upsertLink = db.prepare(
    `INSERT INTO mem_links (from_key, to_key, kind, weight, last_seen_ms)
     VALUES (?,?,?,1,?)
     ON CONFLICT(from_key, to_key, kind) DO UPDATE SET
       weight = weight + 1,
       last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`,
  )
  const upsertTopic = db.prepare(
    `INSERT INTO mem_topics (topic, scope, entry_count, last_seen_ms, source_kind)
     VALUES (?,?,1,?,'entity')
     ON CONFLICT(topic) DO UPDATE SET
       entry_count = entry_count + 1,
       last_seen_ms = MAX(last_seen_ms, excluded.last_seen_ms)`,
  )
  // 实体 → 出现位置。扩散激活靠它把「邻居实体」翻译成「候选 turn」；
  // 没有这一步，关联图只能导航到实体名，召回不了任何内容。
  const insertMention = db.prepare(
    'INSERT INTO mem_mentions (entity_key, turn_id) VALUES (?,?) ON CONFLICT(entity_key, turn_id) DO NOTHING',
  )
  const upsertCursor = db.prepare(
    `INSERT INTO mem_consolidation (scope, cursor_turn_rowid, cursor_event_seq, updated_at_ms, budget_spent)
     VALUES (?,?,0,?,?)
     ON CONFLICT(scope) DO UPDATE SET
       cursor_turn_rowid = MAX(mem_consolidation.cursor_turn_rowid, excluded.cursor_turn_rowid),
       updated_at_ms = excluded.updated_at_ms,
       budget_spent = mem_consolidation.budget_spent + excluded.budget_spent`,
  )

  for (;;) {
    // 取消只在批边界检查——这是「不写半成品」的实现方式
    if (opts.signal?.aborted === true) {
      stopped = 'cancelled'
      break
    }
    if (turns >= maxTurns) {
      stopped = 'budget'
      break
    }

    const limit = Math.min(batchTurns, maxTurns - turns)
    const batch = selectUnconsolidated(db, scope, cursor, limit)
    if (batch.length === 0) {
      stopped = 'done'
      break
    }

    // 抽取在事务外完成：纯计算不占写锁，事务窗口只有 SQL 写入
    const prepared = batch.map((t) => ({
      turn: t,
      ents: extractEntities(t.body).slice(0, maxEntities),
    }))

    db.exec('BEGIN IMMEDIATE')
    try {
      let batchLinks = 0
      for (const { turn, ents } of prepared) {
        const at = turn.atMs
        for (const e of ents) {
          upsertEntity.run(e.key, scope, e.name, e.kind, at, at)
          insertMention.run(e.key, turn.turnId)
          if (isTopicKind(e.kind)) {
            upsertTopic.run(e.key, scope, at)
            topicMentions++
          }
        }
        for (let i = 0; i < ents.length; i++) {
          for (let j = i + 1; j < ents.length; j++) {
            const [a, b] = undirected(ents[i].key, ents[j].key)
            if (a === b) continue // "Sony" 与 "sony" 归一后同键，不自连
            upsertLink.run(a, b, 'cooccur', at)
            batchLinks++
          }
        }
        entityMentions += ents.length
      }
      linkUpdates += batchLinks

      const newCursor = batch[batch.length - 1].rid
      upsertCursor.run(scope, newCursor, Date.now(), batch.length)
      db.exec('COMMIT')
      cursor = newCursor
      turns += batch.length

      // 这一批没取满，说明没有更多了；再循环一次只会白查
      if (batch.length < limit) {
        stopped = 'done'
        break
      }
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  return { turns, entityMentions, linkUpdates, topicMentions, cursor, stopped }
}

// ---------------------------------------------------------------------------
// 模型巩固（Wave C）
// ---------------------------------------------------------------------------

const PROFILE_PROMPT = `You are consolidating a user's conversation history into durable preference profiles.

Read the turns below and extract ONLY durable preferences, tastes, constraints, or recurring habits of the user that would help a future assistant personalize its recommendations.

Rules:
- Write each profile as 1-2 ENGLISH sentences, starting with the concrete entity or topic, then the preference and any stated constraint.
- Include stated constraints (times, places, product requirements) inside the sentence.
- State what the user PREFERS, not what they asked about.
- Do NOT invent. Only what these turns support.
- If a turn contains no durable preference, skip it.

Example:

Turns:
[0] I've been using Adobe Premiere Pro for years but still struggle with the Lumetri panel. Any advanced tutorials?
[1] I usually shoot with a Sony A7R IV and a Godox V1 flash.

Output:
[{"subject":"user","aspect":"video_editing_tool","profile":"The user edits video in Adobe Premiere Pro and wants advanced, tool-specific material rather than beginner overviews."},
 {"subject":"user","aspect":"camera_gear","profile":"The user shoots with a Sony A7R IV body and a Godox V1 flash, so recommendations should be Sony-compatible."}]

Return only the JSON array. If nothing is extractable, return [].`

export interface ConsolidateModelOptions {
  generator: TextGenerator
  /** 水位线 scope。默认 'prts:profile'——与规则巩固的游标分开，否则会互相跳过。 */
  scope?: string
  batchTurns?: number
  maxTurns?: number
  origin?: 'live' | 'benchmark'
  signal?: AbortSignal
}

export interface ConsolidateModelResult {
  profiles: number
  turns: number
  failed: number
  cursor: number
  /** `failed` 表示模型调用出错，游标**未推进**，下次重跑同一批。 */
  stopped: 'done' | 'budget' | 'cancelled' | 'failed'
}

/**
 * 用模型把 turn 归纳成画像（Wave 3）。
 *
 * 三条不变量与规则巩固一致，但模型层多一条：**调用失败不推进游标**——
 * 否则一次网络抖动就会把整批 turn 永久跳过，且不会有任何报错。
 *
 * 游标 scope 默认 `'prts:profile'`：规则巩固已经把 `'prts'` 游标推到 24.6 万，
 * 共用会直接跳过全部 turn（静默零产出）。
 */
export async function consolidateProfiles(
  db: DatabaseSync,
  opts: ConsolidateModelOptions,
): Promise<ConsolidateModelResult> {
  const cursorScope = opts.scope ?? `${DEFAULT_SCOPE}:profile`
  const batchTurns = Math.max(1, opts.batchTurns ?? 60)
  const maxTurns = Math.max(0, opts.maxTurns ?? 600)
  const origin = opts.origin ?? 'live'

  let cursor = readConsolidationCursor(db, cursorScope)
  let profiles = 0
  let turns = 0
  let failed = 0
  let stopped: ConsolidateModelResult['stopped'] = 'done'

  const upsertCursor = db.prepare(
    `INSERT INTO mem_consolidation (scope, cursor_turn_rowid, cursor_event_seq, updated_at_ms, budget_spent)
     VALUES (?,?,0,?,?)
     ON CONFLICT(scope) DO UPDATE SET
       cursor_turn_rowid = MAX(mem_consolidation.cursor_turn_rowid, excluded.cursor_turn_rowid),
       updated_at_ms = excluded.updated_at_ms,
       budget_spent = mem_consolidation.budget_spent + excluded.budget_spent`,
  )

  for (;;) {
    if (opts.signal?.aborted === true) { stopped = 'cancelled'; break }
    if (turns >= maxTurns) { stopped = 'budget'; break }

    const limit = Math.min(batchTurns, maxTurns - turns)
    // turn 的 scope 恒为 'prts'，与游标 scope 无关——游标只是「处理到哪」的记账
    const batch = db.prepare(
      `SELECT t.rowid AS rid, t.turn_id AS turnId, t.session_id AS sessionId, b.body AS body
         FROM mem_turns t JOIN mem_bodies b ON b.body_ref = t.body_ref
        WHERE t.scope = ? AND t.rowid > ? AND t.deleted_at_ms IS NULL
          AND b.body IS NOT NULL AND b.body != ''
        ORDER BY t.rowid LIMIT ?`,
    ).all(DEFAULT_SCOPE, cursor, limit) as unknown as Array<{ rid: number; turnId: string; sessionId: string; body: string }>
    if (batch.length === 0) { stopped = 'done'; break }

    const text = batch.map((t, i) => `[${i}] (${t.sessionId}) ${t.body.slice(0, 300)}`).join('\n')
    let raw: string
    try {
      // 2026-11-02 修复：此前模板里的 ${PROFILE_PROMPT} 与 ${text} 在写入文件时
      // 被 shell 剥掉，模型实际收到的是一段几乎为空的 prompt——管线自提交起
      // 就没真正工作过（假 generator 不看 prompt，测试因此全程绿灯）。
      raw = await opts.generator.generate(`${PROFILE_PROMPT}\n\nTurns:\n${text}`)
    } catch {
      failed += batch.length
      stopped = 'failed'
      break // 不推进游标：下次重跑同一批
    }
    const arr = extractJsonArray(raw)

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const p of arr) {
        const o = p as { subject?: unknown; aspect?: unknown; profile?: unknown }
        if (typeof o.profile !== 'string' || o.profile.trim() === '') continue
        writeProfile(db, {
          subject: String(o.subject ?? 'user').slice(0, 60),
          aspect: String(o.aspect ?? 'preference').slice(0, 60),
          profileText: o.profile.slice(0, 600),
          origin,
        })
        profiles++
      }
      const newCursor = batch[batch.length - 1].rid
      upsertCursor.run(cursorScope, newCursor, Date.now(), batch.length)
      db.exec('COMMIT')
      cursor = newCursor
      turns += batch.length
      if (batch.length < limit) { stopped = 'done'; break }
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  return { profiles, turns, failed, cursor, stopped }
}
