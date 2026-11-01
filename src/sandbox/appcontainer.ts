/**
 * AppContainer 沙箱（U3 的读隔离层）。
 *
 * ## 为什么是 AppContainer
 *
 * 四条传统路径已全部实测证伪（docs/u3-key-read-isolation.md §2）：换
 * `dsh-pwsh-sandbox`（同一个 ctx.sandbox）、SACL no-read-up（本机写不进）、
 * deny ACE 打 workspaceWriteSid（该 SID 不参与读检查）、DACL deny 打
 * Administrator（会同时锁死 PRTS）。专用账号 + `CreateProcessAsUser` 也被证伪——
 * 本机令牌缺 `SeAssignPrimaryToken` / `SeIncreaseQuota` / `SeImpersonate`，
 * `CreateProcessWithTokenW` 实测 1314。
 *
 * AppContainer 走 `CreateProcess` + `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`，
 * 不需要那三项特权。Wave 0b/0c 与 `.scratch/probe-koffi-spawn.mjs` 的实测：
 * 未提权可启动、读不到工作区外的密钥、授权后能读、pwsh 7 含 `-File` 可用。
 *
 * ## 第一版的两条边界（明确写死，不当成缺陷来「修」）
 *
 * 1. **不捕获 stdio**。子进程的 stdout/stderr 直接继承调用方的终端，程序拿不到。
 *    要拿得用 CreatePipe + 异步读，是下一步的工作。`spawn` 只返回 pid 与退出码。
 * 2. **授权走 `icacls` 子进程**，不手写 `SetNamedSecurityInfo`。理由：icacls 是
 *    系统自带且行为稳定，而后者有「pSacl 要 ACL 指针而不是整个 SD」这类坑
 *    （本轮踩过），没必要重踩。
 *
 * ## fail-closed
 *
 * 任何一步 Win32 调用失败都抛错，绝不降级成「不受限地跑」。这与
 * `dsh-sandbox-windows-acl` 的 `init()` 契约一致：宁可不启动，也不静默放开。
 */
import { createRequire } from 'node:module'
import { spawn as spawnProcess } from 'node:child_process'

const require = createRequire(import.meta.url)

/* eslint-disable @typescript-eslint/no-explicit-any */
// koffi 没有自带类型声明；这里只在模块内使用，对外不暴露 any。
const koffi = require('koffi') as any

export interface AppContainerOptions {
  /** profile 名。同名会复用已有 profile（幂等）。 */
  name: string
  /** 需要读写的工作区，授予 (OI)(CI)(RX,W)。 */
  workspace: string
  /** 额外需要的只读目录（如 shell 可执行文件所在目录）。 */
  extraReadPaths?: readonly string[]
}

export interface SpawnOptions {
  /** 可执行文件完整路径。AppContainer 里没有 PATH 解析。 */
  command: string
  args?: readonly string[]
  /** 子进程工作目录；缺省用宿主的当前目录。必须在已授权的工作区内。 */
  cwd?: string
}

export interface ChildHandle {
  readonly pid: number
  /** 等子进程结束。永不 reject——非零退出是结果而不是异常。 */
  wait(): Promise<{ exitCode: number }>
}

export interface AppContainer {
  /** AppContainer 的 package SID（`S-1-15-2-...`）。 */
  readonly sid: string
  spawn(options: SpawnOptions): ChildHandle
  /** 撤销本次授予的 ACL 并删除 profile。幂等，可重复调用。 */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------- Win32 绑定

const userenv = koffi.load('userenv.dll')
const kernel32 = koffi.load('kernel32.dll')
const advapi32 = koffi.load('advapi32.dll')

const STARTUPINFO = koffi.struct('STARTUPINFO', {
  cb: 'uint32_t',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32_t',
  dwY: 'uint32_t',
  dwXSize: 'uint32_t',
  dwYSize: 'uint32_t',
  dwXCountChars: 'uint32_t',
  dwYCountChars: 'uint32_t',
  dwFillAttribute: 'uint32_t',
  dwFlags: 'uint32_t',
  wShowWindow: 'uint16_t',
  cbReserved2: 'uint16_t',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
})
const STARTUPINFOEX = koffi.struct('STARTUPINFOEX', {
  StartupInfo: STARTUPINFO,
  lpAttributeList: 'void *',
})
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32_t',
  dwThreadId: 'uint32_t',
})
const SECURITY_CAPABILITIES = koffi.struct('SECURITY_CAPABILITIES', {
  AppContainerSid: 'void *',
  Capabilities: 'void *',
  CapabilityCount: 'uint32_t',
  Reserved: 'uint32_t',
})

// 布局自检：cb 不对时 CreateProcess 返回 87（ERROR_INVALID_PARAMETER），
// 而 87 很容易被误读成「权限不足」。这三个常量对不上就别往下走。
const SIZE_SIEX = koffi.sizeof(STARTUPINFOEX)
const SIZE_SI = koffi.sizeof(STARTUPINFO)
const SIZE_CAPS = koffi.sizeof(SECURITY_CAPABILITIES)
if (SIZE_SIEX !== 112 || SIZE_SI !== 104 || SIZE_CAPS !== 24) {
  throw new Error(
    `prts: AppContainer 结构体布局与原生不符 `
    + `(STARTUPINFOEX=${SIZE_SIEX}/112, STARTUPINFO=${SIZE_SI}/${104}, `
    + `SECURITY_CAPABILITIES=${SIZE_CAPS}/24)。继续调用只会得到 87，先修 struct 定义。`,
  )
}

const CreateAppContainerProfile = userenv.func(
  'int CreateAppContainerProfile(const char16_t *name, const char16_t *display, '
  + 'const char16_t *desc, void *caps, uint32_t count, _Out_ void **sid)',
)
const DeriveAppContainerSid = userenv.func(
  'int DeriveAppContainerSidFromAppContainerName(const char16_t *name, _Out_ void **sid)',
)
const DeleteAppContainerProfile = userenv.func(
  'int DeleteAppContainerProfile(const char16_t *name)',
)
const ConvertSidToStringSidW = advapi32.func(
  'bool ConvertSidToStringSidW(void *sid, _Out_ void **str)',
)
const InitializeProcThreadAttributeList = kernel32.func(
  'bool InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ size_t *size)',
)
const UpdateProcThreadAttribute = kernel32.func(
  'bool UpdateProcThreadAttribute(void *list, uint32_t flags, uint64_t attr, void *value, '
  + 'size_t size, void *prev, size_t *retSize)',
)
const CreateProcessW = kernel32.func(
  'bool CreateProcessW(const char16_t *app, void *cmdline, void *pa, void *ta, bool inherit, '
  + 'uint32_t flags, void *env, const char16_t *cwd, STARTUPINFOEX *si, _Out_ PROCESS_INFORMATION *pi)',
)
const WaitForSingleObject = kernel32.func('uint32_t WaitForSingleObject(void *h, uint32_t ms)')
const GetExitCodeProcess = kernel32.func('bool GetExitCodeProcess(void *h, _Out_ uint32_t *code)')
const CloseHandle = kernel32.func('bool CloseHandle(void *h)')
const LocalFree = kernel32.func('void *LocalFree(void *p)')

const EXTENDED_STARTUPINFO_PRESENT = 0x0008_0000
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x0002_0009

// ---------------------------------------------------------------- 辅助

function sidToString(sidPtr: unknown): string {
  const out: unknown[] = [null]
  if (!ConvertSidToStringSidW(sidPtr, out)) {
    throw new Error('prts: ConvertSidToStringSidW 失败，拿不到 AppContainer SID')
  }
  const str = koffi.decode(out[0], 'char16_t', -1) as string
  LocalFree(out[0])
  return str
}

/** HRESULT 0x800700B7 = ERROR_ALREADY_EXISTS，此时改为派生 SID。 */
function ensureProfile(name: string): unknown {
  const out: unknown[] = [null]
  const hr = CreateAppContainerProfile(name, name, 'PRTS AppContainer sandbox', null, 0, out) as number
  if (hr === 0) return out[0]
  const out2: unknown[] = [null]
  const hr2 = DeriveAppContainerSid(name, out2) as number
  if (hr2 !== 0) {
    throw new Error(
      `prts: 建 AppContainer profile 失败 hr=0x${(hr >>> 0).toString(16).padStart(8, '0')}，`
      + `派生也失败 hr=0x${(hr2 >>> 0).toString(16).padStart(8, '0')}`,
    )
  }
  return out2[0]
}

function icacls(args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawnProcess('icacls.exe', args as string[], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, out }))
  })
}

// ---------------------------------------------------------------- 实现

export async function createAppContainer(opts: AppContainerOptions): Promise<AppContainer> {
  if (typeof opts.name !== 'string' || opts.name === '') {
    throw new Error('prts: AppContainer 需要非空的 profile 名')
  }
  if (typeof opts.workspace !== 'string' || opts.workspace === '') {
    throw new Error('prts: AppContainer 需要非空的工作区路径')
  }

  const sidPtr = ensureProfile(opts.name)
  const sid = sidToString(sidPtr)

  /** 已授予的路径，dispose 时逐条撤销。 */
  const granted: string[] = []

  const grant = async (target: string, perm: string): Promise<void> => {
    const r = await icacls([target, '/grant', `*${sid}:${perm}`])
    if (r.code !== 0) {
      throw new Error(`prts: 授权 ${target} 失败 (icacls exit ${r.code})：${r.out.trim()}`)
    }
    granted.push(target)
  }

  await grant(opts.workspace, '(OI)(CI)(RX,W)')
  for (const p of opts.extraReadPaths ?? []) await grant(p, '(OI)(CI)(RX)')

  return {
    sid,

    spawn(o: SpawnOptions): ChildHandle {
      if (typeof o.command !== 'string' || o.command === '') {
        throw new Error('prts: spawn 需要可执行文件的完整路径')
      }

      // attribute list：先问大小，再分配。失败即抛，不降级。
      const size: unknown[] = [0]
      InitializeProcThreadAttributeList(null, 1, 0, size)
      const list = Buffer.alloc(Number(size[0] as number))
      if (!InitializeProcThreadAttributeList(list, 1, 0, size)) {
        throw new Error('prts: InitializeProcThreadAttributeList 失败')
      }

      const capsBuf = koffi.alloc(SECURITY_CAPABILITIES, 1)
      koffi.encode(capsBuf, SECURITY_CAPABILITIES, {
        AppContainerSid: sidPtr,
        Capabilities: null,
        CapabilityCount: 0,
        Reserved: 0,
      })
      // DWORD_PTR 是 64 位：Number 传给 uint64_t 参数会被 koffi 拒绝，必须 BigInt。
      // lpReturnSize 允许 NULL。
      if (!UpdateProcThreadAttribute(
        list, 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capsBuf,
        BigInt(SIZE_CAPS), null, null,
      )) {
        throw new Error('prts: UpdateProcThreadAttribute(SECURITY_CAPABILITIES) 失败')
      }

      const siExBuf = koffi.alloc(STARTUPINFOEX, 1)
      koffi.encode(siExBuf, STARTUPINFOEX, {
        StartupInfo: { cb: SIZE_SIEX },
        lpAttributeList: list,
      })
      const piBuf = koffi.alloc(PROCESS_INFORMATION, 1)

      // lpCommandLine 必须可写：CreateProcess 会就地修改它。传 string 会落到
      // 只读内存上。用 UTF-16LE 的 Buffer（含结尾 NUL）。
      const cmdline = Buffer.from(
        [o.command, ...(o.args ?? [])]
          .map((s) => (s.includes(' ') ? `"${s}"` : s))
          .join(' ') + '\0',
        'utf16le',
      )

      const ok = CreateProcessW(
        o.command, cmdline, null, null,
        // 第一版不捕获 stdio：不继承、也不设 STARTF_USESTDHANDLES，
        // 子进程拿不到调用方的句柄。要捕获得用 CreatePipe。
        false,
        EXTENDED_STARTUPINFO_PRESENT, null, o.cwd ?? null, siExBuf, piBuf,
      )
      if (!ok) {
        throw new Error(`prts: CreateProcessW(AppContainer) 失败：${o.command}`)
      }

      const pi = koffi.decode(piBuf, PROCESS_INFORMATION) as {
        hProcess: unknown
        hThread: unknown
        dwProcessId: number
      }
      CloseHandle(pi.hThread)

      return {
        pid: pi.dwProcessId,
        wait(): Promise<{ exitCode: number }> {
          return new Promise((resolve) => {
            WaitForSingleObject(pi.hProcess, 0xFFFF_FFFF)
            const code: unknown[] = [0]
            GetExitCodeProcess(pi.hProcess, code)
            CloseHandle(pi.hProcess)
            resolve({ exitCode: Number(code[0] as number) })
          })
        },
      }
    },

    async dispose(): Promise<void> {
      for (const target of granted) {
        try { await icacls([target, '/remove', `*${sid}`]) } catch { /* 已被删 */ }
      }
      granted.length = 0
      DeleteAppContainerProfile(opts.name)
    },
  }
}
