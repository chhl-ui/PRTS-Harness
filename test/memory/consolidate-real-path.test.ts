/**
 * V1-06 的**真实链路**：对话 turn → 后台 consolidateFacts 提炼 → 重启后仍能检索。
 *
 * 为什么需要这条：`scripts/verify-v1-acceptance.mjs` 里的 V1-06 是直接调 `assertFact` 写的，
 * 绕过了「模型/后台从对话里提炼」这一步——机制层通过不等于用户说过的能被记住。
 *
 * 用 stub generator 而不是真实模型：这条测的是**链路是否接通**（turn 有没有进 prompt、
 * 解析结果有没有写成 fact、重启后检索还看不看得到），不是模型抽得准不准。
 * 但 stub 必须断言它收到了真实 turn 文本——否则「链路通过」只是自己骗自己。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { MemoryStore } from '../../src/memory/index.ts'
import { makeTmp } from '../support/tmp.ts'

const TOPICS = ['咖啡', '相机', '论文', '账本', '记忆', '人格', '情感', '检索', '沙箱', '审计']

test('V1-06 链路：10 条对话 turn → 提炼 → 重启后仍可检索（≥9）', async () => {
  const t = makeTmp('prts-consolidate-')
  try {
    const dbPath = join(t.dir, 'memory.sqlite')
    const m = MemoryStore.open(dbPath)
    for (let i = 0; i < TOPICS.length; i += 1) {
      m.recordTurn({
        actor: 'owner',
        sessionId: 's-1',
        turnIndex: i,
        speaker: '博士',
        text: `我告诉你一件事：${TOPICS[i]}方面，我偏好${TOPICS[i]}方案。`,
      })
    }

    const prompts: string[] = []
    const generator = {
      model: 'stub',
      generate: async (prompt: string): Promise<string> => {
        prompts.push(prompt)
        // 真实模型会输出 JSON；这里固定返回 10 条，形态与 parseFacts 期望一致
        return JSON.stringify(TOPICS.map((tp) => ({
          subject: tp,
          predicate: '偏好',
          object: `${tp}方案`,
          slot: tp,
          source_index: 0,
        })))
      },
    }

    const r = await m.consolidateFacts({ generator, limit: 20, batchSize: 20, actor: 'system' })
    assert.equal(r.added, 10, `应新增 10 条 fact，实际 added=${r.added} stop=${r.stop} extracted=${r.extracted}`)
    assert.equal(prompts.length > 0, true, 'generator 必须被调用')
    assert.match(prompts[0], /咖啡/, `prompt 必须含真实 turn 内容（否则链路没接通），前 200 字：${prompts[0].slice(0, 200)}`)

    // 提炼出来的 fact 是可检索的（不只是计数变了）
    const foundImmediately = TOPICS.filter((tp) =>
      m.search({ text: tp, limit: 5 }).some((h) => h.kind === 'fact')).length
    assert.ok(foundImmediately >= 9, `提炼后应立即可检索 ≥9，实际 ${foundImmediately}/10`)
    m.close()

    // 重启：新实例读同一个库
    const m2 = MemoryStore.open(dbPath)
    try {
      const foundAfterRestart = TOPICS.filter((tp) =>
        m2.search({ text: tp, limit: 5 }).some((h) => h.kind === 'fact')).length
      assert.ok(foundAfterRestart >= 9, `重启后应记得 ≥9 件，实际 ${foundAfterRestart}/10`)
    } finally {
      m2.close()
    }
  } finally {
    t.cleanup()
  }
})

test('V1-06 链路：提炼失败不污染库（parse 失败时 added=0）', async () => {
  const t = makeTmp('prts-consolidate-bad-')
  try {
    const m = MemoryStore.open(join(t.dir, 'memory.sqlite'))
    m.recordTurn({ actor: 'owner', sessionId: 's-1', turnIndex: 0, speaker: '博士', text: '随便说点什么。' })
    const before = m.countFacts()
    const r = await m.consolidateFacts({
      generator: { model: 'stub', generate: async () => '模型返回了一堆不是 JSON 的话' },
      limit: 10,
      batchSize: 10,
      actor: 'system',
    })
    assert.equal(r.added, 0, '解析失败不应新增 fact')
    assert.equal(m.countFacts(), before, '库内 fact 数不应变化')
    assert.ok(r.skipped > 0, '解析失败应计入 skipped，便于观测')
    m.close()
  } finally {
    t.cleanup()
  }
})
