/**
 * 人格生效边界的**字节级验收**（PB1—PB3）。
 *
 * 边界声明（`chat.ts:938` 的注释、`start.ts:311` 的实现）：
 * `PersonaStore.renderPrefix()` 只在 `startRuntime` 启动时被调用**一次**，
 * 结果作为 `bootPatches` 的 `system-prompt.personaPrefix` 交给 DSH 装配。
 * 因此：
 *   - 启动时装配的是**当时 active 的预设**；
 *   - 运行中切换预设**不改变**当前进程的装配（不热更新）；
 *   - 重启后装配才换成新 active。
 *
 * 这里不用「看代码确认」代替验证：直接调 DSH 的 `systemPrompt.assemble()`
 * 取真实的装配结果，对字节断言。观测信号 = 装配文本里有没有某预设独有的句子。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRuntime } from '../../src/runtime/start.ts'
import { PersonaStore } from '../../src/persona/index.ts'
import { makeTmp } from '../support/tmp.ts'

const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const OWNER = { kind: 'owner' } as const

/** 两个预设各带一句独有的句子——装配里出现哪句就证明用的是哪个预设。 */
const PRTS_CORE = '你是 PRTS，罗德岛的终端系统。'
const PRTS_STYLE = '先给结论，再给依据。'
const PRIESTESS_CORE = '你是普瑞赛斯，前文明最后一位人类科学家。'

function seedPersona(dataRoot: string): void {
  const store = PersonaStore.open(join(dataRoot, 'persona.sqlite'))
  try {
    store.define(OWNER, { preset: 'prts', core: PRTS_CORE, style: PRTS_STYLE })
    store.define(OWNER, { preset: 'priestess', core: PRIESTESS_CORE, style: '' })
    store.switchTo(OWNER, 'priestess')
  } finally {
    store.close()
  }
}

function switchActive(dataRoot: string, preset: string): void {
  const store = PersonaStore.open(join(dataRoot, 'persona.sqlite'))
  try {
    store.switchTo(OWNER, preset)
  } finally {
    store.close()
  }
}

/** 取当前 runtime 真实装配的 system prompt 全文（字节级）。 */
async function assembleText(app: Awaited<ReturnType<typeof startRuntime>>): Promise<string> {
  const sp = app.ctx.get('systemPrompt') as { assemble?: () => Promise<unknown> } | undefined
  assert.ok(sp?.assemble !== undefined, 'systemPrompt 服务必须可用')
  return JSON.stringify(await sp.assemble())
}

async function boot(dataRoot: string, ws: string) {
  return startRuntime({
    configPath: prtsYml, dataRoot, workspace: ws, mode: 'normal',
    patches: [{ id: 'llm-deepseek', disabled: true }],
  })
}

test('PB1 启动装配 = 当时 active 的预设（priestess），不含另一预设的独有句子', async () => {
  const tmp = makeTmp('prts-persona-boundary-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  seedPersona(dataRoot)

  const app = await boot(dataRoot, ws)
  try {
    const text = await assembleText(app)
    assert.ok(text.includes(PRIESTESS_CORE), '装配必须含 active 预设（priestess）的 core')
    assert.ok(!text.includes(PRTS_STYLE), '非 active 预设的 style 不得出现在装配里')
  } finally {
    await app.dispose()
    tmp.cleanup()
  }
})

test('PB2 运行中切换预设不热更新：同一 runtime 的装配逐字节不变', async () => {
  const tmp = makeTmp('prts-persona-boundary-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  seedPersona(dataRoot)

  const app = await boot(dataRoot, ws)
  try {
    const before = await assembleText(app)
    assert.ok(before.includes(PRIESTESS_CORE))

    // 另一个连接把 active 切成 prts（模拟 /persona prts）。
    switchActive(dataRoot, 'prts')

    const after = await assembleText(app)
    assert.equal(after, before, '运行中切换不得改变当前进程的装配（启动快照）')
    assert.ok(!after.includes(PRTS_STYLE), '新预设的 style 不该在旧进程里生效')
  } finally {
    await app.dispose()
    tmp.cleanup()
  }
})

test('PB3 重启后装配 = 新 active（prts），含其 style、不含旧预设', async () => {
  const tmp = makeTmp('prts-persona-boundary-')
  const dataRoot = join(tmp.dir, 'data')
  const ws = join(tmp.dir, 'ws')
  mkdirSync(dataRoot, { recursive: true })
  mkdirSync(ws, { recursive: true })
  seedPersona(dataRoot)

  const first = await boot(dataRoot, ws)
  await first.dispose()
  switchActive(dataRoot, 'prts')

  const second = await boot(dataRoot, ws)
  try {
    const text = await assembleText(second)
    assert.ok(text.includes(PRTS_CORE), '重启后装配必须换成新 active（prts）')
    assert.ok(text.includes(PRTS_STYLE), 'prts 的 style 必须进装配')
    assert.ok(!text.includes(PRIESTESS_CORE), '旧预设的内容不得残留')
  } finally {
    await second.dispose()
    tmp.cleanup()
  }
})
