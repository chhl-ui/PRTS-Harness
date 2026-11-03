/** prts CLI：`node src/cli/prts.ts upgrade --install-root <d> --manifest <f> --db <f> --spec <f> [--init] [--yes]` */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { generateManifest } from '../integrity/manifest.ts'
import type { Manifest, ProtectedSpec } from '../integrity/manifest.ts'
import { IntegrityError } from '../integrity/errors.ts'
import { initCoreDb } from '../core/init.ts'
import { startupCheck } from '../core/startup-check.ts'
import { AuditLog } from '../audit/index.ts'
import { memoryCommand, memoryEmbedVectors, memoryExtractFacts } from './memory.ts'
import { exportArchive, importArchive } from './archive.ts'

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function sha256File(p: string): string | null {
  return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null
}

function hasManifestEvent(dbPath: string): boolean {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return (db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE kind='integrity.manifest-updated'`).get() as { c: number }).c > 0
  } catch {
    return false
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

interface Diff { added: string[]; removed: string[]; changed: string[] }

function diffManifests(oldM: Manifest | null, newM: Manifest): Diff {
  const d: Diff = { added: [], removed: [], changed: [] }
  const oldE = new Map((oldM?.entries ?? []).map((e) => [e.id, e]))
  const newE = new Map(newM.entries.map((e) => [e.id, e]))
  for (const [id, e] of newE) {
    const o = oldE.get(id)
    if (!o) d.added.push(`entry:${id}(${e.package})`)
    else if (o.version !== e.version || o.treeSha256 !== e.treeSha256 || o.package !== e.package) d.changed.push(`entry:${id}`)
  }
  for (const id of oldE.keys()) if (!newE.has(id)) d.removed.push(`entry:${id}`)
  const oldT = new Map((oldM?.trees ?? []).map((t) => [t.name, t]))
  const newT = new Map(newM.trees.map((t) => [t.name, t]))
  for (const [name, t] of newT) {
    const o = oldT.get(name)
    if (!o) d.added.push(`tree:${name}`)
    else if (o.treeSha256 !== t.treeSha256 || o.path !== t.path) d.changed.push(`tree:${name}`)
  }
  for (const name of oldT.keys()) if (!newT.has(name)) d.removed.push(`tree:${name}`)
  return d
}

function upgrade(args: string[]): number {
  const installRoot = arg(args, '--install-root')
  const manifestPath = arg(args, '--manifest')
  const dbPath = arg(args, '--db')
  const specPath = arg(args, '--spec')
  const init = args.includes('--init')
  const yes = args.includes('--yes')
  if (!installRoot || !manifestPath || !dbPath || !specPath) {
    console.error('usage: prts upgrade --install-root <dir> --manifest <file> --db <file> --spec <spec.json> [--init] [--yes]')
    return 2
  }
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ProtectedSpec
  const fresh = generateManifest(installRoot, spec) // PACKAGE_MISSING/LINK_IN_TREE 直接抛
  const oldHash = sha256File(manifestPath)
  const oldM = oldHash !== null ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest) : null
  const diff = diffManifests(oldM, fresh)

  const check = startupCheck(dbPath)
  if (check.mode === 'read-only') {
    console.error(`db is read-only: ${check.problems.join('; ')}`)
    return 3
  }
  if (init && (oldM !== null || hasManifestEvent(dbPath))) {
    console.error('--init only allowed when manifest file absent and chain has no manifest-updated event')
    return 3
  }

  for (const k of ['added', 'removed', 'changed'] as const) {
    for (const s of diff[k]) console.log(`${k}: ${s}`)
  }
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) console.log('no changes')
  if (!yes) { console.log('dry-run: pass --yes to write'); return 2 }

  initCoreDb(dbPath)
  mkdirSync(dirname(manifestPath), { recursive: true })
  const tmp = join(dirname(manifestPath), `.${Date.now()}-${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(fresh, null, 2))
  renameSync(tmp, manifestPath) // 原子覆盖
  const newHash = sha256File(manifestPath) as string
  const audit = AuditLog.open(dbPath)
  try {
    audit.append({ kind: 'owner' }, {
      kind: 'integrity.manifest-updated', oldSha256: oldHash, newSha256: newHash,
      added: diff.added, removed: diff.removed, changed: diff.changed,
    })
  } finally { audit.close() }
  console.log(`manifest written: ${newHash}`)
  return 0
}

/** V1-12 导出/导入：`prts archive <export|import> --data-root <d> ...`。 */
function archiveCommand(args: string[]): number {
  const sub = args[0]
  const dataRoot = arg(args, '--data-root')
  const force = args.includes('--force')
  if (dataRoot === undefined) {
    console.error('usage: prts archive export --data-root <d> --out <dir> [--force]')
    console.error('       prts archive import --data-root <d> --archive <dir> [--force]')
    return 2
  }
  // 人格来源：显式 --persona-path 优先，其次 PRTS_PERSONA_PATH；都没有则不导出人格。
  // 不猜 ~/.dsh 的位置——导错别人的人格比不导更糟。
  const personaPath = arg(args, '--persona-path') ?? process.env.PRTS_PERSONA_PATH
  const personaArg = personaPath === undefined ? {} : { personaPath }
  if (sub === 'export') {
    const out = arg(args, '--out')
    if (out === undefined) { console.error('usage: prts archive export --data-root <d> --out <dir> [--force] [--persona-path <f>]'); return 2 }
    const r = exportArchive({ dataRoot, outDir: out, force, ...personaArg })
    console.log(`exported to ${r.outDir}`)
    for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k}\t${v}`)
    console.log(r.persona === null
      ? '  persona\t未导出（没给 --persona-path 或 PRTS_PERSONA_PATH）'
      : `  persona\t${r.persona.bytes} bytes\t${r.persona.sourcePath}`)
    return 0
  }
  if (sub === 'import') {
    const from = arg(args, '--archive')
    if (from === undefined) { console.error('usage: prts archive import --data-root <d> --archive <dir> [--force] [--persona-path <f>] [--force-persona]'); return 2 }
    const r = importArchive({
      archiveDir: from, dataRoot, force, ...personaArg,
      ...(args.includes('--force-persona') ? { forcePersona: true } : {}),
    })
    console.log(`imported into ${r.dataRoot}（条数与事件链已逐项核对）`)
    for (const [k, v] of Object.entries(r.counts)) console.log(`  ${k}\t${v}`)
    console.log(r.persona === null
      ? '  persona\t归档里没有人格快照'
      : `  persona\t${r.persona.written ? '已写入' : '已存在且一致，未改动'}\t${r.persona.path}`)
    return 0
  }
  console.error('usage: prts archive <export|import> --data-root <d> ...')
  return 2
}

const args = process.argv.slice(2)
try {
  // 子命令分发：每个子命令返回退出码，process.exit 只在这一处调用。
  // 不用嵌套三元——两个以上分支时链式 if 更不容易读错。
  let code: number
  if (args[0] === 'upgrade') code = upgrade(args.slice(1))
  else if (args[0] === 'memory') {
    // `extract-facts` 要调模型（异步），与其余同步子命令分开走；
    // 两条路径都返回退出码，process.exit 仍只在本函数末尾调用一次。
    code = args[1] === 'extract-facts'
      ? await memoryExtractFacts(args.slice(1))
      : args[1] === 'embed'
        ? await memoryEmbedVectors(args.slice(1))
        : memoryCommand(args.slice(1))
  }
  else if (args[0] === 'archive') code = archiveCommand(args.slice(1))
  else {
    console.error('usage: prts upgrade ... | prts memory <stats|consolidate|retire|restore> ... | prts archive <export|import> ...')
    code = 2
  }
  process.exit(code)
} catch (e) {
  if (e instanceof IntegrityError) { console.error(`${e.code}: ${e.message}`); process.exit(3) }
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
