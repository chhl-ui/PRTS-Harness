/**
 * workspace 根 ACL 启动加固：local 后端的 WRITE_OWNER 自动授权 + .git 对 shell 只读。
 *
 * 实测依据（三轮 E2E ACL 实验）：
 * - `dsh-sandbox-windows-acl` 的 `grantWrite` 在 workspace 设 Low 强制标签需要
 *   WRITE_OWNER（types-Cl_DXjhk.js:583 注释：owner 隐含权只有 READ_CONTROL/WRITE_DAC）。
 *   UAC 未提权下 C:\ 自建目录只有继承 ACL → Win32 5。解法：给当前用户 SID 授 (OI)(CI)(WO)。
 * - `.git` 对 shell 只读：local 用显式 DENY（能力 SID 是 restricting SID，DENY 生效）；
 *   appcontainer 的内核对容器 SID **忽略 DENY_ACCESS ACE**（allow-only 模型），只能
 *   断继承 + 去写允许 + 只授 RX。
 * - SID 派生用 `realpathSync.native`：DSH 的 `canonicalPath` 用它（dsh-sandbox/lib/index.js:150），
 *   JS 版 realpathSync 不规范化拼写（如盘符大小写），SID 不一致会让 DENY 落在错误
 *   SID 上——读回照样「通过」但保护静默失效。
 *
 * 实现边界：只护 workspace 根下 `.git`；启动后才 git init 的不受护直到下次启动；
 * 嵌套仓库/子模块不覆盖；appcontainer 修法断开 .git DACL 继承；
 * `.git` 是 junction/symlink 时 throw（/T 会改到 workspace 外）。
 *
 * 读回纪律：全部走 PowerShell `GetAccessRules` 结构化读回（实测过「脚本自报
 * applied 但 ACE 不存在」），不看 icacls 文本、不看 ps 的本地化错误文本。
 * 传参走 spawn env（$env: 取值），不拼进脚本体。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

export type AclOutcome = 'applied' | 'already' | 'absent' | 'skipped'
export type AclExec = (argv: string[], env?: Record<string, string>) => Promise<{ code: number; out: string }>
export interface AclOpts {
  platform?: NodeJS.Platform
  exec?: AclExec
}

const realExec: AclExec = async (argv, env) => {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } })
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
const exec = (o?: AclOpts): AclExec => o?.exec ?? realExec
const plat = (o?: AclOpts) => o?.platform ?? process.platform

// ---------------------------------------------------------------- 结构化读回

export interface AclRule {
  /** SDDL SID 字符串（SecurityIdentifier 主键，无法翻译的 SID 也稳定可读）。 */
  sid: string
  /** 0=Allow, 1=Deny（用枚举数值，不受本地化影响）。 */
  type: number
  /** FileSystemRights 位掩码。 */
  rights: number
  inherited: boolean
  /** InheritanceFlags 位掩码（1=ContainerInherit, 2=ObjectInherit）。 */
  inheritanceFlags: number
}
export interface AclSnapshot {
  /** DACL 是否被保护（已断继承）。 */
  protected: boolean
  rules: AclRule[]
}

const READ_PS =
  `$a=Get-Acl $env:PRTS_ACL_PATH;` +
  `$r=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {` +
  `  [pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.value__;` +
  `  rights=[int64]$_.FileSystemRights.value__;inherited=$_.IsInherited;` +
  `  inheritanceFlags=[int]$_.InheritanceFlags.value__}});` +
  `[pscustomobject]@{protected=$a.AreAccessRulesProtected;rules=$r} | ConvertTo-Json -Compress -Depth 4`

/** Get-Acl 结构化读回；任何失败（退出码/JSON）都 throw——读回是安全证据，不能降级。 */
export async function readAcl(target: string, o?: AclOpts): Promise<AclSnapshot> {
  const r = await exec(o)(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', READ_PS], { PRTS_ACL_PATH: target })
  if (r.code !== 0) throw new Error(`workspace-acl：Get-Acl 读回失败 ${target} rc=${r.code} ${r.out.slice(0, 300)}`)
  let j: { protected?: boolean; rules?: unknown }
  try { j = JSON.parse(r.out.trim()) } catch { throw new Error(`workspace-acl：读回 JSON 解析失败 ${target}：${r.out.slice(0, 200)}`) }
  const rules = Array.isArray(j.rules) ? j.rules : j.rules ? [j.rules] : []
  return { protected: j.protected === true, rules: rules as AclRule[] }
}

// FileSystemRights 位：0x2 WriteData/CreateFiles,0x4 AppendData/CreateDirs,0x10 WriteEA,
// 0x40 DeleteSubdirs,0x100 WriteAttrs,0x10000 Delete,0x40000 WriteDAC,0x80000 WriteOwner,
// 0x40000000 GenericWrite,0x10000000 GenericAll；ReadAndExecute=0x1200A9。
const WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000
const DENY_RIGHTS = 'WriteData,CreateFiles,CreateDirectories,AppendData,WriteExtendedAttributes,WriteAttributes,DeleteSubdirectoriesAndFiles,Delete,ChangePermissions,TakeOwnership'
const DENY_MASK = 0x2 | 0x4 | 0x10 | 0x100 | 0x40 | 0x10000 | 0x40000 | 0x80000 // = 0xD0156
const READ_EXECUTE = 0x1200A9
const TAKE_OWNERSHIP = 0x80000
const OICI = 0x3

const ps = async (script: string, env: Record<string, string>, o?: AclOpts): Promise<void> => {
  const r = await exec(o)(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], env)
  if (r.code !== 0) throw new Error(`workspace-acl：PowerShell 失败 rc=${r.code}：${r.out.slice(0, 300)}`)
}
const icaclsDo = async (args: string[], o?: AclOpts): Promise<void> => {
  const r = await exec(o)(['icacls', ...args])
  if (r.code !== 0) throw new Error(`workspace-acl：icacls ${args.join(' ')} 失败 rc=${r.code}：${r.out.slice(0, 300)}`)
}

const currentUser = async (o?: AclOpts): Promise<{ name: string; sid: string }> => {
  const r = await exec(o)(['C:/Windows/System32/whoami.exe', '/user', '/fo', 'csv', '/nh'])
  const parts = r.out.trim().replace(/\r/g, '').split(',')
  if (parts.length < 2) throw new Error(`workspace-acl：whoami /user 解析失败：${r.out.slice(0, 200)}`)
  return { name: parts[0].replace(/"/g, '').trim(), sid: parts[1].replace(/"/g, '').trim() }
}

const assertNotReparsePoint = (target: string): void => {
  const st = lstatSync(target)
  if (st.isSymbolicLink()) {
    throw new Error(`workspace-acl：${target} 是 reparse point（junction/symlink）——拒绝对目标之外做 ACL，拒绝启动`)
  }
}

/** local 后端：确保当前用户对 workspace 根有显式 WRITE_OWNER（仅 WO 实测足够）。 */
export async function ensureWorkspaceWriteOwner(ws: string, o?: AclOpts): Promise<AclOutcome> {
  if (plat(o) !== 'win32') return 'skipped'
  const u = await currentUser(o)
  const hasWo = (s: AclSnapshot) => s.rules.some(r => r.type === 0 && r.sid === u.sid && (r.rights & TAKE_OWNERSHIP) !== 0)
  if (hasWo(await readAcl(ws, o))) return 'already'
  await icaclsDo([ws, '/grant', `*${u.sid}:(OI)(CI)(WO)`], o)
  if (!hasWo(await readAcl(ws, o))) {
    throw new Error(`workspace-acl：WO 授权读回不符 ${ws}——未见当前用户 ${u.sid} 的 TakeOwnership 允许`)
  }
  console.error(`[prts] 已为 workspace 授予当前用户 WRITE_OWNER：${ws}`)
  return 'applied'
}

/** local 后端：`<ws>/<sub>` 上对沙箱写能力 SID 加显式 DENY。 */
export async function protectSubpathLocal(ws: string, sub: string, o?: AclOpts): Promise<AclOutcome> {
  if (plat(o) !== 'win32') return 'skipped'
  const target = join(ws, sub)
  if (!existsSync(target)) return 'absent'
  assertNotReparsePoint(target)
  const isDir = statSync(target).isDirectory()
  // DSH canonicalPath = realpathSync.native（dsh-sandbox-local/lib/index.js:309）。
  // 必须同源：JS realpathSync 保留传入拼写（盘符大小写），SID 会算错。
  const sid = workspaceWriteSid(realpathSync.native(ws))
  const denyOk = (s: AclSnapshot) => s.rules.some(r =>
    r.type === 1 && r.sid === sid && !r.inherited
    && (r.rights & DENY_MASK) === DENY_MASK
    && (!isDir || (r.inheritanceFlags & OICI) === OICI))
  if (denyOk(await readAcl(target, o))) return 'already'
  const inherit = isDir ? 'ContainerInherit,ObjectInherit' : 'None'
  await ps(
    `$o=New-Object System.Security.Principal.SecurityIdentifier($env:PRTS_ACL_SID);` +
    `$a=Get-Acl $env:PRTS_ACL_PATH;` +
    `$r=New-Object System.Security.AccessControl.FileSystemAccessRule($o,'${DENY_RIGHTS}','${inherit}','None','Deny');` +
    `$a.AddAccessRule($r);Set-Acl $env:PRTS_ACL_PATH $a`,
    { PRTS_ACL_PATH: target, PRTS_ACL_SID: sid }, o,
  )
  if (!denyOk(await readAcl(target, o))) {
    throw new Error(`workspace-acl：DENY 读回不符 ${target}——未见 ${sid} 的显式 DENY`)
  }
  console.error(`[prts] 已对 ${target} 施加 shell 只读保护（local）`)
  return 'applied'
}

/** appcontainer：断继承→去该 SID 全部允许→只授 RX（/T 覆盖已继承 (I) 写允许的子项）。 */
export async function protectSubpathAppContainer(ws: string, sub: string, containerSid: string, o?: AclOpts): Promise<AclOutcome> {
  if (plat(o) !== 'win32') return 'skipped'
  const target = join(ws, sub)
  if (!existsSync(target)) return 'absent'
  assertNotReparsePoint(target)
  const isDir = statSync(target).isDirectory()
  const ok = (s: AclSnapshot) => {
    const aces = s.rules.filter(r => r.sid === containerSid && r.type === 0)
    return s.protected && aces.length > 0
      && aces.every(r => (r.rights & WRITE_BITS) === 0)
      && aces.some(r => (r.rights & READ_EXECUTE) === READ_EXECUTE)
  }
  if (ok(await readAcl(target, o))) return 'already'
  // 断继承（文件也有继承 ACE，必须同样断，否则 remove:g 删不掉继承项）
  await icaclsDo([target, '/inheritance:d'], o)
  await icaclsDo([target, '/remove:g', `*${containerSid}`, ...(isDir ? ['/T'] : [])], o)
  await icaclsDo([target, '/grant', `*${containerSid}:${isDir ? '(OI)(CI)(RX)' : '(RX)'}`, ...(isDir ? ['/T'] : [])], o)
  if (!ok(await readAcl(target, o))) {
    throw new Error(`workspace-acl：appcontainer 修法读回不符 ${target}——仍有写允许/缺 RX/继承未断`)
  }
  console.error(`[prts] 已对 ${target} 施加 shell 只读保护（appcontainer）`)
  return 'applied'
}
