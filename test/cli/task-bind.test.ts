/**
 * `/task-bind <id>`：把**已有**的未结任务重新绑到当前会话。
 *
 * ## 为什么需要它
 *
 * 2026-11-09 真实中断实测：任务停在 `active`、绑定指向已死的 session，
 * 重启后 `describeOpenTasks` 会打印「未结任务 1 个……恢复执行请显式操作」，
 * 但**没有任何命令能接回来**——`/task-approve` 只处理 draft。
 * 结果就是「看得见、动不了」，阶段二的「恢复」这一半不成立。
 *
 * `Ledger.bindSession` 本身允许 `draft/active/paused/blocked` 四个相位
 * （`ledger.ts:471`），缺的只是一个 owner 入口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import { Ledger } from '../../src/ledger/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const OWNER = { kind: 'owner' as const }

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

function fakeCtx(agentId: string): Context {
  const agent = {
    status: 'idle',
    followup(): void { /* 宿主命令不触发模型 */ },
    session: { id: agentId, append(): void { /* bind 不写会话事件 */ } },
  }
  const agents = new Map([[agentId, agent]])
  return {
    get(name: string): unknown {
      if (name === 'agents') {
        return {
          list: () => [...agents.keys()].map((id) => ({ session: { id } })),
          get: (id: string) => agents.get(id),
          async create(): Promise<unknown> { return { agent, dispose: async (): Promise<void> => {} } },
        }
      }
      return undefined
    },
    on(): () => void { return (): void => {} },
  } as unknown as Context
}

/** 造一个 active 任务并绑定到另一个会话（模拟崩溃前的旧会话）。 */
function seed(dataRoot: string): { ledger: Ledger; taskId: string } {
  mkdirSync(dataRoot, { recursive: true })
  const dbPath = join(dataRoot, 'core.sqlite')
  initCoreDb(dbPath)
  const ledger = Ledger.open(dbPath)
  const created = ledger.create(OWNER, {
    title: '崩溃后要接回来的任务',
    objective: 'x',
    acceptance: { kind: 'owner-confirm' },
  })
  const active = ledger.activate(OWNER, { id: created.id, revision: created.revision })
  ledger.bindSession(OWNER, { id: active.id, revision: active.revision }, 'sess-old-dead')
  return { ledger, taskId: active.id }
}

async function chat(dataRoot: string, sessionId: string, ledger: Ledger, cmds: string[]): Promise<string> {
  const printed: string[] = []
  await runChat({
    ctx: fakeCtx(sessionId),
    lines: lines(...cmds, '/exit'),
    out: (s) => printed.push(s),
    cwd: dataRoot,
    dataRoot,
    ledger,
    sessionId,
  })
  return printed.join('')
}

test('TB1 /task-bind 把已有 active 任务接回当前会话', async () => {
  const t = makeTmp('prts-task-bind-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { ledger, taskId } = seed(dataRoot)
    try {
      assert.equal(ledger.taskForSession('sess-new'), undefined, '新会话一开始没有绑定')
      const text = await chat(dataRoot, 'sess-new', ledger, [`/task-bind ${taskId}`])
      assert.match(text, /接回|已绑定|bind/i, `应有绑定成功回执，实际：${text}`)

      const reader = Ledger.open(join(dataRoot, 'core.sqlite'))
      try {
        const bound = reader.taskForSession('sess-new')
        assert.equal(bound?.id, taskId, '新会话应能查到该任务')
        assert.equal(bound?.phase, 'active', '绑定不改相位——任务本来就在 active')
        assert.equal(reader.taskForSession('sess-old-dead'), undefined, '旧会话的绑定应被覆盖')
      } finally { reader.close() }
    } finally { ledger.close() }
  } finally { t.cleanup() }
})

test('TB2 /task-bind 未知 id：报错且不产生任何绑定', async () => {
  const t = makeTmp('prts-task-bind-')
  try {
    const dataRoot = join(t.dir, 'data')
    const { ledger } = seed(dataRoot)
    try {
      const text = await chat(dataRoot, 'sess-new', ledger, ['/task-bind task-doesnotexist'])
      assert.match(text, /失败|不存在|NOT_FOUND|not found/i, `应报未知任务，实际：${text}`)
      const reader = Ledger.open(join(dataRoot, 'core.sqlite'))
      try { assert.equal(reader.taskForSession('sess-new'), undefined) } finally { reader.close() }
    } finally { ledger.close() }
  } finally { t.cleanup() }
})
