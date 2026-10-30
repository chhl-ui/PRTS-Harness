import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IntegrityError } from './errors.ts'
import { treeHash } from './tree-hash.ts'

export interface ProtectedSpec {
  entries: { id: string; package: string }[]
  /** 相对 installRoot 的目录，如 'src/supervisor'、'src/core'。 */
  trees: { name: string; path: string }[]
}

export interface Manifest {
  format: 'prts-protected/1'
  entries: { id: string; package: string; version: string; treeSha256: string }[]
  trees: { name: string; path: string; treeSha256: string }[]
}

/** 包目录固定为 <installRoot>/node_modules/<pkg>，不用 require 解析。 */
export function generateManifest(installRoot: string, spec: ProtectedSpec): Manifest {
  const entries = spec.entries.map((e) => {
    const dir = join(installRoot, 'node_modules', ...e.package.split('/'))
    if (!existsSync(dir)) throw new IntegrityError('PACKAGE_MISSING', `${e.package} → ${dir}`)
    const pkgJson = join(dir, 'package.json')
    let version = ''
    try { version = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: string }).version ?? '' } catch {
      throw new IntegrityError('PACKAGE_MISSING', `${e.package}: package.json unreadable`)
    }
    return { id: e.id, package: e.package, version, treeSha256: treeHash(dir) }
  })
  const trees = spec.trees.map((t) => {
    const dir = join(installRoot, t.path)
    if (!existsSync(dir)) throw new IntegrityError('PACKAGE_MISSING', `${t.name} → ${dir}`)
    return { name: t.name, path: t.path, treeSha256: treeHash(dir) }
  })
  return { format: 'prts-protected/1', entries, trees }
}

export function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest
}
