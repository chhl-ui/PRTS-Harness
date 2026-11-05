/**
 * config 声明了但解析不了的插件，必须在启动时说出来。
 *
 * 背景（2026-11-05 实测）：把 `dsh-token-meter` 写成不存在的包名，**系统照常启动**，
 * 只有依赖它的 `compaction-basic` 打一行 `pending (waiting for service: tokenMeter)`。
 * 功能安静地缺失，用户不会发现——这是最难查的一类配置错误。
 *
 * 为什么不默认阻断：`require.resolve` 对某些只导出 ESM 的包可能误报，而「误报导致起不来」
 * 比「少一个功能」更糟。所以默认只警告，`PRTS_STRICT_PLUGINS=1` 才升级为启动失败。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startRuntime } from '../../src/runtime/start.ts'

const CONFIG_SRC = 'config/prts.yml'

/** 在 config/ 目录内造一份改过的配置：DSH 以 config 所在目录为模块解析基准，
 *  放到 tmpdir 会让所有插件都解析不到（第一版 V1-01 就是这么误测的）。 */
function makeConfig(mutate: (text: string) => string): { path: string; dispose: () => void } {
  const path = `config/_probe-resolve-${process.pid}.yml`
  writeFileSync(path, mutate(readFileSync(CONFIG_SRC, 'utf8')))
  return { path, dispose: () => { try { rmSync(path) } catch { /* ignore */ } } }
}

const captureWarn = async (fn: () => Promise<void>): Promise<string> => {
  const lines: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(' ')) }
  try { await fn() } finally { console.warn = orig }
  return lines.join('\n')
}

test('P1 声明了不存在的插件时给出警告并指名（不阻断启动）', async () => {
  const cfg = makeConfig((t) => t.replace("name: '@deepseek-ai/dsh-token-meter'", "name: '@deepseek-ai/dsh-token-meter-NOT-EXIST'"))
  const dir = mkdtempSync(join(tmpdir(), 'prts-resolve-'))
  const prev = process.env.PRTS_STRICT_PLUGINS
  delete process.env.PRTS_STRICT_PLUGINS
  try {
    let app: Awaited<ReturnType<typeof startRuntime>> | undefined
    const warned = await captureWarn(async () => {
      app = await startRuntime({ configPath: cfg.path, dataRoot: dir, workspace: dir, mode: 'normal', credentials: { DEEPSEEK_API_KEY: 'x' } })
    })
    assert.match(warned, /token-meter-NOT-EXIST/, `警告里必须指名那个包，实际：${warned.slice(0, 200)}`)
    await app?.dispose()
  } finally {
    if (prev === undefined) delete process.env.PRTS_STRICT_PLUGINS
    else process.env.PRTS_STRICT_PLUGINS = prev
    cfg.dispose()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
  }
})

test('P2 PRTS_STRICT_PLUGINS=1 时升级为启动失败', async () => {
  const cfg = makeConfig((t) => t.replace("name: '@deepseek-ai/dsh-token-meter'", "name: '@deepseek-ai/dsh-token-meter-NOT-EXIST'"))
  const dir = mkdtempSync(join(tmpdir(), 'prts-resolve-'))
  process.env.PRTS_STRICT_PLUGINS = '1'
  try {
    await assert.rejects(
      () => startRuntime({ configPath: cfg.path, dataRoot: dir, workspace: dir, mode: 'normal', credentials: { DEEPSEEK_API_KEY: 'x' } }),
      /token-meter-NOT-EXIST/,
      '严格模式下必须以含包名的错误失败',
    )
  } finally {
    delete process.env.PRTS_STRICT_PLUGINS
    cfg.dispose()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})
