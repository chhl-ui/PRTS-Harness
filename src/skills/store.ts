/**
 * V1-09 进化：技能库。
 *
 * 一条经验的生命周期（架构需求 §7 V1-09 的「经验 → 候选 → 评估 → 采用」）：
 *
 *   propose（model 或 owner）
 *      → candidate
 *   evaluate（owner 或 model，必须给依据）
 *      → 仍是 candidate，只是多一条评估记录
 *   adopt（owner 或 model，要求最近一次评估是 adopt）
 *      → active
 *   reject（owner 或 model，理由必填）
 *      → rejected
 *   retire（owner 或 model，理由必填）
 *      → retired
 *   restore（owner 或 model，理由必填）
 *      → active
 *
 * ## 为什么 `evaluate` 与 `adopt` 分开
 *
 * 「评估」是取证，「采用」是决策。合并成一个动作，事后就分不清「评估过了但没采用」
 * 与「根本没评估」——而这两种情况对「这条经验该不该改」的判断完全不同。
 *
 * ## 为什么模型可以评估与采用（2026-11-09 博士决定放开）
 *
 * 这一格原先写的是「模型只能 propose，采用是博士的决策」。放开的依据是事实：
 * 技能**不授予任何权限**——它不参与工具注册，不过 `Authority.guard`
 * （`src/runtime/start.ts` 里 skills 只做 open / 注册工具 / 注入三件事），
 * 注入的只是一段建议文本（`src/runtime/skill-inject.ts`），真正拦得住模型的是 K2a 守卫。
 * 而记忆事实本来就是自动写入、无人审批的；把工作方法卡在人工队列里，代价是
 * 博士要当每条经验的审批机器——实测就是唯一那条候选从提出起一直没人处理。
 *
 * **前提必须记住**：一旦技能能携带工具、数据源或授权路径，这条放开就不成立，
 * 必须先恢复 `requireOwner` 校验。到那时它才真的是「能力扩张」。
 *
 * 否决与回退（reject / retire / restore）同日第二次放开，也归模型：全生命周期
 * 在工具面与 `/skill` 命令面都可达，没有保留动作。**理由必填这条没有放松**——
 * 没有理由的回退，下次还会被重新提出，留痕是这里唯一的约束。
 *
 * 人工闸门退到哪去了：博士仍持有 `/skill`（同一套动作，随时能撤任何一条）
 * 与哈希链（`skill_events` 逐条可 `verifyChain`）。放开的是「不用人批准」，
 * 不是「不用留痕、不能追责」。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { appendChained, canonicalJson, verifyChainRows, type ChainVerifyResult } from '../chain/index.ts'
import { raise } from '../ledger/errors.ts'
import { applySkillEvent } from './fold.ts'
import { openSkillDb } from './schema.ts'
import type {
  SkillActor, SkillEvaluation, SkillEventKind, SkillId, SkillPhase, SkillProposal,
  SkillRef, SkillSnapshot, SkillVerdict,
} from './types.ts'

const VERDICTS: ReadonlySet<string> = new Set(['adopt', 'reject', 'needs-work'])

interface SkillRow {
  skill_id: string
  revision: number
  phase: string
  title: string
  trigger_text: string
  steps_json: string
  pitfalls_json: string
  source_refs_json: string
  proposed_by_json: string
  evaluations_json: string
  retire_reason: string | null
  created_at: number
  updated_at: number
}

interface EventRow {
  seq: number
  skill_id: string
  revision: number
  kind: string
  actor_json: string
  payload_json: string
  ts: number
  prev_hash: string
  hash: string
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    raise('INVALID_INPUT', `${field} must be a non-empty string`)
  }
  return value.trim()
}

function nonEmptyArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    raise('INVALID_INPUT', `${field} must be a non-empty array`)
  }
  return value.map((v) => nonEmpty(v, field))
}

function optionalArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) raise('INVALID_INPUT', `${field} must be an array`)
  return value.map((v) => nonEmpty(v, field))
}

export class SkillStore {
  private readonly db: DatabaseSync

  private constructor(db: DatabaseSync) {
    this.db = db
  }

  static open(dbPath: string): SkillStore {
    return new SkillStore(openSkillDb(dbPath))
  }

  close(): void {
    try {
      this.db.close()
    } catch { /* 已关闭则忽略 */ }
  }

  // ---------- 写通道 ----------

  propose(actor: SkillActor, input: SkillProposal): SkillId {
    const title = nonEmpty(input?.title, 'title')
    const trigger = nonEmpty(input?.trigger, 'trigger')
    const steps = nonEmptyArray(input?.steps, 'steps')
    const pitfalls = optionalArray(input?.pitfalls, 'pitfalls')
    const sourceRefs = optionalArray(input?.sourceRefs, 'sourceRefs')
    const id = `sk-${randomUUID()}` as SkillId
    this.tx(() => {
      this.append(id, 1, 'skill.proposed', actor, { title, trigger, steps, pitfalls, sourceRefs })
    })
    return id
  }

  /** 记录一次评估。只写评估，不改相位——采用是下一个动作。 */
  evaluate(actor: SkillActor, ref: SkillRef, e: { verdict: SkillVerdict; basis: string }): SkillSnapshot {
    this.requireWriter(actor, 'evaluate')
    const verdict = nonEmpty(e?.verdict, 'verdict')
    if (!VERDICTS.has(verdict)) raise('INVALID_INPUT', `unknown verdict: ${verdict}`)
    const basis = nonEmpty(e?.basis, 'basis')
    return this.tx(() => {
      const s = this.mustSkill(ref)
      this.append(s.id, s.revision + 1, 'skill.evaluated', actor, {
        verdict, basis, by: actor, atMs: Date.now(),
      })
      return this.requireSnapshot(s.id)
    })
  }

  adopt(actor: SkillActor, ref: SkillRef): SkillSnapshot {
    this.requireWriter(actor, 'adopt')
    return this.tx(() => {
      const s = this.mustSkill(ref)
      if (s.phase !== 'candidate') raise('INVALID_TRANSITION', `skill ${s.id} is '${s.phase}', not candidate`)
      const last = s.evaluations[s.evaluations.length - 1]
      if (last === undefined) raise('INVALID_TRANSITION', `skill ${s.id} has no evaluation; evaluate it first`)
      if (last.verdict !== 'adopt') raise('INVALID_TRANSITION', `last verdict is '${last.verdict}', not adopt`)
      this.append(s.id, s.revision + 1, 'skill.adopted', actor, {})
      return this.requireSnapshot(s.id)
    })
  }

  reject(actor: SkillActor, ref: SkillRef, reason: string): SkillSnapshot {
    this.requireWriter(actor, 'reject')
    const why = nonEmpty(reason, 'reason')
    return this.tx(() => {
      const s = this.mustSkill(ref)
      if (s.phase !== 'candidate') raise('INVALID_TRANSITION', `skill ${s.id} is '${s.phase}', not candidate`)
      this.append(s.id, s.revision + 1, 'skill.rejected', actor, { reason: why })
      return this.requireSnapshot(s.id)
    })
  }

  /** 回退演练：把在用的技能退下来。理由必填——退掉却不记为什么，下次还会被重新提出。 */
  retire(actor: SkillActor, ref: SkillRef, reason: string): SkillSnapshot {
    this.requireWriter(actor, 'retire')
    const why = nonEmpty(reason, 'reason')
    return this.tx(() => {
      const s = this.mustSkill(ref)
      if (s.phase !== 'active') raise('INVALID_TRANSITION', `skill ${s.id} is '${s.phase}', not active`)
      this.append(s.id, s.revision + 1, 'skill.retired', actor, { reason: why })
      return this.requireSnapshot(s.id)
    })
  }

  restore(actor: SkillActor, ref: SkillRef, reason: string): SkillSnapshot {
    this.requireWriter(actor, 'restore')
    const why = nonEmpty(reason, 'reason')
    return this.tx(() => {
      const s = this.mustSkill(ref)
      if (s.phase !== 'retired') raise('INVALID_TRANSITION', `skill ${s.id} is '${s.phase}', not retired`)
      this.append(s.id, s.revision + 1, 'skill.restored', actor, { reason: why })
      return this.requireSnapshot(s.id)
    })
  }

  // ---------- 读通道 ----------

  /**
   * 最后一条 `skill.adopted` 事件的操作者。
   *
   * 用途只有一个：注入层要能区分「博士采用」与「模型自采」（`runtime/skill-inject.ts`）。
   * 不上投影表、不加列——采用者本来就是事件事实，查链即可；技能量级是个位数到几十条，
   * 一次按索引过滤的成本可忽略（`skill_events(skill_id)` 由主键前缀覆盖）。
   */
  adoptedBy(id: SkillId): SkillActor | undefined {
    const row = this.db.prepare(
      "SELECT actor_json FROM skill_events WHERE skill_id = ? AND kind = 'skill.adopted' ORDER BY seq DESC LIMIT 1",
    ).get(id) as { actor_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.actor_json) as SkillActor
  }

  get(id: SkillId): SkillSnapshot | undefined {
    const row = this.db.prepare('SELECT * FROM skills WHERE skill_id = ?').get(id) as SkillRow | undefined
    return row === undefined ? undefined : this.toSnapshot(row)
  }

  list(opts: { phase?: SkillPhase } = {}): SkillSnapshot[] {
    const rows = (opts.phase === undefined
      ? this.db.prepare('SELECT * FROM skills ORDER BY updated_at DESC, skill_id').all()
      : this.db.prepare('SELECT * FROM skills WHERE phase = ? ORDER BY updated_at DESC, skill_id').all(opts.phase)) as unknown as SkillRow[]
    return rows.map((r) => this.toSnapshot(r))
  }

  // ---------- 链与重建 ----------

  verifyChain(): ChainVerifyResult {
    const rows = this.db.prepare('SELECT * FROM skill_events ORDER BY seq').all() as unknown as EventRow[]
    // `seq` 必须回填：`appendChained` 写入时算的是 `chainHash(prev, {...fields, seq})`，
    // 而 `verifyChainRows` 把这里的返回值**原样**喂给 `chainHash`（`chain.ts:53`）。
    // 少一个字段，正常链也会被判成断链——而「断链测试」恰好断言 ok:false，
    // 于是一个漏字段的实现照样能通过断链用例，只在正常链上翻车。
    return verifyChainRows(rows, (r) => ({
      seq: r.seq,
      skill_id: r.skill_id,
      revision: r.revision,
      kind: r.kind,
      actor_json: r.actor_json,
      payload_json: r.payload_json,
      ts: r.ts,
    }))
  }

  rebuildProjections(): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM skills').run()
      const rows = this.db.prepare('SELECT * FROM skill_events ORDER BY seq').all() as unknown as EventRow[]
      for (const r of rows) {
        applySkillEvent(this.db, {
          skill_id: r.skill_id,
          revision: r.revision,
          kind: r.kind,
          actor: JSON.parse(r.actor_json) as SkillActor,
          payload: JSON.parse(r.payload_json),
          ts: r.ts,
        })
      }
    })
  }

  // ---------- 内部 ----------

  /**
   * 全生命周期对所有 actor 开放（2026-11-09 两次放开后没有保留动作）。
   *
   * 仍保留一道校验而不是彻底删掉：技能库是共享文件，写入者如果是个不认识
   * `kind` 的东西（第三方插件伪造的 actor、调试脚本传的裸字符串），那是 bug
   * 而不是自主行为——fail-closed 比默默写进去好。
   *
   * 放开的前提是技能不授予权限。一旦技能能携带工具、数据源或授权路径，
   * 必须把这里改回 owner-only（见文件头）。
   */
  private requireWriter(actor: SkillActor, op: string): void {
    if (actor?.kind !== 'owner' && actor?.kind !== 'model') {
      raise('FORBIDDEN', `only owner or model may ${op} a skill`)
    }
  }

  private mustSkill(ref: SkillRef): SkillSnapshot {
    const s = ref?.id === undefined ? undefined : this.get(ref.id)
    if (s === undefined) raise('NOT_FOUND', `skill ${String(ref?.id)} not found`)
    if (s.revision !== ref.revision) {
      raise('STALE_REVISION', `skill ${s.id} is at revision ${s.revision}, got ${String(ref.revision)}`)
    }
    return s
  }

  private requireSnapshot(id: SkillId): SkillSnapshot {
    const s = this.get(id)
    if (s === undefined) raise('NOT_FOUND', `skill ${id} vanished after write`)
    return s
  }

  private append(skillId: SkillId, revision: number, kind: SkillEventKind, actor: SkillActor, payload: unknown): void {
    appendChained(this.db, 'skill_events', {
      skill_id: skillId,
      revision,
      kind,
      actor_json: canonicalJson(actor),
      payload_json: canonicalJson(payload),
      ts: Date.now(),
    }, (f) => f as Record<string, SQLInputValue>)
    applySkillEvent(this.db, { skill_id: skillId, revision, kind, actor, payload, ts: Date.now() })
  }

  private toSnapshot(row: SkillRow): SkillSnapshot {
    return {
      id: row.skill_id as SkillId,
      revision: row.revision,
      phase: row.phase as SkillPhase,
      title: row.title,
      trigger: row.trigger_text,
      steps: JSON.parse(row.steps_json) as string[],
      pitfalls: JSON.parse(row.pitfalls_json) as string[],
      sourceRefs: JSON.parse(row.source_refs_json) as string[],
      proposedBy: JSON.parse(row.proposed_by_json) as SkillActor,
      evaluations: JSON.parse(row.evaluations_json) as SkillEvaluation[],
      ...(row.retire_reason === null ? {} : { retireReason: row.retire_reason }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* 事务已回滚 */ }
      throw error
    }
  }
}
