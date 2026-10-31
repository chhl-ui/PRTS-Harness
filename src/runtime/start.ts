/** 运行时组装：boot('prts', configPath, patches, prepare) + 最小 credentials 服务。 */
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { Context } from '@deepseek-ai/cordis'
import { attachErrorReporter } from './error-report.ts'

export interface StartRuntimeOptions {
  configPath: string
  dataRoot: string
  workspace: string
  mode: 'normal' | 'read-only'
  /** cordis-plugin-include 的 PatchOptions（overlay 禁用/追加条目）。 */
  patches?: unknown[]
  /** 内存中的密钥（不落 env）；resolve(ref) 按需返回。 */
  credentials?: { DEEPSEEK_API_KEY?: string }
}

const createAppReady = () => {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener: () => void) {
        if (ready) { listener(); return () => {} }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const l of listeners) l()
      listeners.clear()
    },
  }
}

export async function startRuntime(o: StartRuntimeOptions): Promise<{ ctx: Context; dispose(): Promise<void> }> {
  process.env.DSH_HOME = join(o.dataRoot, 'dsh-home')
  process.env.PRTS_WORKSPACE = o.workspace
  const appReady = createAppReady()
  const ctx = await boot('prts', o.configPath, (o.patches ?? []) as never, async (hostCtx: Context) => {
    provideCmdline(hostCtx as never, {
      args: [],
      exit: (code: number) => {
        void (async () => {
          try { await (hostCtx as { fiber?: { dispose(): Promise<void> } }).fiber?.dispose() } finally { process.exit(code) }
        })()
      },
      ready: appReady.service,
    })
    // 最小 credentials：只实现 resolve(ref)。credentialRef() 返回品牌字符串
    // （dsh-credentials lib:21），ref 即 'DEEPSEEK_API_KEY' 本身。
    hostCtx.provide('credentials', {
      resolve: (ref: string) =>
        ref === 'DEEPSEEK_API_KEY' && o.credentials?.DEEPSEEK_API_KEY
          ? { value: o.credentials.DEEPSEEK_API_KEY }
          : undefined,
    })
  })
  // turn 内失败只经 agent/error 上报：dsh-agent-loop 的 throwError() emit 后 throw，
  // kick() 的 catch 吞掉异常传播。不订阅则失败完全静默。
  const detachErrorReporter = attachErrorReporter(ctx)
  if (ctx.get('loader') !== undefined) appReady.commit()
  return {
    ctx,
    dispose: async () => {
      detachErrorReporter()
      await ctx.fiber.dispose()
    },
  }
}
