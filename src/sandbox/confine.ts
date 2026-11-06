/**
 * 把一次调用的 argv 包成「经 AppContainer runner 执行」的 argv。
 *
 * 形状对齐 `dsh-sandbox` 的 `ConfinedArgv`
 * （`node_modules/@deepseek-ai/dsh-sandbox/lib/types/index.d.ts`）：
 * 调用方拿到 `argv` 后用它替代自己的 argv 去 spawn，无需知道沙箱怎么建。
 *
 * 只做纯计算，不碰 cordis。包成 `SandboxProvider`（`extends Service`）是接线时的
 * 一层薄壳，先把「包装逻辑本身对不对」独立验证掉。
 *
 * ## 三个字段的取值理由（都有实测依据，见 AGENTS.md）
 *
 * - `enforcement: 'partial'`：文件效果能管住，但网络默认关闭这一点没有逐项验证过，
 *   且 NTFS 备用数据流 / 硬链接这类边角没测。按「能承诺多少说多少」取 partial。
 * - `denialSignatures: []`：越界操作的错误文本是**系统本地化**的——本机实测 cmd
 *   全为「拒绝访问。」、pwsh 为「对路径 … 的访问被拒绝。」。填中文换台机器失效，
 *   填英文在本机匹配不上。**上游不能靠文本嗅探判断「是不是沙箱拦的」。**
 * - `runnerFailureRules`：runner 自己失败时往 stderr 写 `prts runner: ...` 并用
 *   sysexits 64/70 退出。这条规则让上游能区分「命令没跑起来」与「命令跑了但失败」。
 */
import { isAbsolute, normalize } from 'node:path'

/** 与 dsh-sandbox 的 `RunnerFailureRule` 同形。 */
export interface RunnerFailureRule {
  allowedExitCodes?: readonly number[]
  fatalSignatures: readonly string[]
  informationalLines?: readonly string[]
}

/** 与 dsh-sandbox 的 `ConfinedArgv` 同形。 */
export interface ConfinedArgv {
  argv: string[]
  enforcement: 'full' | 'partial'
  denialSignatures: readonly string[]
  runnerFailureRules: readonly RunnerFailureRule[]
}

/** 与 dsh-sandbox 的 `ConfinedSandboxMode` 同形。 */
export type ConfinedMode = 'read-only' | 'workspace-write'

export interface ConfineOptions {
  mode: ConfinedMode
  /** 绝对路径；必须是 AppContainer 祖先链可 traverse 的浅层目录。 */
  workspaceRoot: string
  /** AppContainer profile 名。同名复用，建议按工作区或部署固定。 */
  profile: string
  /** runner 脚本的绝对路径；缺省由调用方从模块位置推导。 */
  runnerPath: string
  /** Node 可执行文件路径；缺省用 process.execPath。 */
  execPath?: string
  /** 需要额外授予读权限的目录（AppContainer 内可读不可写）。 */
  readPaths?: readonly string[]
}

/** runner 自身失败时写在 stderr 的前缀，与 runner.ts 保持一致。 */
export const RUNNER_FAILURE_PREFIX = 'prts runner:'

/** runner 的 sysexits：64 用法错误、70 内部错误。 */
export const RUNNER_EXIT_USAGE = 64
export const RUNNER_EXIT_SOFTWARE = 70

/**
 * 会被 AppContainer 挡在祖先链上的目录特征。
 *
 * 实测（AGENTS.md）：workspace 放在 `%TEMP%` 下时，PowerShell 解析相对路径要
 * realpath 整条链，而 `AppData` / `Temp` 对 AppContainer 没有 traverse 权限，
 * 结果是「对路径 … 的访问被拒绝」——命令根本没跑。cmd 不做 realpath 所以看不出来，
 * 这类配置错误只会在换成 pwsh 时突然暴露，所以在这里提前拒掉。
 */
const BLOCKED_ANCESTOR_SEGMENTS = ['\\appdata\\', '\\temp\\']

/** 判断 workspace 是否落在 AppContainer 无法 traverse 的深层目录下。 */
export function workspaceTraversalRisk(workspaceRoot: string): string | undefined {
  const lowered = normalize(workspaceRoot).toLowerCase()
  for (const seg of BLOCKED_ANCESTOR_SEGMENTS) {
    if (lowered.includes(seg)) {
      return `workspace 位于 ${seg.trim()} 之下，AppContainer 无法 traverse 其祖先链，`
        + 'PowerShell 会报「当前目录无效」或「访问被拒绝」而根本不执行命令。'
        + '请把 workspace 放在浅层目录（如 C:\\prts-workspace）。'
    }
  }
  return undefined
}

/**
 * 生成受限 argv。纯函数——同样的输入永远得到同样的输出，便于测试与审计。
 *
 * @throws 参数非法或 workspace 落在不可 traverse 的路径下时抛错（fail-closed）。
 *   调用方必须在 catch 里把它转成「命令没执行」，绝不能降级成不受限地跑。
 */
export function confineArgv(argv: readonly string[], opts: ConfineOptions): ConfinedArgv {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('prts: confine 需要非空的 argv')
  }
  if (opts.mode !== 'read-only' && opts.mode !== 'workspace-write') {
    // danger-full-access 不该走到这里；真走到了说明上游策略解析错了。
    throw new Error(`prts: confine 不接受模式 ${String(opts.mode)}`)
  }
  if (typeof opts.workspaceRoot !== 'string' || !isAbsolute(opts.workspaceRoot)) {
    throw new Error('prts: confine 需要绝对的 workspaceRoot')
  }
  if (typeof opts.profile !== 'string' || opts.profile === '') {
    throw new Error('prts: confine 需要非空的 profile 名')
  }
  if (typeof opts.runnerPath !== 'string' || !isAbsolute(opts.runnerPath)) {
    throw new Error('prts: confine 需要绝对的 runnerPath')
  }

  const risk = workspaceTraversalRisk(opts.workspaceRoot)
  if (risk !== undefined) throw new Error(`prts: ${risk}`)

  const execPath = opts.execPath ?? process.execPath

  return {
    argv: [
      execPath,
      opts.runnerPath,
      '--profile', opts.profile,
      '--workspace', opts.workspaceRoot,
      // mode 必须透传：read-only 时 runner 建容器不授 workspace 写，
      // 否则「仅可查看」档下 shell 仍能写区内文件，档位名不副实。
      '--mode', opts.mode,
      // 必须走 inherit：DSH 的 shell 全部经 dsh-terminal-bash 的 PTY 启动，
      // 它在**启动 shell 进程时**调一次 confine，之后所有命令都在同一进程里跑。
      // 不带 --inherit 时 runner 用 capture 模式把子进程 stdio 接管到自己的管道，
      // PTY 那头看不到 shell 输出，直接判「PTY shell exited during startup」——
      // 真机实测过一次，模型三次调用全部撞在这上面。
      '--inherit',
      // 额外读权限目录，每个一项。用途：工具结果卸载的存储根——不给的话
      // 沙箱里的 shell 对 spill 文件 `Test-Path` 会返回 Access is denied（实测）。
      ...(opts.readPaths ?? []).flatMap((p) => ['--read-path', p]),
      '--',
      ...argv,
    ],
    // 文件效果能管住；网络默认关闭这一点没有逐项验证，边角（ADS/硬链接）没测。
    enforcement: 'partial',
    // 越界错误文本随系统语言变化，没有可靠的跨语言签名——留空，别做文本嗅探。
    denialSignatures: [],
    runnerFailureRules: [
      {
        allowedExitCodes: [RUNNER_EXIT_USAGE, RUNNER_EXIT_SOFTWARE],
        fatalSignatures: [RUNNER_FAILURE_PREFIX],
      },
    ],
  }
}

/** 只读模式目前与 workspace-write 同构（容器本身就不给写），保留参数以便将来收紧。 */
export function isConfinedMode(mode: string): mode is ConfinedMode {
  return mode === 'read-only' || mode === 'workspace-write'
}
