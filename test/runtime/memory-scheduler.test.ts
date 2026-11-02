/**
 * 后台巩固调度（P1-3）。
 *
 * 钉住的行为：runOnce 一轮一个预算单位；生成器缺席只跳过模型阶段、规则照跑；
 * turn-stopping 事件经 idle 去抖后触发运行；dispose 停表、停跑、不抛错。
 * 全部在真实 MemoryStore 上跑——巩固写库的效果要能看到，不 mock 存储。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore, type TextGenerator } from '../../src/memory/index.ts'
import { attachMemoryScheduler, createOllamaProbe } from '../../src/runtime/memory-scheduler.ts'
import { makeTmp } from '../support/tmp.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeEvents(): { events: { on(n: string, f: (p: unknown) => void): () => void }; fire(p?: unknown): void; count(): number } {
  const fns: Array<(p: unknown) => void> = []
  return {
    events: {
      on(name: string, fn: (p: unknown) => void): () => void {
        if (name === 'agent/turn-stopping') fns.push(fn)
        return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1) }
      },
    },
    fire(p?: unknown) { for (const f of [...fns]) f(p) },
    count: () => fns.length,
  }
}

const factGen = (): TextGenerator => ({
  model: 'fake',
  async generate() {
    return JSON.stringify([{ subject: '博士', predicate: '饮品偏好', object: '美式', source_index: 0 }])
  },
})

test('SCH1 runOnce：规则巩固出实体，生成器在场时抽取事实', async () => {
  const t = makeTmp('prts-sch1-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'Sony A7C2 到货了' })
    const sch = attachMemoryScheduler({ store, generator: async () => factGen(), idleMs: 60_000 })
    try {
      await sch.runOnce()
      const st = sch.stats()
      assert.equal(st.runs, 1)
      assert.ok(st.rulesTurns >= 1, `规则巩固应处理 turn：${JSON.stringify(st)}`)
      assert.ok(st.factsAdded >= 1, `事实抽取应写库：${JSON.stringify(st)}`)
      assert.equal(st.modelSkips, 0)
      assert.ok(store.consolidationCursor() > 0, '规则游标应前进')
    } finally { sch.dispose() }
  } finally { t.cleanup(store) }
})

test('SCH2 生成器缺席：只跑规则巩固，modelSkips 计数', async () => {
  const t = makeTmp('prts-sch2-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'Godox V1 闪光灯' })
    const sch = attachMemoryScheduler({ store, generator: async () => undefined, idleMs: 60_000 })
    try {
      await sch.runOnce()
      const st = sch.stats()
      assert.ok(st.rulesTurns >= 1, '规则巩固不受模型缺席影响')
      assert.equal(st.factsTurns, 0)
      assert.equal(st.modelSkips, 1, '探活/生成器缺席要计数而不是报错')
      assert.equal(st.lastError, null)
    } finally { sch.dispose() }
  } finally { t.cleanup(store) }
})

test('SCH3 turn-stopping 触发：idle 去抖后自动跑一轮', async () => {
  const t = makeTmp('prts-sch3-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: 'Tamron 35-150 镜头' })
    const fake = fakeEvents()
    const sch = attachMemoryScheduler({ store, events: fake.events, idleMs: 30 })
    try {
      await sleep(150) // 启动 kick 先跑完
      const kickRuns = sch.stats().runs
      fake.fire()
      await sleep(150)
      const st = sch.stats()
      assert.ok(st.runs > kickRuns, `回合后的 idle 窗口应触发新一轮：kick=${kickRuns} now=${JSON.stringify(st)}`)
      assert.ok(st.rulesTurns >= 1)
    } finally { sch.dispose() }
    assert.equal(fake.count(), 0, 'dispose 应注销事件订阅')
  } finally { t.cleanup(store) }
})

test('SCH4 抽取抛错只记 lastError，不抛出、不影响后续轮次', async () => {
  const t = makeTmp('prts-sch4-'); const store = MemoryStore.open(t.db())
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '一些内容 Profoto B10' })
    const bad: TextGenerator = { model: 'bad', async generate() { throw new Error('ollama down') } }
    const sch = attachMemoryScheduler({ store, generator: async () => bad, idleMs: 60_000 })
    try {
      await sch.runOnce() // 不抛
      const st = sch.stats()
      assert.ok(st.lastError !== null, '模型层失败要留痕')
      assert.match(st.lastError!, /ollama down|consolidateFacts/i)
      assert.ok(st.rulesTurns >= 1, '模型层失败不影响规则巩固成果')
      // 下一轮还能再跑
      await sch.runOnce()
    } finally { sch.dispose() }
  } finally { t.cleanup(store) }
})

test('SCH5 Ollama 探活：不可达端口返回 false 且结果进缓存', async () => {
  let calls = 0
  const probe = createOllamaProbe({
    baseUrl: 'http://127.0.0.1:1', // 不可能有服务的端口
    timeoutMs: 500,
    fetchImpl: (async () => { calls++; throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
  })
  assert.equal(await probe(), false)
  assert.equal(await probe(), false)
  assert.equal(calls, 1, '缓存期内不重复探测')
})
