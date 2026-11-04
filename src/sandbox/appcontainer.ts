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
 * 1. **stdout 与 stderr 合并捕获**。走同一个管道：分开读两个管道时，若子进程
 *    写满其中一个（64KB）而父进程正在读另一个，写端阻塞、读端等 EOF，双死锁。
 *    `wait()` 返回 `{ exitCode, output }`，`output` 是合并文本。要区分两者得
 *    同时实现异步并发读，不是把管道拆成两个就行。
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
  /**
   * 透传调用方的 stdio，而不是自建管道捕获。
   *
   * 持久 shell（PTY）必须用这个：`dsh-terminal-bash` 在**启动 shell 进程时**调一次
   * confine，之后每条命令都在同一个 PTY 进程里跑。它需要的是一个能双向交互的
   * 进程，而不是「跑完返回一段输出」。此时 `wait()` 返回的 `output` 恒为空——
   * 输出由调用方的 PTY 自己收。
   */
  inheritStdio?: boolean
}

export interface ChildHandle {
  readonly pid: number
  /**
   * 等子进程结束。
   *
   * `output` 是 stdout 与 stderr 的**合并**文本。不分开读是有原因的：两个管道
   * 各自只有 64KB 缓冲，若子进程写满其中一个而父进程正在读另一个，写端阻塞、
   * 读端等 EOF，双死锁。合并成一个管道后只有单一读端，读到 EOF 即结束。
   */
  wait(): Promise<{ exitCode: number; output: string }>
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
const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32_t',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int',
})

// 布局自检：cb 不对时 CreateProcess 返回 87（ERROR_INVALID_PARAMETER），
// 而 87 很容易被误读成「权限不足」。这三个常量对不上就别往下走。
const SIZE_SIEX = koffi.sizeof(STARTUPINFOEX)
const SIZE_SI = koffi.sizeof(STARTUPINFO)
const SIZE_CAPS = koffi.sizeof(SECURITY_CAPABILITIES)
const SIZE_SA = koffi.sizeof(SECURITY_ATTRIBUTES)
if (SIZE_SIEX !== 112 || SIZE_SI !== 104 || SIZE_CAPS !== 24 || SIZE_SA !== 24) {
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
const CreatePipe = kernel32.func(
  'bool CreatePipe(_Out_ void **hRead, _Out_ void **hWrite, void *sa, uint32_t size)',
)
const SetHandleInformation = kernel32.func(
  'bool SetHandleInformation(void *h, uint32_t mask, uint32_t flags)',
)
const ReadFile = kernel32.func(
  'bool ReadFile(void *h, void *buf, uint32_t n, _Out_ uint32_t *got, void *ov)',
)
const PeekNamedPipe = kernel32.func(
  'bool PeekNamedPipe(void *h, void *buf, uint32_t n, _Out_ uint32_t *read, _Out_ uint32_t *avail, void *left)',
)
const TerminateProcess = kernel32.func('bool TerminateProcess(void *h, uint32_t code)')
const CreateMutexW = kernel32.func('void *CreateMutexW(void *sa, bool initial, const char16_t *name)')
const ReleaseMutex = kernel32.func('bool ReleaseMutex(void *h)')
const GetStdHandle = kernel32.func('void *GetStdHandle(uint32_t which)')

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
/**
 * AppContainer profile 的创建/派生走的是**用户级全局存储**：两个测试文件
 * 并发创建时会在系统内部锁上排队，极端情况下挂死（实测：全量 15 轮里第 5/11/15
 * 轮挂在 `workspace-acl.test.ts`，CPU 2.5s / 存活 87s，典型系统调用等待）。
 *
 * 用跨进程 Mutex 把「并发创建」变成「排队创建」。拿不到 Mutex 或等待超时就
 * **退化无锁**——这个调用只该防并发，不该在等待上挂死。
 */
const PROFILE_MUTEX_NAME = 'Local\\PRTS.AppContainerProfile.Create'
/** 等 Mutex 的上限：超时就无锁硬上，宁可冒险也不挂死。 */
const PROFILE_MUTEX_WAIT_MS = 15_000
const WAIT_ABANDONED = 0x80

function ensureProfile(name: string): unknown {
  let mutex: unknown = null
  let held = false
  try {
    mutex = CreateMutexW(null, false, PROFILE_MUTEX_NAME)
    if (mutex !== null && mutex !== undefined) {
      const rc = WaitForSingleObject(mutex, PROFILE_MUTEX_WAIT_MS)
      held = rc === WAIT_OBJECT_0 || rc === WAIT_ABANDONED
    }
  } catch { /* Mutex 不可用：走无锁路径 */ }
  try {
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
  } finally {
    if (held) { try { ReleaseMutex(mutex) } catch { /* ignore */ } }
    if (mutex !== null && mutex !== undefined) { try { CloseHandle(mutex) } catch { /* ignore */ } }
  }
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

/** 单次 wait 的总预算：超时后强杀并返回错误码——宁可报失败，不可挂死。 */
const WAIT_TIMEOUT_MS = 30_000
/** 进程未退出时每轮等待的毫秒数：小到及时读管道，大到不烧 CPU。 */
const WAIT_SLICE_MS = 20
const WAIT_OBJECT_0 = 0

/**
 * 读子进程输出：**有数据才读，不等 EOF**。
 *
 * 为什么不等 EOF：管道的写端被子进程继承，若它又派生孙进程且孙进程不退出，
 * 写端永不关闭、EOF 永不到来——同步 `ReadFile` 会永久阻塞，`node --test` 的
 * 120s 超时也不触发（事件循环停摆）。2026-11-04 实测：全量 20 轮第 5 轮挂起，
 * 卡在 `workspace-acl.test.ts` 的 AppContainer 路径（CPU 2.6s / 存活 90s，
 * 典型阻塞），且有一个孙进程存活。
 *
 * 顺序：`PeekNamedPipe` 查可读字节 → 有就 `ReadFile`（已有数据不会阻塞）→
 * 没有就 `WaitForSingleObject` 等 20ms 看进程是否退出 → 进程退出后再读残留，
 * Peek 为 0 即停。总预算 30s，超时由调用方强杀。
 */
function drainUntilExit(pipeHandle: unknown, procHandle: unknown): { output: string; timedOut: boolean } {
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(65536)
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let exited = false
  for (;;) {
    const availOut: unknown[] = [0]
    const okPeek = PeekNamedPipe(pipeHandle, null, 0, null, availOut, null)
    if (!okPeek) break   // 句柄已不可用：读不到更多
    const avail = Number(availOut[0] as number)
    if (avail > 0) {
      const got: unknown[] = [0]
      const okRead = ReadFile(pipeHandle, buf, Math.min(avail, 65536), got, null)
      const read = Number(got[0] as number)
      if (!okRead || read === 0) break
      chunks.push(Buffer.from(buf.subarray(0, read)))
      continue
    }
    if (exited) break     // 进程已退出且无残留：结束（不等 EOF）
    if (Date.now() >= deadline) return { output: Buffer.concat(chunks).toString('utf8'), timedOut: true }
    if (WaitForSingleObject(procHandle, WAIT_SLICE_MS) === WAIT_OBJECT_0) exited = true
  }
  CloseHandle(pipeHandle)
  return { output: Buffer.concat(chunks).toString('utf8'), timedOut: false }
}

// ---------------------------------------------------------------- 实现

/** 只派生 AppContainer 包 SID，不创建 profile。供 workspace-acl 的 allow-only 修法定位 ACE。 */
export function deriveAppContainerSid(name: string): string {
  if (typeof name !== 'string' || name === '') {
    throw new Error('prts: deriveAppContainerSid 需要非空的 profile 名')
  }
  const out: unknown[] = [null]
  const hr = DeriveAppContainerSid(name, out) as number
  if (hr !== 0) {
    throw new Error(`prts: 派生 AppContainer SID 失败 hr=0x${(hr >>> 0).toString(16).padStart(8, '0')}`)
  }
  const sid = sidToString(out[0])
  LocalFree(out[0])
  return sid
}

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
  for (const p of opts.extraReadPaths ?? []) {
    // 额外读权限是增强，不是容器创建的前置。目录可能还不存在（从未 spill 过），
    // 那时 icacls 会以 exit 2「系统找不到指定的文件」失败。让这种情况把整个容器
    // 建不起来是本末倒置——实测过一次：所有 shell 命令都变成 runner 70 失败。
    try {
      await grant(p, '(OI)(CI)(RX)')
    } catch (error) {
      console.warn(
        `[prts] 跳过额外读权限 ${p}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

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

      // inherit 模式不建管道：子进程直接继承调用方的 stdio（PTY 的 slave 端就在
      // 那里），双向交互才有得谈。capture 模式才自建单管道。
      const inherit = o.inheritStdio === true
      let pipeReadHandle: unknown
      let pipeWrite: unknown
      // inherit 模式：取调用方 stdio 句柄并设为可继承。Getter 返回的句柄属于本进程，
      // 不设继承位子进程拿到的是无效值。
      const inheritHandles = { input: null as unknown, output: null as unknown, error: null as unknown }
      if (inherit) {
        inheritHandles.input = GetStdHandle(0xFFFF_FFF6)   // STD_INPUT_HANDLE (-10)
        inheritHandles.output = GetStdHandle(0xFFFF_FFF5)  // STD_OUTPUT_HANDLE (-11)
        inheritHandles.error = GetStdHandle(0xFFFF_FFF4)   // STD_ERROR_HANDLE (-12)
        for (const h of [inheritHandles.input, inheritHandles.output, inheritHandles.error]) {
          if (h !== null && h !== undefined) SetHandleInformation(h, 1, 1)
        }
      }
      if (!inherit) {
        const saBuf = koffi.alloc(SECURITY_ATTRIBUTES, 1)
        koffi.encode(saBuf, SECURITY_ATTRIBUTES, {
          nLength: SIZE_SA,
          lpSecurityDescriptor: null,
          bInheritHandle: 1,
        })
        const pipeRead: unknown[] = [null]
        const pipeWriteOut: unknown[] = [null]
        if (!CreatePipe(pipeRead, pipeWriteOut, saBuf, 0)) {
          throw new Error('prts: CreatePipe 失败')
        }
        // 读端不继承：子进程若也持着读端，EOF 永远不来。
        SetHandleInformation(pipeRead[0], 1, 0)
        pipeReadHandle = pipeRead[0]
        pipeWrite = pipeWriteOut[0]
      }

      const siExBuf = koffi.alloc(STARTUPINFOEX, 1)
      koffi.encode(siExBuf, STARTUPINFOEX, {
        StartupInfo: inherit
          ? {
            // 不能只靠 bInheritHandles 让子进程「自动继承」：Node 的 stdio 句柄
            // 默认不带 HANDLE_FLAG_INHERIT，子进程拿到无效句柄会以
            // 0xC0000142 (STATUS_DLL_INIT_FAILED) 崩在 DLL 初始化阶段。
            // 必须显式取句柄、显式设继承位、显式传给子进程。
            cb: SIZE_SIEX,
            dwFlags: 0x0000_0100, // STARTF_USESTDHANDLES
            hStdInput: inheritHandles.input,
            hStdOutput: inheritHandles.output,
            hStdError: inheritHandles.error,
          }
          : {
            cb: SIZE_SIEX,
            dwFlags: 0x0000_0100, // STARTF_USESTDHANDLES
            hStdInput: null,
            hStdOutput: pipeWrite,
            hStdError: pipeWrite,
          },
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
        // 必须继承：否则子进程拿不到管道写端，输出全丢。
        true,
        EXTENDED_STARTUPINFO_PRESENT, null, o.cwd ?? null, siExBuf, piBuf,
      )
      // 无论成功失败，父进程都要关掉写端——否则读端等不到 EOF。
      // inherit 模式下没有管道，跳过。
      if (!inherit) CloseHandle(pipeWrite)
      if (!ok) {
        if (!inherit) CloseHandle(pipeReadHandle)
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
        wait(): Promise<{ exitCode: number; output: string }> {
          return new Promise((resolve) => {
            // inherit 模式没有管道可读，输出归调用方；仍给总预算，不无限等。
            if (inherit) {
              const rc = WaitForSingleObject(pi.hProcess, WAIT_TIMEOUT_MS)
              if (rc !== WAIT_OBJECT_0) {
                try { TerminateProcess(pi.hProcess, 1) } catch { /* 已死 */ }
                WaitForSingleObject(pi.hProcess, 1000)
                CloseHandle(pi.hProcess)
                resolve({ exitCode: -1, output: `[prts] AppContainer 子进程超时（${WAIT_TIMEOUT_MS}ms，inherit）` })
                return
              }
              const code: unknown[] = [0]
              GetExitCodeProcess(pi.hProcess, code)
              CloseHandle(pi.hProcess)
              resolve({ exitCode: Number(code[0] as number), output: '' })
              return
            }
            const { output, timedOut } = drainUntilExit(pipeReadHandle, pi.hProcess)
            if (timedOut) {
              try { TerminateProcess(pi.hProcess, 1) } catch { /* 已死 */ }
              WaitForSingleObject(pi.hProcess, 1000)
              CloseHandle(pi.hProcess)
              resolve({ exitCode: -1, output: `${output}\n[prts] AppContainer 子进程超时（${WAIT_TIMEOUT_MS}ms），已强杀` })
              return
            }
            const code: unknown[] = [0]
            GetExitCodeProcess(pi.hProcess, code)
            CloseHandle(pi.hProcess)
            resolve({ exitCode: Number(code[0] as number), output })
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
