/**
 * 测试共用的运行时组装常量。
 *
 * 存在的理由：`terminal-pipe.test.ts` 要证明「审批在新入口下依然可达」，而这条
 * 可达性依赖组装参数与既有审批用例逐项相同（同一个 config、同一组 patches）。
 * 靠人读代码比对两个文件是维持不住的——任何一边改了参数，另一边的测试仍会绿，
 * 只是它测的已经不是同一个组合了。所以抽到一处，两边共同 import。
 *
 * 消费者：test/runtime/e3-approval.test.ts、test/runtime/terminal-pipe.test.ts。
 */
import { fileURLToPath } from 'node:url'

/** 真实组合配置：与 `npm run chat` 用的是同一份 `config/prts.yml`。 */
export const prtsYml = fileURLToPath(new URL('../../config/prts.yml', import.meta.url))

/**
 * 禁用真实 deepseek 适配器，由 `test/support/scripted-llm.ts` 接管。
 * 审批与管道用例都不该打真 key，也不该依赖网络。
 */
export const PATCHES: unknown[] = [{ id: 'llm-deepseek', disabled: true }]
