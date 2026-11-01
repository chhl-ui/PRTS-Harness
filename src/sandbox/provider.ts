/**
 * `SandboxProvider` 实现：把 PRTS 的 shell 执行接到 AppContainer 上。
 *
 * ## 它站在哪
 *
 * `dsh-sandbox` 的 `SandboxProvider` 继承 cordis 的 `Service`，构造时
 * `super(ctx, 'sandbox')` 即注册为 `ctx.sandbox`。DSH 的 shell 工具通过
 * `ctx.sandbox.confine(argv, policy)` 拿到「该 spawn 什么」，所以替换这个服务
 * 就等于换掉了整个 shell 的受限方式。
 *
 * **注意它和 `dsh-sandbox-local` 互斥**：两者都想注册成 `ctx.sandbox`。启用本
 * provider 必须在组合配置里禁用 `sandbox-local`，否则是两个服务抢同一个名字。
 *
 * ## 这一层只做委托
 *
 * 真正的包装逻辑在 `confine.ts`（纯函数、可独立测试）。这里加三件事：
 * 1. 提前响应取消信号；
 * 2. 拒绝 `danger-full-access`——它不该被 confine 处理，真走到这里说明上游
 *    策略解析出了问题，静默放行会变成「以为有沙箱其实没有」；
 * 3. 把抛错转成 `SandboxUnavailableError`，让调用方拿到结构化的
 *    `SANDBOX_UNAVAILABLE` 而不是一条普通异常——失败必须是可识别的失败。
 */
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'
import { confineArgv } from './confine.ts'

export interface AppContainerProviderOptions {
  /** AppContainer profile 名。同名复用；建议按部署固定。 */
  profile: string
  /** runner 脚本绝对路径（`src/sandbox/runner.ts` 的位置）。 */
  runnerPath: string
  /**
   * 需要额外授予读权限的目录。
   *
   * 当前唯一用途：spill 存储根。不给的话 AppContainer 里的 shell 对 spill 文件
   * `Test-Path` 返回 Access is denied——卸载了却读不回来，等于没卸载。
   */
  readPaths?: readonly string[]
}

export class AppContainerSandboxProvider extends SandboxProvider {
  /**
   * 用 TS 的 `private` 而不是 `#` 真私有字段：cordis 的 `Service` 会把实例包在
   * Proxy 里，`#` 字段在 Proxy 上读不到（实测报 "Cannot read private member
   * #opts from an object whose class did not declare it"）。`private` 是编译期
   * 修饰符，运行时就是普通属性，跨 Proxy 安全。
   */
  private readonly opts: AppContainerProviderOptions

  constructor(ctx: Context, opts: AppContainerProviderOptions) {
    super(ctx)
    this.opts = opts
  }

  async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    signal?.throwIfAborted()

    if (policy.mode !== 'read-only' && policy.mode !== 'workspace-write') {
      // danger-full-access 不该由 confine 承载。抛结构化错误而不是放行：
      // 放行会得到「以为在沙箱里、其实没有」——比直接失败危险得多。
      throw new SandboxUnavailableError(
        'workspace-write',
        `AppContainer provider 不能以 ${String(policy.mode)} 模式执行；该模式应绕过沙箱而非经过 confine`,
      )
    }

    try {
      return confineArgv(argv, {
        mode: policy.mode,
        workspaceRoot: policy.workspaceRoot,
        profile: this.opts.profile,
        runnerPath: this.opts.runnerPath,
        readPaths: this.opts.readPaths,
      })
    } catch (error) {
      // 把内部错误统一成 SANDBOX_UNAVAILABLE：调用方能据此区分
      // 「沙箱没配好」与「命令执行失败」，而不是拿一条普通异常去猜。
      throw new SandboxUnavailableError(
        policy.mode,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
