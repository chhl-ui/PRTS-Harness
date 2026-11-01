import { test } from 'node:test'

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import { startRuntime } from '../../src/runtime/start.ts'
import { runTurn } from '../support/drive.ts'
import { scriptedLlmPlugin } from '../support/scripted-llm.ts'
import type { ScriptedStep } from '../support/scripted-llm.ts'
import { makeTmp } from '../support/tmp.ts'

/**
 * 接线级验证：单测只能证明 `maybeSpill` 的判定对，证明不了
 * 「`tools/post-execute` 在真实 cordis 里被调用、content 块被正确抽出、真的落了盘」。
 * 这里起真实 runtime，让脚本模型跑一条输出 4 万字符的 pwsh 命令，
 * 断言 spill 目录里出现了内容接近完整的文件。
 */

const WIN = process.platform === 'win32'
const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))
const disableLlm = [{ id: 'llm-deepseek', disabled: true }]

test('L3 config 的 maxOutputChars 200000 真的生效（不 patch 时）', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-spill-live3-')
  const spillRoot = join(t.dir, 'spill-root')
  process.env.PRTS_SPILL_MAX_INLINE_TOKENS = '100'
  process.env.PRTS_SPILL_ROOT = spillRoot
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    const dataRoot = join(t.dir, 'data')
    const workspace = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    // 不 patch persistent-pwsh：验证 config/prts.yml 的 200000 生效。
    // 10 万字符在默认 16000 下会被截到约 16200，在 200000 下应完整通过。
    app = await startRuntime({ configPath: prtsYml, dataRoot, workspace, mode: 'normal', patches: disableLlm })

    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'pwsh', arguments: { command: "[Console]::Out.Write('x' * 100000)" } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)

    await runTurn(app.ctx as Context, 'run the command', { cwd: workspace })

    const entries = readdirSync(spillRoot, { recursive: true, encoding: 'utf8' }) as string[]
    const spilled = entries.filter((f) => f.endsWith('.txt'))
    assert.ok(spilled.length >= 1, `spill 目录下没有结果文件，实际内容：${JSON.stringify(entries)}`)

    const content = readFileSync(join(spillRoot, spilled[0]), 'utf8')
    assert.ok(
      content.length >= 90000,
      `落盘只有 ${content.length} 字符；config 的 maxOutputChars: 200000 应让 10 万字符完整通过（默认 16000 只能拿到约 16200）`,
    )
  } finally {
    delete process.env.PRTS_SPILL_MAX_INLINE_TOKENS
    delete process.env.PRTS_SPILL_ROOT
    if (app) await app.dispose()
    t.cleanup()
  }
})

test('L2 调高 maxOutputChars 后 spill 存下完整输出（上限与卸载是一套组合）', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-spill-live2-')
  const spillRoot = join(t.dir, 'spill-root')
  process.env.PRTS_SPILL_MAX_INLINE_TOKENS = '100'
  process.env.PRTS_SPILL_ROOT = spillRoot
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    const dataRoot = join(t.dir, 'data')
    const workspace = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    // 把 pwsh 的输出上限从默认 16000 提到 100 万：验证「上游不截断 + spill 接管卸载」
    // 这套组合成立。单独调高上限是危险的——不配 spill 时 100 万字符会直接进上下文。
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace, mode: 'normal',
      patches: [...disableLlm, { id: 'persistent-pwsh', config: { maxOutputChars: 1_000_000 } }],
    })

    const script: ScriptedStep[] = [
      { toolCalls: [{ name: 'pwsh', arguments: { command: "[Console]::Out.Write('x' * 40000)" } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)

    await runTurn(app.ctx as Context, 'run the command', { cwd: workspace })

    const entries = readdirSync(spillRoot, { recursive: true, encoding: 'utf8' }) as string[]
    const spilled = entries.filter((f) => f.endsWith('.txt'))
    assert.ok(spilled.length >= 1, `spill 目录下没有结果文件，实际内容：${JSON.stringify(entries)}`)

    const content = readFileSync(join(spillRoot, spilled[0]), 'utf8')
    assert.ok(
      content.length >= 40000,
      `落盘 ${content.length} 字符；调高 maxOutputChars 到 100 万后应当拿到完整的 40000`,
    )
  } finally {
    delete process.env.PRTS_SPILL_MAX_INLINE_TOKENS
    delete process.env.PRTS_SPILL_ROOT
    if (app) await app.dispose()
    t.cleanup()
  }
})

test('L1 真实 runtime：超阈值工具结果落盘（钩子确实被调用）', { skip: !WIN, timeout: 180000 }, async () => {
  const t = makeTmp('prts-spill-live-')
  const spillRoot = join(t.dir, 'spill-root')
  // 阈值压低到 100 token（约 400 字符），让 4 万字符的输出必然触发卸载。
  process.env.PRTS_SPILL_MAX_INLINE_TOKENS = '100'
  process.env.PRTS_SPILL_ROOT = spillRoot
  let app: Awaited<ReturnType<typeof startRuntime>> | undefined
  try {
    const dataRoot = join(t.dir, 'data')
    const workspace = join(t.dir, 'ws')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(workspace, { recursive: true })

    // 显式固定上游上限为默认值 16000：这条测的是「上游先截断、spill 只能存到截断处」
    // 这个事实。config/prts.yml 现在配的是 200000，不显式固定就测不到这条。
    app = await startRuntime({
      configPath: prtsYml, dataRoot, workspace, mode: 'normal',
      patches: [...disableLlm, { id: 'persistent-pwsh', config: { maxOutputChars: 16_000 } }],
    })

    const script: ScriptedStep[] = [
      // 必须用 [Console]::Out.Write 而不是裸字符串输出：PowerShell 的格式化系统
      // 会把超长单行截断（实测 `$s='x'*40000; $s` 只回来 16244 字符），
      // 那样测的就不是 spill 而是 PowerShell 的表格宽度。
      { toolCalls: [{ name: 'pwsh', arguments: { command: "[Console]::Out.Write('x' * 40000)" } }] },
      { text: 'done' },
    ]
    scriptedLlmPlugin(script).apply(app.ctx as Context)

    await runTurn(app.ctx as Context, 'run the command', { cwd: workspace })

    assert.equal(existsSync(spillRoot), true, 'spill 根未创建——钩子没跑或没触发')

    const entries = readdirSync(spillRoot, { recursive: true, encoding: 'utf8' }) as string[]
    const spilled = entries.filter((f) => f.endsWith('.txt'))
    assert.ok(spilled.length >= 1, `spill 目录下没有结果文件，实际内容：${JSON.stringify(entries)}`)

    const content = readFileSync(join(spillRoot, spilled[0]), 'utf8')
    // 上游 pwsh 工具自己有 maxOutputChars 上限（dsh-tool-pwsh-persistent 的
    // maybeTruncate），实测 4 万字符会被截到 16000 + 一段截断提示。
    // 因此这里断言的是「spill 存下了上游交给它的全部内容」，而不是「存下了 4 万字符」：
    // 后者测的是 pwsh 的上限，不是 spill 的行为。
    assert.ok(content.length >= 16000, `落盘内容只有 ${content.length} 字符，疑似被 spill 二次截断`)
    assert.ok(content.startsWith('x'.repeat(1000)), '落盘内容应以原文开头，说明存的是完整副本而非 head/tail 片段')
  } finally {
    delete process.env.PRTS_SPILL_MAX_INLINE_TOKENS
    delete process.env.PRTS_SPILL_ROOT
    if (app) await app.dispose()
    t.cleanup()
  }
})
