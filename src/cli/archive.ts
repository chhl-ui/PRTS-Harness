/**
 * V1-12 导出/导入（归档）。
 *
 * 验收原文：「导出后导入全新安装，记忆、人格设定和任务历史逐项核对一致。」
 *
 * 三个设计决定：
 *
 * 1. **`VACUUM INTO` 而不是复制文件**。SQLite 在 WAL 模式下，`-wal` 里可能还有未合并
 *    的页，直接 `copyFile` 会得到一个落后于真实状态的库——症状是「导入后少了几条最近的
 *    记忆」，而且不报错。`VACUUM INTO` 由 SQLite 自己保证副本一致。
 * 2. **sha256 钉住内容**。manifest 里记每个库副本的哈希，导入前逐个核对；
 *    归档在传输/存放期间被动过（哪怕是尾部追加一个字节）就拒绝，不拿坏数据覆盖真实记忆。
 * 3. **拒绝覆盖**。导出到非空目录、导入到已有库的位置，默认都拒绝——
 *    这两个方向都不可逆，宁可让调用方显式清场。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../memory/index.ts'

/** 归档格式版本。将来改结构时靠它拒绝旧归档，而不是让它在半懂不懂的状态下导进来。 */
const ARCHIVE_FORMAT = 1

/** 需要核对条数的表。缺表时不报错（不同版本装的库表不完全一样），记为 -1。 */
const MEMORY_TABLES = ['mem_turns', 'mem_facts', 'mem_intents', 'mem_profiles', 'mem_summaries', 'mem_vectors']
const CORE_TABLES = ['ledger_events', 'audit_events', 'tasks']

export interface ArchiveManifest {
  format: number
  exportedAtMs: number
  counts: Record<string, number>
  sha256: Record<string, string>
  chain: { memory: { ok: boolean; brokenAtSeq?: number }; core: { ok: boolean } }
}

export interface ExportResult {
  outDir: string
  counts: Record<string, number>
  sha256: Record<string, string>
}

export interface ImportResult {
  dataRoot: string
  counts: Record<string, number>
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

const countIn = (dbPath: string, table: string): number => {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c
  } catch {
    return -1
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * 用 SQLite 自己的 `VACUUM INTO` 生成一致副本。
 * 源库必须以读写方式打开——只读连接上 VACUUM 会被拒绝。
 */
const vacuumInto = (srcPath: string, destPath: string): void => {
  const db = new DatabaseSync(srcPath)
  try {
    // 路径里的单引号要翻倍转义，否则 Windows 用户名带引号时会语法错误。
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`)
  } finally { db.close() }
}

const isDirEmpty = (p: string): boolean => !existsSync(p) || readdirSync(p).length === 0

export function exportArchive(input: { dataRoot: string; outDir: string; force?: boolean }): ExportResult {
  const memorySrc = join(input.dataRoot, 'memory.sqlite')
  const coreSrc = join(input.dataRoot, 'core.sqlite')
  if (!existsSync(memorySrc) && !existsSync(coreSrc)) {
    throw new Error(`导出失败：${input.dataRoot} 下既没有 memory.sqlite 也没有 core.sqlite`)
  }
  if (!isDirEmpty(input.outDir)) {
    if (input.force !== true) {
      throw new Error(`导出失败：目标目录已存在且非空 ${input.outDir}（用 --force 覆盖其中的同名文件）`)
    }
  } else {
    mkdirSync(input.outDir, { recursive: true })
  }

  const counts: Record<string, number> = {}
  const sha256: Record<string, string> = {}
  let memoryChain: { ok: boolean; brokenAtSeq?: number } = { ok: true }

  if (existsSync(memorySrc)) {
    const dest = join(input.outDir, 'memory.sqlite')
    vacuumInto(memorySrc, dest)
    for (const t of MEMORY_TABLES) counts[t] = countIn(dest, t)
    // 链状态必须一起入档：导出时链就断了的话，导进去的是一份「投影可信、历史不可信」的数据。
    const store = MemoryStore.open(dest)
    try {
      const v = store.verifyChain()
      memoryChain = v.ok ? { ok: true } : { ok: false, brokenAtSeq: v.brokenAtSeq }
    } finally { store.close() }
    // 哈希必须取**最终**状态：上面的 open 是可写连接，SQLite 会在这时把 WAL
    // checkpoint 回主库，早算一步就会得到一个和落地文件对不上的哈希
    // （症状是导出自检通过、导入时 sha 校验失败）。
    sha256['memory.sqlite'] = sha256File(dest)
  }

  if (existsSync(coreSrc)) {
    const dest = join(input.outDir, 'core.sqlite')
    vacuumInto(coreSrc, dest)
    sha256['core.sqlite'] = sha256File(dest)
    for (const t of CORE_TABLES) counts[t] = countIn(dest, t)
  }

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    exportedAtMs: Date.now(),
    counts,
    sha256,
    chain: { memory: memoryChain, core: { ok: true } },
  }
  writeFileSync(join(input.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return { outDir: input.outDir, counts, sha256 }
}

export function importArchive(input: { archiveDir: string; dataRoot: string; force?: boolean }): ImportResult {
  const manifestPath = join(input.archiveDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`导入失败：${manifestPath} 不存在`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ArchiveManifest
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new Error(`导入失败：归档格式 ${String(manifest.format)} 与本版 ${ARCHIVE_FORMAT} 不兼容`)
  }

  // 先核对再落地：哈希不符时一个字节都不写，避免留下半份归档。
  for (const [name, expect] of Object.entries(manifest.sha256)) {
    const p = join(input.archiveDir, name)
    if (!existsSync(p)) throw new Error(`导入失败：归档缺少 ${name}`)
    const actual = sha256File(p)
    if (actual !== expect) {
      throw new Error(`导入失败：${name} 的 sha256 校验不通过（归档已损坏或被改动）`)
    }
  }

  // 目标库已存在就拒绝——覆盖真实记忆不可逆。
  for (const name of Object.keys(manifest.sha256)) {
    const dest = join(input.dataRoot, name)
    if (existsSync(dest) && input.force !== true) {
      throw new Error(`导入失败：${dest} 已存在（用 --force 覆盖，或换一个空的 dataRoot）`)
    }
  }

  mkdirSync(input.dataRoot, { recursive: true })
  for (const name of Object.keys(manifest.sha256)) {
    copyFileSync(join(input.archiveDir, name), join(input.dataRoot, name))
  }

  // 导入后逐项核对：条数对不上就是失败，不返回「大概成功」。
  const counts: Record<string, number> = {}
  const memoryDest = join(input.dataRoot, 'memory.sqlite')
  if (existsSync(memoryDest)) {
    for (const t of MEMORY_TABLES) {
      const got = countIn(memoryDest, t)
      counts[t] = got
      const want = manifest.counts[t]
      // `-1` = 导出时源库里没有这张表（旧版本装的库）。这种情况跳过核对：
      // 新库会把表建出来、计数为 0，与 -1 比会把一次正常迁移判成失败。
      if (want !== undefined && want >= 0 && want !== got) {
        throw new Error(`导入后核对失败：${t} 期望 ${want} 条，实际 ${got} 条`)
      }
    }
    const store = MemoryStore.open(memoryDest)
    try {
      const v = store.verifyChain()
      if (!v.ok) throw new Error(`导入后核对失败：事件链在第 ${String(v.brokenAtSeq)} 条断裂`)
    } finally { store.close() }
  }
  const coreDest = join(input.dataRoot, 'core.sqlite')
  if (existsSync(coreDest)) {
    for (const t of CORE_TABLES) {
      const got = countIn(coreDest, t)
      counts[t] = got
      const want = manifest.counts[t]
      // `-1` = 导出时源库里没有这张表（旧版本装的库）。这种情况跳过核对：
      // 新库会把表建出来、计数为 0，与 -1 比会把一次正常迁移判成失败。
      if (want !== undefined && want >= 0 && want !== got) {
        throw new Error(`导入后核对失败：${t} 期望 ${want} 条，实际 ${got} 条`)
      }
    }
  }
  return { dataRoot: input.dataRoot, counts }
}
