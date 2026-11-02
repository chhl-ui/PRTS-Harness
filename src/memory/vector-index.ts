/**
 * 内存向量索引：把 `mem_vectors` 一次性解码进 `Float32Array`，查询走内存点积。
 *
 * 为什么需要它：`store.search` 的语义路原来是
 *   `SELECT ... FROM mem_vectors ORDER BY owner_kind, owner_id LIMIT 50000`
 * ——`owner_kind` 是字符串序，`turn` 排在 `fact` / `profile` 之后，于是 24.6 万条 turn 向量
 * 只有 49,167 条（19.9%）进入扫描范围。实测该上限下九组融合权重没有一组超过纯 bm25
 * （30.9% vs 31.8%，McNemar p=0.83）；全量扫描下门控 w 1:0.5 达 36.9%（p=0.0357）。
 * 依据与数字：`docs/memory-recall-criteria-retest-2026-11-03.md`。
 *
 * 为什么不直接抬 cap：去掉 `LIMIT` 时每次查询都要从 BLOB 解码约 1 GB，实测单次秒级；
 * 而解码结果在两次查询之间不变。索引把这份成本提到一次（约 5 秒），查询降到约 0.25 秒。
 *
 * fail-open 纪律：未预热、维度不符、空库时 `query()` 一律返回 `null`，调用方降级回原
 * SQL 路径。索引是加速器，不是新的失败点——这条按 `AGENTS.md` 的 fail-closed 反向使用：
 * 检索精度可以降级，检索本身不能因为索引没准备好而失败。
 *
 * 语法约束：本文件遵守 `erasableSyntaxOnly`（无 enum / 参数属性 / 装饰器）。
 */
import type { DatabaseSync } from 'node:sqlite'
import { decodeVector } from './embedding.ts'

const KEY_SEP = '\u0000'
/** `(kind, id)` 合成索引键。用 NUL 分隔，避免 kind 里出现分隔符导致碰撞。 */
const ownerKey = (kind: string, id: string): string => kind + KEY_SEP + id

/** 待写入/待覆盖的一条向量。 */
export interface VectorEntry {
  ownerKind: string
  ownerId: string
  vector: ArrayLike<number>
}

/** 一条相似度命中。 */
export interface VectorHit {
  ownerKind: string
  ownerId: string
  sim: number
}

export class MemVectorIndex {
  /** 行号即数组下标；与 `kinds` 等长。 */
  private ids: string[] = []
  private kinds: string[] = []
  /** `ownerKey` → 行号。覆盖写入时定位用。 */
  private lookup = new Map<string, number>()
  /** 行主序的 **L2 归一化** 向量；查询只需点积，省掉每行的模。 */
  private flat = new Float32Array(0)
  private dim = 0
  private ready = false
  /** 解码失败或维度不符被跳过的行数——与 `vectorStats()` 并列的第二信号。 */
  private skipped = 0

  get isReady(): boolean {
    return this.ready
  }

  get size(): number {
    return this.ids.length
  }

  get dimension(): number {
    return this.dim
  }

  get skippedCount(): number {
    return this.skipped
  }

  /** 丢弃索引内容（关闭、维度变更、向量删除后调用）。 */
  reset(): void {
    this.ids = []
    this.kinds = []
    this.lookup = new Map()
    this.flat = new Float32Array(0)
    this.dim = 0
    this.ready = false
    this.skipped = 0
  }

  /**
   * 全量加载。同步，调用方决定时机（预热是显式动作，不在构造/打开时隐式发生）。
   *
   * 用 `rowid` 游标分页而不是 `OFFSET`：后者在 24 万行上每页都要重排一次。
   * 不预先分配整表空间：`dim` 要读到第一行才知道，且损坏行会被跳过；改用翻倍扩容，
   * 峰值约 1.5 × 最终大小（本库 1.0 GB → 峰值 1.5 GB），换来不动脑的正确性。
   *
   * @returns 实际入索引的条数（0 表示空库或全部不可用）
   */
  load(db: DatabaseSync): number {
    this.reset()
    const pageSize = 20_000
    let cursor = 0
    for (;;) {
      const rows = db.prepare(
        `SELECT rowid AS rid, owner_kind, owner_id, vector FROM mem_vectors
          WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).all(cursor, pageSize) as unknown as Array<{
        rid: number
        owner_kind: string
        owner_id: string
        vector: Uint8Array
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        cursor = r.rid
        let v: Float32Array
        try {
          v = decodeVector(r.vector)
        } catch {
          this.skipped += 1
          continue
        }
        if (this.dim === 0) this.dim = v.length
        // 维度不符 = 换过模型但没重算：跳过并记账，与 SQL 路径同口径。
        if (v.length !== this.dim) {
          this.skipped += 1
          continue
        }
        this.append(r.owner_kind, r.owner_id, v)
      }
      if (rows.length < pageSize) break
    }
    this.ready = this.ids.length > 0
    return this.ids.length
  }

  /**
   * 增量覆盖写入（调度器空闲补向量时会连续调用）。
   *
   * @returns `true` = 已并入索引；`false` = 索引未就绪或维度不符，调用方应视为
   *   需要重载（`false` 时本方法会把索引置回未就绪，后续检索自动降级 SQL 路径）。
   */
  upsert(entries: readonly VectorEntry[]): boolean {
    if (!this.ready) return false
    if (entries.length === 0) return true
    for (const e of entries) {
      if (e.vector.length !== this.dim) {
        // 维度变了意味着换了 embedding 模型：旧索引整体作废，不能半新半旧地留着。
        this.reset()
        return false
      }
      const row = this.lookup.get(ownerKey(e.ownerKind, e.ownerId))
      if (row === undefined) this.append(e.ownerKind, e.ownerId, e.vector)
      else this.overwrite(row, e.vector)
    }
    return true
  }

  /**
   * 余弦 top-K。返回按相似度降序、且 `sim >= minSim` 的命中。
   *
   * @returns `null` = 索引不可用（未就绪 / 空 / 维度不符），调用方降级。
   */
  query(queryVector: ArrayLike<number>, topK: number, minSim: number): VectorHit[] | null {
    if (!this.ready || this.dim === 0 || topK <= 0) return null
    if (queryVector.length !== this.dim) return null
    const n = this.ids.length
    if (n === 0) return null

    let qn = 0
    for (let d = 0; d < this.dim; d++) qn += queryVector[d] * queryVector[d]
    qn = Math.sqrt(qn) || 1

    // 部分选择：维护长度 topK 的降序小数组。阈值必须取自**已排序**的第 K 名，
    // 否则选出的集合是错的（探针里踩过：填充阶段反复整数组 sort 是 O(n log n) 次比较，
    // 只排一次又会让阈值拿未排序的末元素）。
    const hitRow: number[] = []
    const hitSim: number[] = []
    let kth = -Infinity
    for (let i = 0; i < n; i++) {
      const base = i * this.dim
      let s = 0
      for (let d = 0; d < this.dim; d++) s += this.flat[base + d] * queryVector[d]
      s /= qn
      if (hitRow.length < topK) {
        hitRow.push(i)
        hitSim.push(s)
        if (hitRow.length === topK) {
          this.sortDesc(hitRow, hitSim, 0, topK)
          kth = hitSim[topK - 1]
        }
      } else if (s > kth) {
        hitRow[topK - 1] = i
        hitSim[topK - 1] = s
        for (let j = topK - 1; j > 0 && hitSim[j] > hitSim[j - 1]; j--) {
          const tr = hitRow[j]; hitRow[j] = hitRow[j - 1]; hitRow[j - 1] = tr
          const ts = hitSim[j]; hitSim[j] = hitSim[j - 1]; hitSim[j - 1] = ts
        }
        kth = hitSim[topK - 1]
      }
    }
    if (hitRow.length < topK) this.sortDesc(hitRow, hitSim, 0, hitRow.length)

    const out: VectorHit[] = []
    for (let i = 0; i < hitRow.length; i++) {
      if (hitSim[i] < minSim) continue
      const row = hitRow[i]
      out.push({ ownerKind: this.kinds[row], ownerId: this.ids[row], sim: hitSim[i] })
    }
    return out
  }

  private append(kind: string, id: string, v: ArrayLike<number>): void {
    const k = ownerKey(kind, id)
    if (this.lookup.has(k)) {
      this.overwrite(this.lookup.get(k) as number, v)
      return
    }
    let n = 0
    for (let d = 0; d < this.dim; d++) n += v[d] * v[d]
    const norm = Math.sqrt(n) || 1
    const row = this.ids.length
    const need = (row + 1) * this.dim
    if (need > this.flat.length) {
      let size = this.flat.length === 0 ? this.dim * 1024 : this.flat.length
      while (size < need) size *= 2
      const grown = new Float32Array(size)
      grown.set(this.flat)
      this.flat = grown
    }
    const base = row * this.dim
    for (let d = 0; d < this.dim; d++) this.flat[base + d] = v[d] / norm
    this.ids.push(id)
    this.kinds.push(kind)
    this.lookup.set(k, row)
  }

  private overwrite(row: number, v: ArrayLike<number>): void {
    let n = 0
    for (let d = 0; d < this.dim; d++) n += v[d] * v[d]
    const norm = Math.sqrt(n) || 1
    const base = row * this.dim
    for (let d = 0; d < this.dim; d++) this.flat[base + d] = v[d] / norm
  }

  /** 同步排 `row` 与 `sim` 的前 `len` 项，按相似度降序（topK 很小，选择排序足够）。 */
  private sortDesc(row: number[], sim: number[], from: number, len: number): void {
    for (let i = from; i < from + len - 1; i++) {
      let best = i
      for (let j = i + 1; j < from + len; j++) if (sim[j] > sim[best]) best = j
      if (best !== i) {
        const tr = row[i]; row[i] = row[best]; row[best] = tr
        const ts = sim[i]; sim[i] = sim[best]; sim[best] = ts
      }
    }
  }
}
