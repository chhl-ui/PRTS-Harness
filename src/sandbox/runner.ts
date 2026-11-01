/**
 * AppContainer runner：把沙箱包装成 DSH 能用的可执行入口。
 *
 * ## 为什么需要它
 *
 * `dsh-sandbox` 的 `SandboxProvider.confine()` 返回 `ConfinedArgv`：一段
 * 「runner + profile + 分隔符 + 调用方 argv」的命令行，由上层用普通
 * `child_process` 启动（`dsh-sandbox/lib/types/index.d.ts`）。AppContainer 不是
 * argv 包装——它要在父进程里 `CreateProcessW` 并传
 * `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`——所以必须有个 runner 程序站在这层
 * 间接后面，自己建容器。
 *
 * ## 协议
 *
 * ```
 * node runner.ts --profile <名称> --workspace <路径> -- <命令> [参数...]
 * ```
 *
 * - 子进程的 stdout 与 stderr 合并写入本进程的 stdout（见 appcontainer.ts 的说明：
 *   分开读两个管道会在写满时双死锁）。
 * - 子进程退出码**原样透传**。调用方据此区分成功与失败。
 * - 本进程自身的失败用 sysexits 风格：64 = 用法错误，70 = 内部错误。
 *   **失败绝不返回 0**——静默成功会让上游把「沙箱没起来」当成「命令跑完了」。
 *
 * ## 已知成本
 *
 * 每次调用都会建容器再销毁：空工作区上实测 create 约 10ms、runner 进程启动约 80ms。
 * 工作区很大时 `icacls` 的递归授权会显著变慢（`dsh-sandbox-windows-acl` 的 README
 * 记着大树上可达数十秒），届时需要「profile 与 ACL 复用」的优化，而不是每次全树走一遍。
 */
import { createAppContainer } from './appcontainer.ts'
import { parseRunnerArgv } from './runner-args.ts'

/** 用法错误。 */
const EX_USAGE = 64
/** 内部错误（建容器失败、启动失败等）。 */
const EX_SOFTWARE = 70

async function main(): Promise<number> {
  const { profile, workspace, inherit, command, readPaths } = parseRunnerArgv(process.argv.slice(2))
  if (profile === undefined || profile === '') {
    console.error('prts runner: 缺少 --profile')
    return EX_USAGE
  }
  if (workspace === undefined || workspace === '') {
    console.error('prts runner: 缺少 --workspace')
    return EX_USAGE
  }
  if (command.length === 0) {
    console.error('prts runner: -- 之后没有命令')
    return EX_USAGE
  }

  let box
  try {
    box = await createAppContainer({ name: profile, workspace, extraReadPaths: readPaths })
    // cwd 必须显式设到已授权的工作区。不设的话子进程继承 runner 的当前目录
    // （通常是仓库根，AppContainer 对它没有 traverse），PowerShell 会直接
    // 报「当前目录无效」而根本不执行命令——cmd 不敏感，pwsh 敏感，很容易漏测。
    const child = box.spawn({
      command: command[0],
      args: command.slice(1),
      cwd: workspace,
      // 持久 shell（PTY）用 --inherit：子进程直接继承 PTY 的 slave 端，双向交互；
      // 此时 output 恒为空，输出归调用方的 PTY。默认 capture 模式自建管道。
      inheritStdio: inherit,
    })
    const result = await child.wait()
    process.stdout.write(result.output)
    return result.exitCode
  } catch (error) {
    // 建容器或启动失败：必须可读、必须非零。上游靠 stderr 区分
    // 「沙箱没起来」与「命令跑完但失败」。
    console.error(`prts runner: ${error instanceof Error ? error.message : String(error)}`)
    return EX_SOFTWARE
  } finally {
    if (box !== undefined) {
      try { await box.dispose() } catch { /* 清理失败不改变已有结论 */ }
    }
  }
}

process.exitCode = await main()
