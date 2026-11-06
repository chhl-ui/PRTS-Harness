/**
 * `/persona` 命令的 CLI 级验收：查看当前预设、切到已有预设、拒绝未知预设。
 *
 * 为什么要有这条命令：人格预设存在 `persona.sqlite` 里（`start.ts:283` 打开），
 * 切换能力在库层已有（`PersonaStore.switchTo`，`store.ts:185`），但 chat 侧零入口——
 * `grep -c persona src/cli/chat.ts` 此前是 0。V1-03 盲评的前置就是「切回 prts 预设」，
 * 没有入口这一项就永远开不了工。
 *
 * 生效边界：`renderPrefix()` 只在 `start.ts:292` 启动时调一次，所以切换后必须重启
 * `prts chat`；命令输出必须明确告知，否则用户会以为切坏了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runChat } from '../../src/cli/chat.ts'
import { PersonaStore } from '../../src/persona/index.ts'
import { makeTmp } from '../support/tmp.ts'
import type { Context } from '@deepseek-ai/cordis'

const OWNER = { kind: 'owner' } as const

async function* lines(...xs: string[]): AsyncIterable<string> {
  for (const x of xs) yield x
}

interface FakeAgent {
  status: string
  followup(msg: unknown): void
  session: { id: string; append(type: string, data: unknown): void }
}

function makeAgent(id: string): FakeAgent {
  return {
    status: 'idle',
    followup(): void { /* 命令不应触发模型回合 */ },
    session: { id, append(): void { /* /persona 不写会话事件 */ } },
  }
}

function fakeCtx(agent: FakeAgent): Context {
  const agents = new Map([[agent.session.id, agent]])
  return {
    get(name: string): unknown {
      if (name === 'agents') {
        return {
          list: () => [...agents.keys()].map((id) => ({ session: { id } })),
          get: (id: string) => agents.get(id),
          async create(): Promise<unknown> {
            return { agent, dispose: async (): Promise<void> => {} }
          },
        }
      }
      return undefined
    },
    on(): () => void { return (): void => {} },
  } as unknown as Context
}

/** 在 tmp 数据根下建库并种两个预设，active 停在 priestess。 */
function seed(dataRoot: string): string {
  const dbPath = join(dataRoot, 'persona.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })
  const s = PersonaStore.open(dbPath)
  try {
    s.define(OWNER, { preset: 'prts', core: '你是 PRTS。' })
    s.define(OWNER, { preset: 'priestess', core: '你是普瑞赛斯。' })
    s.switchTo(OWNER, 'priestess')
  } finally { s.close() }
  return dbPath
}

function active(dbPath: string): string | undefined {
  const s = PersonaStore.open(dbPath)
  try { return s.activePreset() } finally { s.close() }
}

test('P1 无参 /persona：显示当前预设与用法', async () => {
  const t = makeTmp('prts-persona-1-')
  try {
    const dataRoot = join(t.dir, 'data')
    seed(dataRoot)
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx(makeAgent('sess-a')),
      lines: lines('/persona', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'sess-a',
    })
    const text = printed.join('')
    assert.match(text, /priestess/, `应显示当前预设，实际：${text}`)
    assert.match(text, /\/persona/, `应给出用法，实际：${text}`)
  } finally { t.cleanup() }
})

test('P2 /persona prts：切到已有预设，并明确提示重启才生效', async () => {
  const t = makeTmp('prts-persona-2-')
  try {
    const dataRoot = join(t.dir, 'data')
    const dbPath = seed(dataRoot)
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx(makeAgent('sess-a')),
      lines: lines('/persona prts', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'sess-a',
    })
    assert.equal(active(dbPath), 'prts', '库里的 active 应已切换')
    const text = printed.join('')
    assert.match(text, /已切到|prts/, `应有切换确认，实际：${text}`)
    assert.match(text, /重启/, `必须提示重启才生效（renderPrefix 只在启动时读），实际：${text}`)
  } finally { t.cleanup() }
})

test('P3 /persona 未知预设：报错且 active 不变', async () => {
  const t = makeTmp('prts-persona-3-')
  try {
    const dataRoot = join(t.dir, 'data')
    const dbPath = seed(dataRoot)
    const printed: string[] = []
    await runChat({
      ctx: fakeCtx(makeAgent('sess-a')),
      lines: lines('/persona nobody', '/exit'),
      out: (s) => printed.push(s),
      cwd: t.dir,
      dataRoot,
      sessionId: 'sess-a',
    })
    assert.equal(active(dbPath), 'priestess', '未知预设不得改动 active')
    assert.match(printed.join(''), /nobody|不存在|NOT_FOUND/, '应报出未知预设')
  } finally { t.cleanup() }
})
