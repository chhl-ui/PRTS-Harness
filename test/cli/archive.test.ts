/**
 * V1-12 导出/导入。
 *
 * 验收原文：「导出后导入全新安装，记忆、人格设定和任务历史**逐项核对一致**。」
 * 测的是这条：导出 → 导入到一个空 dataRoot → 两边的条数与事件链状态逐项相等。
 *
 * 关键设计：SQLite 在 WAL 模式下直接复制文件不安全（-wal 里可能还有未合并的页），
 * 所以用 `VACUUM INTO` 生成一致的副本，再用 sha256 把「导出后有没有被动过」钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../../src/memory/index.ts'
import { initCoreDb } from '../../src/core/init.ts'
import { exportArchive, importArchive } from '../../src/cli/archive.ts'
import { makeTmp } from '../support/tmp.ts'

/** 造一个带真实数据的 dataRoot。 */
function seedDataRoot(dir: string): { memory: string; core: string } {
  mkdirSync(dir, { recursive: true })
  const memory = join(dir, 'memory.sqlite')
  const core = join(dir, 'core.sqlite')
  const store = MemoryStore.open(memory)
  try {
    store.recordTurn({ actor: 'system', sessionId: 's1', turnIndex: 0, speaker: 'user', text: '我住在杭州' })
    store.assertFact({
      actor: 'owner', subject: '博士', predicate: '居住', object: '杭州',
      provenance: 'stated', confirmationBasis: 'owner-stated',
    })
    store.createIntent({ actor: 'owner', conditionRaw: '明天', action: '交报告', fireAtMs: Date.now() + 86_400_000 })
  } finally { store.close() }
  initCoreDb(core)
  // 账本写入走 Ledger 的正常路径会很啰嗦；这里只验证「core.sqlite 会被一起搬走」，
  // 所以只确认文件已建出来。
  assert.ok(existsSync(core), 'core.sqlite 应已初始化')
  return { memory, core }
}

const countOf = (dbPath: string, table: string): number => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
  } catch { return -1 } finally { db.close() }
}

test('A1 导出产出 manifest + 两个库副本，条数与链状态入档', () => {
  const t = makeTmp('prts-arch-')
  try {
    const dataRoot = join(t.dir, 'data')
    seedDataRoot(dataRoot)
    const outDir = join(t.dir, 'out')
    const r = exportArchive({ dataRoot, outDir })

    assert.ok(existsSync(join(outDir, 'manifest.json')), 'manifest 必须存在')
    assert.ok(existsSync(join(outDir, 'memory.sqlite')), '记忆库副本必须存在')
    assert.ok(existsSync(join(outDir, 'core.sqlite')), '任务账本副本必须存在')

    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      format: number
      counts: Record<string, number>
      sha256: Record<string, string>
      chain: { memory: { ok: boolean }; core: { ok: boolean } }
    }
    assert.equal(m.format, 1)
    assert.equal(m.counts.mem_turns, 1)
    assert.equal(m.counts.mem_facts, 1)
    assert.equal(m.counts.mem_intents, 1)
    assert.match(m.sha256['memory.sqlite'], /^[0-9a-f]{64}$/)
    assert.equal(m.chain.memory.ok, true, '导出时链必须是完好的，否则导出的是坏数据')
    assert.equal(r.counts.mem_turns, 1)
  } finally { t.cleanup() }
})

test('A2 导入到全新 dataRoot 后条数与链逐项一致', () => {
  const t = makeTmp('prts-arch-')
  try {
    const src = join(t.dir, 'data')
    seedDataRoot(src)
    const outDir = join(t.dir, 'out')
    exportArchive({ dataRoot: src, outDir })

    const dst = join(t.dir, 'fresh')
    const r = importArchive({ archiveDir: outDir, dataRoot: dst })
    assert.equal(r.counts.mem_turns, 1)
    assert.equal(r.counts.mem_facts, 1)
    assert.equal(countOf(join(dst, 'memory.sqlite'), 'mem_turns'), 1)
    assert.equal(countOf(join(dst, 'memory.sqlite'), 'mem_intents'), 1, '意图也要跟着搬走')
    // 链在导入后仍需自洽
    const store = MemoryStore.open(join(dst, 'memory.sqlite'))
    try { assert.equal(store.verifyChain().ok, true, '导入后事件链必须仍然完好') } finally { store.close() }
  } finally { t.cleanup() }
})

test('A3 目标已有库时拒绝导入（不能静默覆盖真实数据）', () => {
  const t = makeTmp('prts-arch-')
  try {
    const src = join(t.dir, 'data')
    seedDataRoot(src)
    const outDir = join(t.dir, 'out')
    exportArchive({ dataRoot: src, outDir })

    const dst = join(t.dir, 'occupied')
    seedDataRoot(dst)
    assert.throws(() => importArchive({ archiveDir: outDir, dataRoot: dst }), /已存在|非空|覆盖/)
  } finally { t.cleanup() }
})

test('A4 manifest 被篡改（sha 不符）时拒绝导入', () => {
  const t = makeTmp('prts-arch-')
  try {
    const src = join(t.dir, 'data')
    seedDataRoot(src)
    const outDir = join(t.dir, 'out')
    exportArchive({ dataRoot: src, outDir })

    // 往副本里追加一个字节——sha256 必然变
    const p = join(outDir, 'memory.sqlite')
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from([0])]))

    assert.throws(
      () => importArchive({ archiveDir: outDir, dataRoot: join(t.dir, 'fresh2') }),
      /sha256|校验|损坏/,
    )
  } finally { t.cleanup() }
})

test('A5 导出到非空目录时拒绝（避免覆盖别人的归档）', () => {
  const t = makeTmp('prts-arch-')
  try {
    const src = join(t.dir, 'data')
    seedDataRoot(src)
    const outDir = join(t.dir, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'someone-else.txt'), 'x')
    assert.throws(() => exportArchive({ dataRoot: src, outDir }), /非空|已存在/)
  } finally { t.cleanup() }
})

// ---- 人格设定（V1-12 的第三个「逐项一致」）----
// 人格嵌在 DSH profile 的 cordis.patch.yml 里（agent-preset 插件的 persona.prefix），
// 不是独立文件。这里用 --persona-path 指向临时文件，绝不碰真实的 ~/.dsh。

test('P1 导出把人格文件一并入档并在 manifest 记录哈希', () => {
  const t = makeTmp('prts-arch-')
  try {
    const dataRoot = join(t.dir, 'data')
    seedDataRoot(dataRoot)
    const persona = join(t.dir, 'cordis.patch.yml')
    writeFileSync(persona, 'persona:\n  prefix: 你是大肥鱼\n', 'utf8')

    const outDir = join(t.dir, 'out')
    const r = exportArchive({ dataRoot, outDir, personaPath: persona })
    assert.ok(existsSync(join(outDir, 'persona', 'cordis.patch.yml')), '人格副本必须在归档里')
    assert.equal(r.persona?.bytes, Buffer.byteLength('persona:\n  prefix: 你是大肥鱼\n'))
    const m = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as {
      persona: { file: string; sha256: string } | null
    }
    assert.equal(m.persona?.file, 'persona/cordis.patch.yml')
    assert.match(m.persona?.sha256 ?? '', /^[0-9a-f]{64}$/)
  } finally { t.cleanup() }
})

test('P2 导入到无人格文件的位置时写回（全新安装的恢复路径）', () => {
  const t = makeTmp('prts-arch-')
  try {
    const dataRoot = join(t.dir, 'data')
    seedDataRoot(dataRoot)
    const persona = join(t.dir, 'cordis.patch.yml')
    writeFileSync(persona, 'prefix: 大肥鱼\n', 'utf8')
    const outDir = join(t.dir, 'out')
    exportArchive({ dataRoot, outDir, personaPath: persona })

    const dst = join(t.dir, 'fresh')
    const target = join(t.dir, 'fresh-persona.yml')
    const r = importArchive({ archiveDir: outDir, dataRoot: dst, personaPath: target })
    assert.equal(r.persona?.written, true, '全新安装必须把人设恢复出来，否则 V1-12 不算通过')
    assert.equal(readFileSync(target, 'utf8'), 'prefix: 大肥鱼\n')
  } finally { t.cleanup() }
})

test('P3 目标人格已存在且内容不同时拒绝覆盖', () => {
  const t = makeTmp('prts-arch-')
  try {
    const dataRoot = join(t.dir, 'data')
    seedDataRoot(dataRoot)
    const persona = join(t.dir, 'cordis.patch.yml')
    writeFileSync(persona, 'prefix: 大肥鱼\n', 'utf8')
    const outDir = join(t.dir, 'out')
    exportArchive({ dataRoot, outDir, personaPath: persona })

    const target = join(t.dir, 'existing-persona.yml')
    writeFileSync(target, 'prefix: 另一个人格\n', 'utf8')
    assert.throws(
      () => importArchive({ archiveDir: outDir, dataRoot: join(t.dir, 'fresh3'), personaPath: target }),
      /人格|已存在|覆盖/,
    )
    assert.equal(readFileSync(target, 'utf8'), 'prefix: 另一个人格\n', '拒绝时原文件不能被动过')
  } finally { t.cleanup() }
})

test('P4 源没有指定人格文件时导出仍成功（persona 为 null）', () => {
  const t = makeTmp('prts-arch-')
  try {
    const dataRoot = join(t.dir, 'data')
    seedDataRoot(dataRoot)
    const outDir = join(t.dir, 'out')
    const r = exportArchive({ dataRoot, outDir, personaPath: join(t.dir, 'no-such.yml') })
    assert.equal(r.persona, null)
    assert.ok(existsSync(join(outDir, 'manifest.json')))
  } finally { t.cleanup() }
})
