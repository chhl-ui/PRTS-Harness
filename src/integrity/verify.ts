import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IntegrityError } from './errors.ts'
import type { IntegrityCode } from './errors.ts'
import type { Manifest } from './manifest.ts'
import { treeHash } from './tree-hash.ts'

export interface ComposedEntry { id: string; name: string; disabled?: unknown }

type Failure = { code: IntegrityCode; detail: string }

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

/** 审计链中最新一条 integrity.manifest-updated 的 newSha256；无连接/无事件 → null。 */
function anchoredSha(dbPath: string): string | null {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare(
      `SELECT payload_json FROM audit_events WHERE kind = 'integrity.manifest-updated' ORDER BY seq DESC LIMIT 1`,
    ).get() as { payload_json: string } | undefined
    if (!row) return null
    const p = JSON.parse(row.payload_json) as { newSha256?: string }
    return typeof p.newSha256 === 'string' ? p.newSha256 : null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

export function verifyIntegrity(o: {
  installRoot: string
  manifestPath: string
  dbPath: string
  entries: ComposedEntry[]
}): { ok: true; manifestSha256: string } | { ok: false; failures: Failure[] } {
  const failures: Failure[] = []
  const push = (code: IntegrityCode, detail: string) => failures.push({ code, detail })

  // 1) 清单锚定：文件 sha256 必须与链上最新 manifest-updated.newSha256 一致
  let manifest: Manifest | null = null
  const fileHash = existsSync(o.manifestPath) ? sha256File(o.manifestPath) : null
  const anchored = anchoredSha(o.dbPath)
  if (fileHash === null || anchored === null || fileHash !== anchored) {
    push('MANIFEST_UNANCHORED', `${o.manifestPath} (file=${fileHash ?? 'missing'}, chain=${anchored ?? 'none'})`)
  } else {
    try { manifest = JSON.parse(readFileSync(o.manifestPath, 'utf8')) as Manifest } catch {
      push('MANIFEST_UNANCHORED', `${o.manifestPath}: unparseable`)
    }
  }
  if (!manifest) return { ok: false, failures }

  const protectedIds = new Set(manifest.entries.map((e) => e.id))
  const protectedPkgs = new Map(manifest.entries.map((e) => [e.package, e.id]))

  // 2) 条目侧检查
  const byId = new Map(o.entries.map((e) => [e.id, e]))
  for (const me of manifest.entries) {
    const ent = byId.get(me.id)
    if (!ent) { push('ENTRY_MISSING', me.id); continue }
    if (ent.name !== me.package) push('ENTRY_NAME_MISMATCH', `${me.id}: name=${ent.name} != ${me.package}`)
    if (ent.disabled === true) push('ENTRY_DISABLED', me.id)
    else if (ent.disabled !== undefined && ent.disabled !== false) {
      push('ENTRY_DYNAMIC_DISABLED', `${me.id}: disabled=${JSON.stringify(ent.disabled)}`)
    }
  }
  for (const ent of o.entries) {
    if (protectedIds.has(ent.id)) continue
    if (protectedPkgs.has(ent.name)) {
      push('PROTECTED_PACKAGE_DUPLICATED', `${ent.id} loads protected package ${ent.name}`)
    }
  }

  // 3) 包版本 + 树哈希（即使上面已有失败也继续收齐）
  for (const me of manifest.entries) {
    const dir = join(o.installRoot, 'node_modules', ...me.package.split('/'))
    if (!existsSync(dir)) { push('PACKAGE_MISSING', me.package); continue }
    let ver = ''
    try { ver = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? '' } catch {
      push('PACKAGE_MISSING', me.package); continue
    }
    if (ver !== me.version) push('VERSION_MISMATCH', `${me.package}: ${ver} != ${me.version}`)
    try {
      if (treeHash(dir) !== me.treeSha256) push('TREE_MISMATCH', me.package)
    } catch (e) {
      if (e instanceof IntegrityError) push(e.code, e.message)
      else throw e
    }
  }
  for (const mt of manifest.trees) {
    const dir = join(o.installRoot, mt.path)
    if (!existsSync(dir)) { push('PACKAGE_MISSING', mt.name); continue }
    try {
      if (treeHash(dir) !== mt.treeSha256) push('TREE_MISMATCH', mt.name)
    } catch (e) {
      if (e instanceof IntegrityError) push(e.code, e.message)
      else throw e
    }
  }

  return failures.length === 0 ? { ok: true, manifestSha256: fileHash! } : { ok: false, failures }
}
