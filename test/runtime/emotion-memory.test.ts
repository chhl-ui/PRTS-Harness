/**
 * M→E 记忆→情感（DESIGN-07 S1–S6）：想起 + 顾虑两个生产者。
 *
 * 期望值全部手算、先于实现写定。fake hookCtx 逐字复刻 cordis waterfall 语义
 * （外层先跑、next() 进入下一层、next() 后副作用逆注册序——S5 的顺序断言靠它）。
 * 内部自检不算验证：每条都是独立构造对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import {
  trailingFailures, shouldWriteRecall, shouldWriteConcern, mentionsTask,
  createMemoryRecallSignal, attachFailureMention,
  RECALL_MOOD, CONCERN_MOOD, RECALL_COMPONENT, CONCERN_COMPONENT, RECALL_COOLDOWN_MS,
} from '../../src/runtime/emotion-memory.ts'
import { attachMemoryInjection } from '../../src/runtime/memory-inject.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { EmotionStore } from '../../src/emotion/index.ts'
import { Ledger } from '../../src/ledger/index.ts'
import type { TaskSnapshot } from '../../src/ledger/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'

const OWNER = { kind: 'owner' } as const
const MODEL = { kind: 'model', sessionId: 'sess-x' } as const
const DAY = 86_400_000
const T0 = 1_700_000_000_000

type Decision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }
type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** cordis waterfall 复刻：注册序外层先跑，next() 进入下一层，末层返回 base。 */
function fakeHook() {
  const handlers: Handler[] = []
  const ctx = {
    on(_name: string, fn: Handler): () => void {
      handlers.push(fn)
      return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1) }
    },
  }
  const fire = (payload: unknown, base: Decision = { kind: 'enter', messages: [] }): Promise<unknown> => {
    const dispatch = (i: number): Promise<unknown> => {
      const h = handlers[i]
      if (h === undefined) return Promise.resolve(base)
      return h(payload, () => dispatch(i + 1))
    }
    return dispatch(0)
  }
  return { ctx, fire }
}

function preStep(sessionId: string, query: string, turn = 0, step = 0): unknown {
  return { agent: { session: { id: sessionId } }, messages: [{ role: 'user', content: query }], turn, step }
}

function emotionChain(path: string): Array<{ seq: number; actor_json: string; payload_json: string; ts: number }> {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare('SELECT seq, actor_json, payload_json, ts FROM emotion_events ORDER BY seq').all() as never
  } finally {
    db.close()
  }
}

// ---------- S1 纯函数 ----------

test('ME1 trailingFailures：空 / 全败 / 先拒后收 / 收后再败', () => {
  const f = { outcome: 'failure' } as const
  const s = { outcome: 'success' } as const
  assert.equal(trailingFailures([]), 0)
  assert.equal(trailingFailures([f]), 1)
  assert.equal(trailingFailures([f, f]), 2)
  assert.equal(trailingFailures([f, f, s]), 0, '先拒后收不算反复失败')
  assert.equal(trailingFailures([s, f, f]), 2)
  assert.equal(trailingFailures([f, s, f]), 1)
})

test('ME2 想起冷却边界：恰好 7 天不写，超过才写；从没写过 → 写', () => {
  const base = { nowMs: T0 + 8 * DAY, cooldownMs: RECALL_COOLDOWN_MS }
  assert.equal(shouldWriteRecall({ ...base, lastRecallAtMs: undefined }), true)
  assert.equal(shouldWriteRecall({ ...base, lastRecallAtMs: T0 + DAY }), false, '恰好 7 天不算超过')
  assert.equal(shouldWriteRecall({ ...base, lastRecallAtMs: T0 + DAY - 1 }), true)
  assert.equal(shouldWriteRecall({ ...base, lastRecallAtMs: T0 + 2 * DAY }), false)
})

test('ME3 顾虑判定：连败够数 + 无新结局不重写（含同刻边界）', () => {
  const base = { failures: 2, lastOutcomeAtMs: T0 + 100 }
  assert.equal(shouldWriteConcern({ ...base, failures: 1, lastConcernAtMs: undefined }), false, '1 次不算反复')
  assert.equal(shouldWriteConcern({ ...base, lastConcernAtMs: undefined }), true)
  assert.equal(shouldWriteConcern({ ...base, lastConcernAtMs: T0 + 200 }), false, '结局后已写过')
  assert.equal(shouldWriteConcern({ ...base, lastConcernAtMs: T0 + 100 }), false, '同刻也算已写')
  assert.equal(shouldWriteConcern({ ...base, lastConcernAtMs: T0 + 50 }), true, '上次写后又有了新结局')
})

test('ME4 提到检测：共享 0/1/2 token、短标题全包含、归一化、空标题', () => {
  const title = '核对归档目录'
  assert.equal(mentionsTask('归档目录核对完了吗', title), true, '共享 3 token')
  assert.equal(mentionsTask('核对一下账目', title), false, '只共享 1 token')
  assert.equal(mentionsTask('今天天气不错', title), false, '零共享')
  assert.equal(mentionsTask('归档做完了吗', '归档'), true, '2 字标题靠全包含兜底')
  assert.equal(mentionsTask('核对归档目录。', '核对 归档目录'), true, '标点空白归一化')
  assert.equal(mentionsTask('随便说点什么', ''), false, '空标题不算提到')
})

// ---------- S2 想起接线（真实两库 + 真实 attachMemoryInjection） ----------

interface RecallRig {
  memory: MemoryStore
  emotion: EmotionStore
  emotionDbPath: string
  fire: (payload: unknown, base?: Decision) => Promise<unknown>
  cleanup: () => void
}

function recallRig(prefix: string, cooldownMs?: number): RecallRig {
  const t = makeTmp(prefix)
  const memory = MemoryStore.open(t.db('memory.sqlite'))
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const hook = fakeHook()
  const injection = attachMemoryInjection(hook.ctx, {
    store: memory,
    onHits: createMemoryRecallSignal({
      emotion,
      ...(cooldownMs === undefined ? {} : { cooldownMs }),
      log: () => { /* 测试静音 */ },
    }),
  })
  return {
    memory, emotion, emotionDbPath, fire: hook.fire,
    cleanup: () => { injection.dispose(); t.cleanup(memory, emotion) },
  }
}

function seedFact(memory: MemoryStore, object: string): string {
  return memory.assertFact({
    actor: 'system', subject: '博士', predicate: '说过', object,
    provenance: 'stated', confirmationBasis: 'owner-stated', origin: 'live',
  })
}

test('ME5 fact 命中 → 一条想起：actor/mood/reason/refId 逐项，注入正文照常', async () => {
  const r = recallRig('prts-me-recall-')
  try {
    const factId = seedFact(r.memory, '冬天去看极光')
    const before = Date.now()
    const decision = await r.fire(preStep('sess-a', '冬天去看极光')) as Decision
    assert.equal(decision.kind, 'enter')
    const injected = decision.messages.map((m) => JSON.stringify(m)).join('')
    assert.match(injected, /\[记忆检索\]/, '注入正文必须在 messages 里')

    const chain = emotionChain(r.emotionDbPath)
    assert.equal(chain.length, 1)
    assert.deepEqual(JSON.parse(chain[0].actor_json), { kind: 'system', component: RECALL_COMPONENT })
    const p = JSON.parse(chain[0].payload_json) as { valence: number; arousal: number; label: string; reason: string; refId: string }
    assert.equal(p.label, '想起')
    assert.equal(p.valence, RECALL_MOOD.valence)
    assert.equal(p.arousal, RECALL_MOOD.arousal)
    assert.equal(p.refId, factId)
    assert.match(p.reason, /想起旧事：冬天去看极光/)
    assert.ok(chain[0].ts >= before && chain[0].ts <= Date.now())
  } finally {
    r.cleanup()
  }
})

test('ME6 turn-only 命中 → 注入但不写情绪（原始对话不是旧事）', async () => {
  const r = recallRig('prts-me-turnonly-')
  try {
    r.memory.recordTurn({
      actor: 'system', sessionId: 'sess-old', turnIndex: 0, speaker: 'user',
      text: '冬天去看极光', origin: 'live',
    })
    // 查询与 turn 正文不同字（本轮原话兜底过滤），但共享 token 足以命中
    const decision = await r.fire(preStep('sess-a', '冬天去看极光怎么样')) as Decision
    assert.equal(decision.kind, 'enter')
    assert.match(JSON.stringify(decision.messages), /\[记忆检索\]/, 'turn 命中照常注入')
    assert.equal(emotionChain(r.emotionDbPath).length, 0, 'turn 命中不写想起')
  } finally {
    r.cleanup()
  }
})

test('ME7 同 fact 冷却内再命中不写；冷却外再写（跨会话）', async () => {
  const r = recallRig('prts-me-cooldown-', 50)
  try {
    seedFact(r.memory, '冬天去看极光')
    await r.fire(preStep('sess-a', '冬天去看极光'))
    assert.equal(emotionChain(r.emotionDbPath).length, 1)
    // 同会话同 fact 会被注入层去重（不再注入），所以用新会话证明冷却在情绪层
    await r.fire(preStep('sess-b', '冬天去看极光'))
    assert.equal(emotionChain(r.emotionDbPath).length, 1, '冷却内不重复写')
    await new Promise((res) => setTimeout(res, 60))
    await r.fire(preStep('sess-c', '冬天去看极光'))
    assert.equal(emotionChain(r.emotionDbPath).length, 2, '冷却外再写')
  } finally {
    r.cleanup()
  }
})

test('ME8 多 fact 命中只写一条（注入序的第一条 fact）', async () => {
  const t = makeTmp('prts-me-multifact-')
  const memory = MemoryStore.open(t.db('memory.sqlite'))
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const hook = fakeHook()
  // 排序是检索层的口径（RRF×命中词数，LIKE 路会放大），不在本模块契约内；
  // 这里要钉的是「写注入序第一条」，所以观测 onHits 实收的 hits 再对照。
  let firstFact: { id: string; text: string } | undefined
  let factCount = 0
  const signal = createMemoryRecallSignal({ emotion, log: () => { /* 测试静音 */ } })
  const injection = attachMemoryInjection(hook.ctx, {
    store: memory,
    onHits: (hits, ctx) => {
      const facts = hits.filter((h) => h.kind === 'fact')
      factCount = facts.length
      firstFact = facts[0]
      signal(hits, ctx)
    },
  })
  try {
    seedFact(memory, '冬天去看极光拍照片')
    seedFact(memory, '夏天去看极光带帐篷')
    await hook.fire(preStep('sess-a', '冬天去看极光'))
    assert.ok(firstFact !== undefined)
    assert.equal(factCount, 2, '两条 fact 都进了注入')
    const chain = emotionChain(emotionDbPath)
    assert.equal(chain.length, 1, '一次注入最多一条想起')
    const p = JSON.parse(chain[0].payload_json) as { refId: string; reason: string }
    assert.equal(p.refId, firstFact.id, '写的是注入序第一条 fact')
    assert.ok(p.reason.includes(firstFact.text), 'reason 截的是同一条的正文')
  } finally {
    injection.dispose()
    t.cleanup(memory, emotion)
  }
})

// ---------- S3 顾虑接线（真实账本 + 情绪库） ----------

interface ConcernRig {
  ledger: Ledger
  emotion: EmotionStore
  emotionDbPath: string
  fire: (payload: unknown, base?: Decision) => Promise<unknown>
  cleanup: () => void
}

function concernRig(prefix: string): ConcernRig {
  const t = makeTmp(prefix)
  const corePath = t.db('core.sqlite')
  initCoreDb(corePath)
  const ledger = Ledger.open(corePath)
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const hook = fakeHook()
  const mention = attachFailureMention(hook.ctx, { emotion, ledger, log: () => { /* 测试静音 */ } })
  return {
    ledger, emotion, emotionDbPath, fire: hook.fire,
    cleanup: () => { mention.dispose(); t.cleanup(ledger, emotion) },
  }
}

/** 建任务并连败 n 次（claimDone → ownerReject 循环）。返回最新快照。 */
function failTimes(ledger: Ledger, title: string, n: number): TaskSnapshot {
  let snap = ledger.create(OWNER, { title, objective: title, acceptance: { kind: 'owner-confirm' } })
  snap = ledger.activate(OWNER, { id: snap.id, revision: snap.revision })
  for (let i = 0; i < n; i++) {
    snap = ledger.claimDone(MODEL, { id: snap.id, revision: snap.revision })
    snap = ledger.ownerReject({ id: snap.id, revision: snap.revision }, `第 ${i + 1} 次驳回`)
  }
  return snap
}

test('ME9 连败 2 次的项目被提到 → 一条顾虑：actor/mood/reason/refId 逐项', async () => {
  const r = concernRig('prts-me-concern-')
  try {
    const task = failTimes(r.ledger, '核对归档目录', 2)
    const before = Date.now()
    const decision = await r.fire(preStep('sess-a', '归档目录核对完了吗')) as Decision
    assert.equal(decision.kind, 'enter')
    const chain = emotionChain(r.emotionDbPath)
    assert.equal(chain.length, 1)
    assert.deepEqual(JSON.parse(chain[0].actor_json), { kind: 'system', component: CONCERN_COMPONENT })
    const p = JSON.parse(chain[0].payload_json) as { valence: number; arousal: number; label: string; reason: string; refId: string }
    assert.equal(p.label, '顾虑')
    assert.equal(p.valence, CONCERN_MOOD.valence)
    assert.equal(p.arousal, CONCERN_MOOD.arousal)
    assert.equal(p.refId, task.id)
    assert.match(p.reason, /核对归档目录/)
    assert.match(p.reason, /连续失败 2 次/)
    assert.ok(chain[0].ts >= before && chain[0].ts <= Date.now())
  } finally {
    r.cleanup()
  }
})

test('ME10 1 次失败 / 先拒后收 → 不写（不够「反复」）', async () => {
  const r = concernRig('prts-me-notrepeat-')
  try {
    failTimes(r.ledger, '整理参考库', 1)
    let snap = failTimes(r.ledger, '备份照片', 2)
    snap = r.ledger.claimDone(MODEL, { id: snap.id, revision: snap.revision })
    r.ledger.ownerAccept({ id: snap.id, revision: snap.revision }) // 先拒后收 → trailing 0
    await r.fire(preStep('sess-a', '参考库整理好了吗'))
    await r.fire(preStep('sess-a', '照片备份完成了吗', 1))
    assert.equal(emotionChain(r.emotionDbPath).length, 0)
  } finally {
    r.cleanup()
  }
})

test('ME11 只共享 1 个 token 且不含全标题 → 不算提到', async () => {
  const r = concernRig('prts-me-onetoken-')
  try {
    failTimes(r.ledger, '核对归档目录', 2)
    await r.fire(preStep('sess-a', '核对一下账目'))
    assert.equal(emotionChain(r.emotionDbPath).length, 0)
  } finally {
    r.cleanup()
  }
})

test('ME12 无新结局再提不重写；新 failure 后再提 → 第二条', async () => {
  const r = concernRig('prts-me-rededup-')
  try {
    let snap = failTimes(r.ledger, '核对归档目录', 2)
    await r.fire(preStep('sess-a', '归档目录核对完了吗'))
    assert.equal(emotionChain(r.emotionDbPath).length, 1)
    await r.fire(preStep('sess-a', '归档目录核对完了吗', 1))
    assert.equal(emotionChain(r.emotionDbPath).length, 1, '无新结局不重复写')
    snap = r.ledger.claimDone(MODEL, { id: snap.id, revision: snap.revision })
    r.ledger.ownerReject({ id: snap.id, revision: snap.revision }, '第 3 次驳回')
    await r.fire(preStep('sess-a', '归档目录核对完了吗', 2))
    const chain = emotionChain(r.emotionDbPath)
    assert.equal(chain.length, 2, '新结局后再提再写')
    assert.match((JSON.parse(chain[1].payload_json) as { reason: string }).reason, /连续失败 3 次/)
  } finally {
    r.cleanup()
  }
})

test('ME13 短标题全包含兜底：2 字标题被提到也写', async () => {
  const r = concernRig('prts-me-shorttitle-')
  try {
    failTimes(r.ledger, '归档', 2)
    await r.fire(preStep('sess-a', '归档做完了吗'))
    assert.equal(emotionChain(r.emotionDbPath).length, 1)
  } finally {
    r.cleanup()
  }
})

// ---------- S4 失败隔离 ----------

test('ME14 情绪库关闭：想起回调不抛，注入正文照常进 messages', async () => {
  const r = recallRig('prts-me-swallow-')
  try {
    seedFact(r.memory, '冬天去看极光')
    r.emotion.close() // 制造写失败
    const decision = await r.fire(preStep('sess-a', '冬天去看极光')) as Decision
    assert.equal(decision.kind, 'enter')
    assert.match(JSON.stringify(decision.messages), /\[记忆检索\]/, '情绪失败不能丢注入')
  } finally {
    r.cleanup()
  }
})

test('ME15 账本读失败：顾虑 handler 原样返回 decision', async () => {
  const t = makeTmp('prts-me-ledgerboom-')
  const emotion = EmotionStore.open(t.db('emotion.sqlite'))
  try {
    const hook = fakeHook()
    const mention = attachFailureMention(hook.ctx, {
      emotion,
      ledger: {
        list: () => { throw new Error('ledger boom') },
        outcomeEvents: () => [],
      },
      log: () => { /* 测试静音 */ },
    })
    const base: Decision = { kind: 'enter', messages: [{ role: 'user', content: '原样' }] }
    const decision = await hook.fire(preStep('sess-a', '归档目录核对完了吗'), base)
    assert.deepEqual(decision, base, '检查失败不影响对话')
    mention.dispose()
  } finally {
    t.cleanup(emotion)
  }
})

// ---------- S5 同轮顺序 + S6 重建不变 ----------

test('ME16 同轮想起 + 顾虑：顾虑后写覆盖（外层注册在前）', async () => {
  const t = makeTmp('prts-me-order-')
  const memory = MemoryStore.open(t.db('memory.sqlite'))
  const corePath = t.db('core.sqlite')
  initCoreDb(corePath)
  const ledger = Ledger.open(corePath)
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const hook = fakeHook()
  // 注册顺序 = 生产装配顺序：顾虑外层在前，想起内层在后
  const mention = attachFailureMention(hook.ctx, { emotion, ledger, log: () => {} })
  const injection = attachMemoryInjection(hook.ctx, {
    store: memory,
    onHits: createMemoryRecallSignal({ emotion, log: () => {} }),
  })
  try {
    seedFact(memory, '冬天去看极光')
    failTimes(ledger, '核对极光装备', 2)
    await hook.fire(preStep('sess-a', '冬天去看极光装备核对'))
    const chain = emotionChain(emotionDbPath)
    assert.equal(chain.length, 2, '同轮两写')
    assert.equal((JSON.parse(chain[0].actor_json) as { component: string }).component, RECALL_COMPONENT)
    assert.equal((JSON.parse(chain[1].actor_json) as { component: string }).component, CONCERN_COMPONENT,
      '顾虑必须最后写（更具体者胜）')
    assert.equal(emotion.get()?.label, '顾虑')
  } finally {
    mention.dispose()
    injection.dispose()
    t.cleanup(memory, ledger, emotion)
  }
})

test('ME17 三库重建后链逐字节不变，两类去重仍生效', async () => {
  const t = makeTmp('prts-me-rebuild-')
  const memory = MemoryStore.open(t.db('memory.sqlite'))
  const corePath = t.db('core.sqlite')
  initCoreDb(corePath)
  const ledger = Ledger.open(corePath)
  const emotionDbPath = t.db('emotion.sqlite')
  const emotion = EmotionStore.open(emotionDbPath)
  const hook = fakeHook()
  const mention = attachFailureMention(hook.ctx, { emotion, ledger, log: () => {} })
  const injection = attachMemoryInjection(hook.ctx, {
    store: memory,
    onHits: createMemoryRecallSignal({ emotion, log: () => {} }),
  })
  try {
    seedFact(memory, '冬天去看极光')
    failTimes(ledger, '核对极光装备', 2)
    await hook.fire(preStep('sess-a', '冬天去看极光装备核对'))
    const before = JSON.stringify(emotionChain(emotionDbPath))
    assert.equal(JSON.parse(before).length, 2)

    memory.rebuildProjections()
    emotion.rebuildProjections()
    ledger.rebuildProjections()
    assert.equal(JSON.stringify(emotionChain(emotionDbPath)), before, '情绪链逐字节不变')
    assert.equal(memory.verifyChain().ok, true)
    assert.equal(emotion.verifyChain().ok, true)
    assert.equal(ledger.verifyChain().ok, true)

    // 重建后同查询再来一轮（新会话绕过注入层去重）：两类去重都仍生效
    await hook.fire(preStep('sess-z', '冬天去看极光装备核对'))
    assert.equal(emotionChain(emotionDbPath).length, 2, '重建后不写第三条')
  } finally {
    mention.dispose()
    injection.dispose()
    t.cleanup(memory, ledger, emotion)
  }
})