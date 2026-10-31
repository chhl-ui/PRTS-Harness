/**
 * API key 的来源解析：凭据管理器 → 环境变量 → 文件。
 *
 * 设计目标是让明文 key 尽量不落盘——磁盘文件是模型 shell 用 `Get-Content`
 * 就能直接读走的唯一位置（沙箱只限写、不限读，见 `PRTS-INDEX.md` §5）。
 *
 * 三个来源的门槛从高到低：
 *  - `credential`：Windows Credential Manager，DPAPI 保护，磁盘上无明文；
 *    要提取必须写代码调 `CredRead`，不能 `type` 一下就读走
 *  - `env`：读到后立刻从本进程环境删除，否则派生的子进程会继承
 *  - `file`：向后兼容，带警告
 *
 * **诚实边界**：同用户下的任何持久化存储，理论上都能被同用户的恶意进程提取。
 * 本模块消除的是「明文文件可被随手读」，不是「同用户主动提取」。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface SecretDeps {
  /** 从凭据管理器读；undefined 表示没有或该平台不可用。可抛错，会被降级处理。 */
  readCredential: (target: string) => string | undefined
  readEnv: (name: string) => string | undefined
  /** 读到环境变量后必须调用，防止子进程继承。 */
  clearEnv: (name: string) => void
  readFile: (path: string) => string | undefined
}

export type KeySource = 'credential' | 'env' | 'file' | 'none'

export interface LoadedKey {
  key: string | undefined
  source: KeySource
  /** 面向用户的提示，绝不含 key 内容。 */
  warnings: string[]
}

export interface LoadKeyOptions {
  /** 凭据管理器的 target 名，如 `PRTS/DeepSeek`。 */
  target: string
  /** 文件回退路径。 */
  keyFile: string
  /** 环境变量名，如 `DEEPSEEK_API_KEY`。 */
  envName: string
  deps?: SecretDeps
}

function nonEmpty(v: string | undefined): string | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/**
 * 在 Windows 上通过 PowerShell 调 CredRead 读通用凭据。
 *
 * 每次启动约 300ms（Add-Type 要编译 C#），可接受。
 * 任何失败（非 Windows、无 PowerShell、凭据不存在）都返回 undefined 而不是抛错——
 * 密钥来源不可用不该让终端起不来。
 */
function readCredentialViaPowerShell(target: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  // target 只允许安全字符，避免拼进 PowerShell 字符串时被注入
  if (!/^[A-Za-z0-9._/-]+$/.test(target)) return undefined
  const script = [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class PrtsCredReader {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);',
    '  [DllImport("advapi32.dll")]',
    '  static extern void CredFree(IntPtr cred);',
    '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
    '  struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
    '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
    '    public uint CredentialBlobSize; public IntPtr CredentialBlob;',
    '    public uint Persist; public uint AttributeCount; public IntPtr Attributes;',
    '    public string TargetAlias; public string UserName;',
    '  }',
    '  public static string Get(string target) {',
    '    IntPtr p;',
    '    if (!CredReadW(target, 1, 0, out p)) return "";',
    '    try {',
    '      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));',
    '      return Marshal.PtrToStringUni(c.CredentialBlob, (int)(c.CredentialBlobSize / 2));',
    '    } finally { CredFree(p); }',
    '  }',
    '}',
    "'@",
    `[PrtsCredReader]::Get('${target}')`,
  ].join('\n')

  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  })
  if (r.status !== 0) return undefined
  return nonEmpty(r.stdout ?? undefined)
}

const defaultDeps: SecretDeps = {
  readCredential: readCredentialViaPowerShell,
  readEnv: (name) => process.env[name],
  clearEnv: (name) => { delete process.env[name] },
  readFile: (path) => {
    if (!existsSync(path)) return undefined
    try { return readFileSync(path, 'utf8') } catch { return undefined }
  },
}

export function loadApiKey(o: LoadKeyOptions): LoadedKey {
  const deps = o.deps ?? defaultDeps
  const warnings: string[] = []

  // 1. 凭据管理器
  try {
    const cred = nonEmpty(deps.readCredential(o.target))
    if (cred !== undefined) return { key: cred, source: 'credential', warnings }
  } catch {
    // 凭据管理器不可用不是错误，只是降级
  }

  // 2. 环境变量（读到即清除）
  const env = nonEmpty(deps.readEnv(o.envName))
  if (env !== undefined) {
    deps.clearEnv(o.envName)
    return { key: env, source: 'env', warnings }
  }

  // 3. 文件（兼容路径）
  const file = nonEmpty(deps.readFile(o.keyFile))
  if (file !== undefined) {
    warnings.push(
      `密钥来自明文文件 ${o.keyFile}——模型 shell 能直接读走它。`
      + `建议改用凭据管理器：npm run secret:set（存好后删除该文件）。`,
    )
    return { key: file, source: 'file', warnings }
  }

  warnings.push(
    `未找到 API key。可选：存到凭据管理器（npm run secret:set），`
    + `或设环境变量 ${o.envName}，或放入 ${o.keyFile}（不推荐，明文可被模型 shell 读取）。`,
  )
  return { key: undefined, source: 'none', warnings }
}
