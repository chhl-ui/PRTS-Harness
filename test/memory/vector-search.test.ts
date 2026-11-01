/**
 * 向量检索路（v2.17）。
 *
 * 这组测试全部用**假 embedder**（词袋哈希，纯本地、确定性、不联网）——
 * 真实 Ollama 只在探针里用。理由：任何依赖本地服务的测试在 CI 上会变成
 * 静默跳过，而静默跳过的测试等于没有测试（本项目已因此栽过一次：
 * 「全套单测没抓到旧库迁移 bug，因为都用新库」）。
 *
 * 测的是**机制**：向量写读、融合顺序、命名空间、降级、幂等。
 * 不断言真实语义效果——那要评测集，属于探针的职责。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  MemoryStore, cosineSimilarity, decodeVector, encodeVector, type Embedder,
} from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

/** 词袋哈希 embedder：同词落同一维，靠词重叠产生相似度。确定性、离线、毫秒级。 */
const bagEmbedder = (model = 'fake-bow', dim = 64): Embedder => ({
  model,
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(dim).fill(0)
      for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (w === '') continue
        let h = 0
        for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % 100000
        v[h % dim] += 1
      }
      return v
    })
  },
})

/** 直接插一行画像（生产里由巩固管线写入，这里绕过它以聚焦检索路）。 */
const seedProfile = (path: string, id: string, body: string): void => {
  const raw = new DatabaseSync(path)
  raw.prepare(
    `INSERT INTO mem_profiles (profile_id, scope, subject, aspect, profile_body, confidence, updated_at_ms)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(id, 'prts', 'user', 'photography', body, 0.8, Date.now())
  // 只索引当前这一条。整表重建（不带 WHERE）在第二次调用时会拿已存在的 rowid
  // 再插一次，触发主键冲突——而那个冲突会被 finally 里临时目录清理失败掩盖，
  // 表面症状是 EPERM，真实原因是 constraint failed。踩过一次，记在这里。
  raw.prepare(
    `INSERT INTO mem_fts_profiles(rowid, body)
     SELECT rowid, profile_body FROM mem_profiles WHERE profile_id = ?`,
  ).run(id)
  raw.close()
}

test('V1 向量编解码 round-trip 保持 float32 精度', () => {
  const src = [0.125, -1.5, 0.3333333432674408, 1e-7, -0]
  const back = decodeVector(encodeVector(src))
  assert.equal(back.length, src.length)
  for (let i = 0; i < src.length; i++) {
    assert.equal(back[i], Math.fround(src[i]), `第 ${i} 维不一致`)
  }
})

test('V2 编码长度不是 4 的倍数时解码必须报错，不静默截断', () => {
  assert.throws(() => decodeVector(new Uint8Array([1, 2, 3])), /不是 4 的倍数/)
})

test('V3 维度不一致时余弦必须报错——静默截断会把「忘了重算」变成「分数变低」', () => {
  assert.throws(() => cosineSimilarity([1, 2, 3], [1, 2]), /维度不一致/)
})

test('V4 不给 queryVector 时走向量路不改变现有行为（基线一字不变）', async () => {
  const t = makeTmp('prts-mem-vec-off-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'Sony camera gear recommendation' })
    seedProfile(path, 'prof-0', 'The user shoots with a Sony A7R IV and prefers Sony compatible accessories.')
    await m.embedPending({ embedder: bagEmbedder() })

    // 关了向量路：结果里不应出现 semantic 召回
    const off = m.search({ text: 'Sony camera gear', limit: 5, profileQuota: 2 })
    assert.equal(off.filter((h) => h.recallPath === 'semantic').length, 0, 'semanticTopK 未开时不能有向量召回')
    assert.ok(off.length >= 1, '原有 bm25/LIKE 路仍然工作')

    // semanticTopK 给了但 queryVector 缺席：同样必须降级，不抛错
    const half = m.search({ text: 'Sony camera gear', limit: 5, profileQuota: 2, semanticTopK: 3 })
    assert.equal(half.filter((h) => h.recallPath === 'semantic').length, 0, '没有查询向量时必须静默降级')
  } finally {
    t.cleanup(m)
  }
})

test('V5 给出 queryVector 后，向量路把语义最接近的画像带进结果', async () => {
  const t = makeTmp('prts-mem-vec-on-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    seedProfile(path, 'prof-sony', 'The user shoots with a Sony A7R IV camera and prefers Sony compatible accessories.')
    seedProfile(path, 'prof-nikon', 'The user shoots with a Nikon Z6 camera and wants tripod recommendations.')
    await m.embedPending({ embedder: bagEmbedder() })
    assert.deepEqual(
      m.vectorStats().map((s) => `${s.ownerKind}:${s.count}`),
      ['profile:2'],
      '两条画像都应完成向量化',
    )

    // 用与 Sony 画像词重叠更多的查询向量
    const [qv] = await bagEmbedder().embed(['Sony camera accessories'])
    const hits = m.search({
      text: 'accessories', // 字面只给一个泛词，靠向量路补齐语义
      limit: 5,
      profileQuota: 2,
      queryVector: qv,
      semanticTopK: 2,
    })
    // 多路召回时 recallPath 只记首次来源，判「向量是否立功」必须看 recallPaths
    const sources = (h: { recallPath: string; recallPaths?: string[] }) => h.recallPaths ?? [h.recallPath]
    assert.ok(
      hits.some((h) => sources(h).includes('semantic')),
      `向量路必须有召回，实际 ${JSON.stringify(hits.map((h) => [h.id, sources(h)]))}`,
    )
    const sony = hits.find((h) => h.id === 'profile-prof-sony')
    assert.ok(sony !== undefined, `Sony 画像必须进结果，实际 ${hits.map((h) => h.id).join(' | ')}`)
    assert.ok(
      sources(sony).includes('semantic'),
      `Sony 画像应被向量路召回，实际来源 ${JSON.stringify(sources(sony))}`,
    )
  } finally {
    t.cleanup(m)
  }
})

test('V6 向量路的 id 带 profile 命名空间，不与同 id 的 fact 互相吞并', async () => {
  const t = makeTmp('prts-mem-vec-ns-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    // 故意让 fact 与 profile 用同一个业务 id
    const factId = m.assertFact({
      actor: 'model', subject: 'user', predicate: 'camera',
      object: 'The user shoots with a Sony A7R IV camera and prefers Sony accessories.',
      provenance: 'inferred', confirmationBasis: 'model-inferred',
    })
    seedProfile(path, factId, 'The user shoots with a Sony A7R IV camera and prefers Sony accessories.')
    await m.embedPending({ embedder: bagEmbedder() })

    const [qv] = await bagEmbedder().embed(['Sony accessories'])
    const hits = m.search({ text: 'Sony', limit: 8, profileQuota: 2, queryVector: qv, semanticTopK: 4 })
    const ids = hits.map((h) => `${h.kind}:${h.id}`)
    assert.ok(ids.includes(`fact:${factId}`), `fact 必须保留，实际 ${ids.join(' | ')}`)
    assert.ok(ids.includes(`profile:profile-${factId}`), `画像必须保留，实际 ${ids.join(' | ')}`)
  } finally {
    t.cleanup(m)
  }
})

test('V7 embedPending 幂等：补齐一次后第二次不再重复生成', async () => {
  const t = makeTmp('prts-mem-vec-idem-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.assertFact({
      actor: 'model', subject: 'user', predicate: 'preference',
      object: 'The user prefers Adobe Premiere Pro for video editing.',
      provenance: 'inferred', confirmationBasis: 'model-inferred',
    })
    const first = await m.embedPending({ embedder: bagEmbedder() })
    assert.equal(first.embedded, 1, '首轮应补齐 1 条')
    const second = await m.embedPending({ embedder: bagEmbedder() })
    assert.equal(second.embedded, 0, '次轮不应重复生成')
  } finally {
    t.cleanup(m)
  }
})

test('V8 换模型（model 变了）时同一条会被重算覆盖，不留下双份语义空间', async () => {
  const t = makeTmp('prts-mem-vec-model-')
  const path = t.db('memory.sqlite')
  const m = MemoryStore.open(path)
  try {
    m.assertFact({
      actor: 'model', subject: 'user', predicate: 'preference',
      object: 'The user prefers Adobe Premiere Pro.',
      provenance: 'inferred', confirmationBasis: 'model-inferred',
    })
    await m.embedPending({ embedder: bagEmbedder('model-a') })
    assert.deepEqual(m.vectorStats().map((s) => s.model), ['model-a'], '首轮模型应为 model-a')

    const switched = await m.embedPending({ embedder: bagEmbedder('model-b') })
    assert.equal(switched.embedded, 1, '换模型后应重算')
    assert.deepEqual(m.vectorStats().map((s) => s.model), ['model-b'], '同一条只能留一份向量')
  } finally {
    t.cleanup(m)
  }
})
