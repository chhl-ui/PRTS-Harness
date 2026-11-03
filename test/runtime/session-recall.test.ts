/**
 * ⑦ 跨会话连续（S4）：新会话开场，从任务账本 + 意图库 + 近期情景重建
 * 「上次聊到哪里」，**不整体塞上一段聊天**。
 *
 * 依据 `docs/reference/PRTS-ARCHITECTURE-REQUIREMENTS-2026-10-29.md` §5.3 第 ⑦ 条；
 * 切片位置见 `docs/context-assembly-status.md` 第三节 S4。
 *
 * 四个数据源里**只做三个**：关系记忆属 V1-05（情感），`docs/design-memory-v1.md:58`
 * 已定「不做」。它留 `relationship` 接口位，不在这里实现。
 *
 * 与 `describeOpenTasks`（`src/cli/chat.ts`）的区别：那个打到终端给博士看，
 * 这个进模型上下文——同一份事实，两个读者。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Ledger } from '../../src/ledger/index.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { attachSessionRecall } from '../../src/runtime/session-recall.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Actor } from '../../src/ledger/index.ts'

const owner: Actor = { kind: 'owner' }

type Handler = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

function fakeHookCtx(): { ctx: { on(name: string, fn: Handler): () => void }; fire: Handler } {
  let handler: Handler | undefined
  return {
    ctx: {
      on(name: string, fn: Handler): () => void {
        if (name === 'agent/pre-step') handler = fn
        return () => { handler = undefined }
      },
    },
    fire: (payload, next) => {
      if (handler === undefined) throw new Error('未注册 agent/pre-step')
      return handler(payload, next)
    },
  }
}

const enter = (messages: unknown[]): { kind: 'enter'; messages: unknown[] } => ({ kind: 'enter', messages })

function payloadOf(sessionId: string) {
  return {
    agent: { session: { id: sessionId } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '今天做什么' }], source: { kind: 'user' } }],
    turn: 0,
    step: 0,
  }
}

/** 正文里取了哪条消息的文本——hook 层注入的是一条完整 user 消息。 */
function injectedText(messages: unknown[]): string {
  return messages
    .map((m) => {
      const msg = m as { content?: Array<{ type?: string; text?: string }> }
      return (msg.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    })
    .join('\n')
}

interface Ctx {
  dir: string
  ledger: Ledger
  store: MemoryStore
  cleanup(): void
}

function openCtx(): Ctx {
  const tmp = makeTmp('prts-session-recall-')
  const ledger = Ledger.open(join(tmp.dir, 'ledger.sqlite'))
  const store = MemoryStore.open(join(tmp.dir, 'memory.sqlite'))
  return { dir: tmp.dir, ledger, store, cleanup: () => tmp.cleanup(ledger, store) }
}

/** 重开同一组库（模拟进程重启：事件在链上，投影可重建）。 */
function reopen(ctx: Ctx): Ctx {
  const ledger = Ledger.open(join(ctx.dir, 'ledger.sqlite'))
  const store = MemoryStore.open(join(ctx.dir, 'memory.sqlite'))
  return { dir: ctx.dir, ledger, store, cleanup: () => tmp2Cleanup(ctx.dir, ledger, store) }
}

function tmp2Cleanup(dir: string, ledger: Ledger, store: MemoryStore): void {
  try { ledger.close() } catch { /* 已关闭 */ }
  try { store.close() } catch { /* 已关闭 */ }
}

const HOUR = 3_600_000

test('SR1 三个数据源都空 → 不产出正文（不注入空壳）', () => {
  const c = openCtx()
  try {
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      assert.equal(recall.runOnce('s-new'), '')
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR2 未结任务进正文：标题与「下一步」都要出现', () => {
  const c = openCtx()
  try {
    const created = c.ledger.create(owner, { title: '把光学设计跑通', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const active = c.ledger.activate(owner, { id: created.id, revision: created.revision })
    c.ledger.setResume(owner, { id: active.id, revision: active.revision }, { next: '跑集成测试', open: [] })

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('把光学设计跑通'), `缺任务标题：\n${text}`)
      assert.ok(text.includes('跑集成测试'), `缺下一步：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR3 已终结的任务（done / cancelled）不出现——它们不是「还没做完的事」', () => {
  const c = openCtx()
  try {
    // 真正的 `done` 必须走 `ownerAccept`：`claimDone` 只把 active 迁到 verifying
    // （`src/ledger/fold.ts:104-106`），那是「交上来等验收」，仍属未结——见 SR3b。
    const done = c.ledger.create(owner, { title: '已经做完的事', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const d1 = c.ledger.activate(owner, { id: done.id, revision: done.revision })
    const d2 = c.ledger.claimDone(owner, { id: d1.id, revision: d1.revision })
    c.ledger.ownerAccept({ id: d2.id, revision: d2.revision })
    const gone = c.ledger.create(owner, { title: '已经取消的事', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    c.ledger.cancel(owner, { id: gone.id, revision: gone.revision })

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(!text.includes('已经做完的事'), `done 不该出现：\n${text}`)
      assert.ok(!text.includes('已经取消的事'), `cancelled 不该出现：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR3b verifying（已交上来等验收）算未结，必须出现在开场里', () => {
  const c = openCtx()
  try {
    const t = c.ledger.create(owner, { title: '等博士点头的任务', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const a = c.ledger.activate(owner, { id: t.id, revision: t.revision })
    const claimed = c.ledger.claimDone(owner, { id: a.id, revision: a.revision })
    assert.equal(claimed.phase, 'verifying', '前提：claimDone 的落点是 verifying，不是 done')

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('等博士点头的任务'), `verifying 是「上次没做完的事」，不该被漏掉：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR4 待触发的意图进正文（action 原话要有）', () => {
  const c = openCtx()
  try {
    c.store.createIntent({
      actor: 'owner',
      conditionRaw: '周三',
      action: '复查构建产物',
      fireAtMs: Date.now() + 48 * HOUR,
    })
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('复查构建产物'), `缺意图动作：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR5 近期 turn 只取别的会话：当前会话的内容已经在上下文里', () => {
  const c = openCtx()
  try {
    const at = Date.now() - HOUR
    c.store.recordTurn({ actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user', text: '上个会话聊到向量索引重建', occurredAtMs: at })
    c.store.recordTurn({ actor: 'owner', sessionId: 's-now', turnIndex: 0, speaker: 'user', text: '当前会话正在说的话', occurredAtMs: at + 1000 })

    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-now')
      assert.ok(text.includes('向量索引重建'), `缺跨会话内容：\n${text}`)
      assert.ok(!text.includes('当前会话正在说的话'), `同会话内容不该重复注入：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR6 每个会话只注入一次：同一 sessionId 第二次返回空', () => {
  const c = openCtx()
  try {
    c.store.recordTurn({ actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user', text: '旧内容', occurredAtMs: Date.now() - HOUR })
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      assert.notEqual(recall.runOnce('s-a'), '')
      assert.equal(recall.runOnce('s-a'), '', '同一会话第二次不该再注入')
      assert.notEqual(recall.runOnce('s-b'), '', '换一个会话是新的开场')
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR7 正文自报来源：标明「上次聊到哪里」且「不是用户本轮发言」', () => {
  const c = openCtx()
  try {
    c.store.recordTurn({ actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user', text: '旧内容', occurredAtMs: Date.now() - HOUR })
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('上次聊到哪里'), `缺开场标记：\n${text}`)
      assert.ok(text.includes('不是用户本轮发言'), `缺来源声明：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR8 单个数据源抛错不拖垮其余：账本挂了仍能给出意图与近期对话', () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const brokenLedger = {
      list(): never { throw new Error('ledger 打不开') },
      steps(): never { throw new Error('ledger 打不开') },
    }
    const recall = attachSessionRecall(fakeHookCtx().ctx, {
      ledger: brokenLedger as unknown as Ledger,
      store: c.store,
    })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('交周报'), `意图段应仍然产出：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR9 hook 层：pre-step 追加一条 user 消息，来源自报不是本轮发言', async () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const h = fakeHookCtx()
    const recall = attachSessionRecall(h.ctx, { ledger: c.ledger, store: c.store })
    try {
      const decision = await h.fire(payloadOf('s-hook'), async () => enter([{ id: 'u1', role: 'user', content: [{ type: 'text', text: '今天做什么' }] }]))
      const d = decision as { kind: string; messages: unknown[] }
      assert.equal(d.kind, 'enter')
      assert.equal(d.messages.length, 2, '应当在原消息之后追加一条')
      const text = injectedText([d.messages[1]])
      assert.ok(text.includes('交周报'), `注入正文不对：\n${text}`)
      assert.ok(text.includes('不是用户本轮发言'))
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR10 hook 层：同一会话的第二轮不再追加', async () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const h = fakeHookCtx()
    const recall = attachSessionRecall(h.ctx, { ledger: c.ledger, store: c.store })
    try {
      const first = await h.fire(payloadOf('s-hook'), async () => enter([]))
      assert.equal((first as { messages: unknown[] }).messages.length, 1)
      const second = await h.fire(payloadOf('s-hook'), async () => enter([]))
      assert.equal((second as { messages: unknown[] }).messages.length, 0, '第二轮不该再注入')
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR11 maxTasks 截断：未结任务多时只列最近更新的几条', () => {
  const c = openCtx()
  try {
    for (const title of ['任务甲', '任务乙', '任务丙']) {
      const t = c.ledger.create(owner, { title, objective: 'O', acceptance: { kind: 'owner-confirm' } })
      c.ledger.activate(owner, { id: t.id, revision: t.revision })
    }
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: c.ledger, store: c.store, maxTasks: 1 })
    try {
      const text = recall.runOnce('s-new')
      const hits = ['任务甲', '任务乙', '任务丙'].filter((t) => text.includes(t))
      assert.equal(hits.length, 1, `应只列 1 条，实际 ${hits.length} 条：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})

test('SR12 重启后仍能重建：事件在链上，投影重开即得（S4 的验收原文）', () => {
  const c = openCtx()
  let second: Ctx | undefined
  try {
    const created = c.ledger.create(owner, { title: '重启前的任务', objective: 'O', acceptance: { kind: 'owner-confirm' } })
    const active = c.ledger.activate(owner, { id: created.id, revision: created.revision })
    c.ledger.setResume(owner, { id: active.id, revision: active.revision }, { next: '重启后接着跑', open: [] })
    c.store.recordTurn({ actor: 'owner', sessionId: 's-old', turnIndex: 0, speaker: 'user', text: '重启前的对话', occurredAtMs: Date.now() - HOUR })

    second = reopen(c)
    const recall = attachSessionRecall(fakeHookCtx().ctx, { ledger: second.ledger, store: second.store })
    try {
      const text = recall.runOnce('s-after-restart')
      assert.ok(text.includes('重启前的任务'), `重启后缺任务标题：\n${text}`)
      assert.ok(text.includes('重启后接着跑'), `重启后缺下一步：\n${text}`)
      assert.ok(text.includes('重启前的对话'), `重启后缺近期对话：\n${text}`)
    } finally { recall.dispose() }
  } finally {
    second?.cleanup()
    c.cleanup()
  }
})

test('SR13 不给 ledger 也能工作：意图与近期对话是独立数据源', () => {
  const c = openCtx()
  try {
    c.store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交周报', fireAtMs: Date.now() + HOUR })
    const recall = attachSessionRecall(fakeHookCtx().ctx, { store: c.store })
    try {
      const text = recall.runOnce('s-new')
      assert.ok(text.includes('交周报'), `缺意图段：\n${text}`)
    } finally { recall.dispose() }
  } finally { c.cleanup() }
})
