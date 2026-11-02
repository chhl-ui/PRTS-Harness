/**
 * 内存向量索引（`MemVectorIndex`）——绕开 `SEMANTIC_SCAN_CAP` 的截断。
 *
 * 为什么需要：`store.search` 的语义路未预热时走
 *   `SELECT ... FROM mem_vectors ORDER BY owner_kind, owner_id LIMIT 50000`
 * ——`owner_kind` 字符串序把 `turn` 排到最后，本库 24.6 万条 turn 只有 49,167 条（19.9%）
 * 进入扫描窗口；该上限下九组融合权重无一超过纯 bm25（30.9% vs 31.8%，p=0.83）。
 * 依据：`docs/memory-recall-criteria-retest-2026-11-03.md`。
 *
 * 这组测**机制**：全量入索引、维度不符降级、覆盖写入、未预热时降级、预热前后检索结果
 * 一致（小库无 cap 差异，所以一致性是回归保护）。语义效果由探针在真库上测——
 * 单测里造 5 万条向量不现实，也不能说明收益。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { MemVectorIndex } from '../../src/memory/vector-index.ts'
import { makeTmp } from '../support/tmp.ts'

/** 直接建一个只含向量的库（`mem_vectors` 无外键，不必先造 turn/fact 行）。 */
const seedVectors = (
  path: string,
  rows: Array<{ kind: 'turn' | 'fact' | 'profile'; id: string; vec: number[] }>,
  model = 'fake-bow',
): void => {
  const store = MemoryStore.open(path)
  store.putVectors(
    rows.map((r) => ({ ownerKind: r.kind, ownerId: r.id, vector: r.vec })),
    model,
  )
  store.close()
}

test('X1 load 把三类 owner 的向量全量入索引，不受 owner_kind 排序影响', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [
    { kind: 'fact', id: 'f1', vec: [1, 0, 0, 0] },
    { kind: 'profile', id: 'p1', vec: [0, 1, 0, 0] },
    { kind: 'turn', id: 't1', vec: [0, 0, 1, 0] },
    { kind: 'turn', id: 't2', vec: [0, 0, 0, 1] },
  ])
  const store = MemoryStore.open(path)
  try {
    const n = store.warmVectorIndex()
    assert.equal(n, 4, '四类向量必须全部入索引（SQL 路径在 >5 万条时会把 turn 截掉）')
    const st = store.vectorIndexStatus()
    assert.equal(st.ready, true)
    assert.equal(st.size, 4)
    assert.equal(st.dimension, 4)
    assert.equal(st.skipped, 0)
  } finally {
    store.close()
    tmp.cleanup()
  }
})

test('X2 query 按余弦降序返回，遵守 minSim 下限与 topK 截断', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [
    { kind: 'turn', id: 'near', vec: [1, 0.1, 0, 0] },
    { kind: 'turn', id: 'mid', vec: [0.5, 0.5, 0, 0] },
    { kind: 'turn', id: 'far', vec: [0, 0, 1, 0] },
  ])
  const db = new DatabaseSync(path)
  try {
    const idx = new MemVectorIndex()
    assert.equal(idx.load(db), 3)
    assert.equal(idx.isReady, true)
    assert.equal(idx.dimension, 4)

    const all = idx.query([1, 0.1, 0, 0], 3, 0)
    assert.ok(all !== null)
    assert.equal(all.length, 3)
    assert.equal(all[0].ownerId, 'near', '与查询同向的条目必须排第一')
    assert.equal(all[1].ownerId, 'mid')
    assert.ok(all[0].sim > all[1].sim && all[1].sim > all[2].sim, '相似度必须严格降序')

    const strict = idx.query([1, 0.1, 0, 0], 3, 0.99)
    assert.ok(strict !== null)
    assert.equal(strict.length, 1, 'minSim 必须过滤掉低相似条目')
    assert.equal(strict[0].ownerId, 'near')

    const top1 = idx.query([1, 0.1, 0, 0], 1, 0)
    assert.ok(top1 !== null)
    assert.equal(top1.length, 1, 'topK 必须截断')
    assert.equal(top1[0].ownerId, 'near')
  } finally {
    db.close()
    tmp.cleanup()
  }
})

test('X3 未预热时索引未就绪（调用方降级），预热后 size 与库一致', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [{ kind: 'turn', id: 't1', vec: [1, 0, 0, 0] }])
  const store = MemoryStore.open(path)
  try {
    const before = store.vectorIndexStatus()
    assert.equal(before.ready, false, '打开不隐式预热——5 秒阻塞不能发生在首轮之前')
    assert.equal(before.size, 0)

    assert.equal(store.warmVectorIndex(), 1)
    const after = store.vectorIndexStatus()
    assert.equal(after.ready, true)
    assert.equal(after.size, 1)
  } finally {
    store.close()
    tmp.cleanup()
  }
})

test('X4 putVectors 预热后增量并入：同键覆盖、新键追加', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [{ kind: 'turn', id: 't1', vec: [1, 0, 0, 0] }])
  const store = MemoryStore.open(path)
  try {
    assert.equal(store.warmVectorIndex(), 1)
    store.putVectors(
      [
        { ownerKind: 'turn', ownerId: 't1', vector: [0, 1, 0, 0] },
        { ownerKind: 'turn', ownerId: 't2', vector: [0, 0, 1, 0] },
      ],
      'fake-bow',
    )
    const st = store.vectorIndexStatus()
    assert.equal(st.size, 2, '覆盖不能新增行，追加必须入索引')
    assert.equal(st.ready, true)
  } finally {
    store.close()
    tmp.cleanup()
  }
})

test('X5 维度不符的向量写入会让索引整体作废（不能半新半旧地留着）', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [{ kind: 'turn', id: 't1', vec: [1, 0, 0, 0] }])
  const store = MemoryStore.open(path)
  try {
    assert.equal(store.warmVectorIndex(), 1)
    store.putVectors([{ ownerKind: 'turn', ownerId: 't9', vector: [1, 0, 0] }], 'other-model')
    const st = store.vectorIndexStatus()
    assert.equal(st.ready, false, '换了 embedding 模型后旧索引必须失效，检索退回 SQL 路径')
    assert.equal(st.size, 0)
  } finally {
    store.close()
    tmp.cleanup()
  }
})

test('X6 预热前后 search 的语义命中一致（小库无 cap 差异，作为回归保护）', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  const store = MemoryStore.open(path)
  try {
    const t1 = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'my camera is a Sony' })
    const t2 = store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 1, speaker: 'user', text: 'I drink tea every morning' })
    store.putVectors([
      { ownerKind: 'turn', ownerId: t1, vector: [1, 0.2, 0, 0] },
      { ownerKind: 'turn', ownerId: t2, vector: [0, 0, 1, 0] },
    ], 'fake-bow')

    const qv = [1, 0.1, 0, 0]
    const cold = store.search({ text: 'camera', limit: 5, queryVector: qv, semanticTopK: 2 })
    assert.ok(cold.length > 0, '前置条件：预热前也必须能检索到东西，否则一致性断言是空转')

    assert.equal(store.warmVectorIndex(), 2)
    const warm = store.search({ text: 'camera', limit: 5, queryVector: qv, semanticTopK: 2 })
    assert.deepEqual(
      warm.map((h) => h.id).sort(),
      cold.map((h) => h.id).sort(),
      '同一个小库上，预热前后的命中集合必须一致——索引只扩大覆盖面，不该改变排序口径',
    )
  } finally {
    store.close()
    tmp.cleanup()
  }
})

test('X7 close 释放索引（重开后必须重新预热，不能残留上一个库的向量）', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [{ kind: 'turn', id: 't1', vec: [1, 0, 0, 0] }])
  const first = MemoryStore.open(path)
  assert.equal(first.warmVectorIndex(), 1)
  first.close()
  const second = MemoryStore.open(path)
  try {
    assert.equal(second.vectorIndexStatus().ready, false, '索引属于 store 实例，关闭即释放')
  } finally {
    second.close()
    tmp.cleanup()
  }
})

test('X8 损坏的向量 BLOB 被跳过并记账，不影响其余条目', () => {
  const tmp = makeTmp('prts-vidx-')
  const path = tmp.db()
  seedVectors(path, [{ kind: 'turn', id: 'ok', vec: [1, 0, 0, 0] }])
  // 直接塞一条二进制垃圾：模拟旧库里的坏行
  const raw = new DatabaseSync(path)
  raw.prepare(
    `INSERT INTO mem_vectors (owner_kind, owner_id, model, dim, vector, updated_at_ms)
     VALUES ('turn','bad','fake-bow',4,?,?)`,
  ).run(new Uint8Array([1, 2, 3]), Date.now())
  raw.close()

  const store = MemoryStore.open(path)
  try {
    assert.equal(store.warmVectorIndex(), 1, '只有可解码的那条入索引')
    const st = store.vectorIndexStatus()
    assert.equal(st.ready, true)
    assert.equal(st.size, 1)
    assert.ok(st.skipped >= 1, '跳过的条数必须记账，不能只有「检索变差」这一个症状')
  } finally {
    store.close()
    tmp.cleanup()
  }
})
