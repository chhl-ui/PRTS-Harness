import { raise } from './errors.ts'
import type { Capability } from './types.ts'

export type CapabilityKind = 'fs.read' | 'fs.write' | 'fs.delete' | 'net' | 'exec' | 'system' | 'tool'

export interface ParsedCapability {
  kind: CapabilityKind
  arg: string
}

const PREFIXES: { kind: CapabilityKind; prefix: string }[] = [
  { kind: 'fs.read', prefix: 'fs.read:' },
  { kind: 'fs.write', prefix: 'fs.write:' },
  { kind: 'fs.delete', prefix: 'fs.delete:' },
  { kind: 'net', prefix: 'net:' },
  { kind: 'exec', prefix: 'exec:' },
  { kind: 'system', prefix: 'system:' },
  { kind: 'tool', prefix: 'tool:' },
]

/** 外部不得手拼能力字符串，一律走这些构造函数。 */
export const cap = {
  fsRead: (absPath: string): Capability => `fs.read:${absPath}`,
  fsWrite: (absPath: string): Capability => `fs.write:${absPath}`,
  fsDelete: (absPath: string): Capability => `fs.delete:${absPath}`,
  net: (host: string): Capability => `net:${host}`,
  execShell: (): Capability => 'exec:shell',
  system: (what: string): Capability => `system:${what}`,
  tool: (name: string): Capability => `tool:${name}`,
} as const

export function parseCapability(c: Capability): ParsedCapability {
  if (typeof c !== 'string' || c === '') raise('INVALID_INPUT', 'capability must be a non-empty string')
  for (const { kind, prefix } of PREFIXES) {
    if (c.startsWith(prefix)) {
      const arg = c.slice(prefix.length)
      if (arg === '') raise('INVALID_INPUT', `capability arg empty: ${c}`)
      return { kind, arg }
    }
  }
  raise('INVALID_INPUT', `unknown capability: ${c}`)
}

/** capability 的规范串行化（用于审计 once 覆盖比较，集合语义）。 */
export function capabilityKey(c: Capability): string {
  const p = parseCapability(c)
  return `${p.kind}:${p.arg}`
}
