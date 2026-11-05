/**
 * V1-12 缺口：人格库（`persona.sqlite`）必须一起导出。
 *
 * 验收原文：「导出后导入全新安装，记忆、人格设定和任务历史**逐项核对一致**。」
 *
 * 现状缺口（2026-11-05）：`exportArchive` 搬了 `memory.sqlite`（记忆）、`core.sqlite`
 * （任务历史）和 DSH profile 的 `cordis.patch.yml`（人设文本快照），**唯独没有
 * `persona.sqlite`** ——而运行时的人格前缀实际取的是 `PersonaStore.renderPrefix()`
 * （`src/runtime/start.ts` 读它覆盖 DSH 的 personaPrefix）。也就是说：博士一旦
 * 用 `prts persona` 定义过预设，导出→全新安装就会丢人格，而归档自己的核对
 * 完全看不出这件事（它只核对它搬了的东西）。
 *
 * 当前真实数据根里 `persona.sqlite` 三张表都是 0 行，所以这个洞还没被踩到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { PersonaStore } from '../../src/persona/store.ts'
import { MemoryStore } from '../../src/memory/index.ts'
import { exportArchive, importArchive } from '../../src/cli/archive.ts'
import { makeTmp } from '../support/tmp.ts'

test('V12-P1 人格预设独立于 DSH profile：导出 → 全新 dataRoot 导入后仍然一致', () => {
  const t = makeTmp('prts-arch-persona-')
  try {
    const dataRoot = join(t.dir, 'data')
    mkdirSync(dataRoot, { recursive: true })

    // 记忆库（导出要求至少有一个库存在）
    const memory = MemoryStore.open(join(dataRoot, 'memory.sqlite'))
    try {
      memory.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '我住在杭州' })
    } finally { memory.close() }

    // 人格预设：定义 + 切到它
    const personaPath = join(dataRoot, 'persona.sqlite')
    const persona = PersonaStore.open(personaPath)
    try {
      persona.define({ kind: 'owner' }, { preset: 'prts', core: '你是 PRTS，罗德岛的终端系统。', style: '冷静、精确' })
      persona.switchTo({ kind: 'owner' }, 'prts')
      assert.equal(persona.activePreset(), 'prts', '前置：源库已激活预设')
    } finally { persona.close() }

    const outDir = join(t.dir, 'archive')
    exportArchive({ dataRoot, outDir })

    const newRoot = join(t.dir, 'fresh-install')
    importArchive({ archiveDir: outDir, dataRoot: newRoot })

    assert.ok(existsSync(join(newRoot, 'persona.sqlite')), '全新安装目录里必须有 persona.sqlite')
    const restored = PersonaStore.open(join(newRoot, 'persona.sqlite'))
    try {
      assert.equal(restored.activePreset(), 'prts', '激活中的预设必须一致')
      assert.equal(restored.get('prts')?.core, '你是 PRTS，罗德岛的终端系统。')
      assert.equal(restored.get('prts')?.style, '冷静、精确')
    } finally { restored.close() }
  } finally {
    t.cleanup()
  }
})
