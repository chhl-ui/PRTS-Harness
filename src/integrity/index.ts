/** K5 启动完整性：清单树哈希 + 审计链锚定 + 组合条目校验。 */
export { IntegrityError } from './errors.ts'
export type { IntegrityCode } from './errors.ts'
export { treeHash } from './tree-hash.ts'
export { generateManifest, readManifest } from './manifest.ts'
export type { ProtectedSpec, Manifest } from './manifest.ts'
export { verifyIntegrity } from './verify.ts'
export type { ComposedEntry } from './verify.ts'
