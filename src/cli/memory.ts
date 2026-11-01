/**
 * prts memory：记忆库的运维入口。
 *
 * 存在的理由：巩固、退役、恢复这三件事此前只被 `.rivet/scratch/` 的探针调用，
 * 生产链路上没有任何触发点——`mem_facts` 因此长期为 0，生命周期那套机制空转。
 * 它们不适合做成模型工具（可能跑几十秒、会改检索可见性），所以落在 CLI：
 * 由人决定何时跑、跑多少、要不要真写。
 *
 * 用法：
 *   node src/cli/prts.ts memory stats      [--db <path>]
 *   node src/cli/prts.ts memory consolidate [--db <path>]
 *   node src/cli/prts.ts memory retire     [--db <path>] [--limit N] [--floor F] [--min-age-days D] [--apply]
 *   node src/cli/prts.ts memory restore <factId...> [--db <path>]
 *
 * 库路径优先级与运行时一致：`--db` > `PRTS_MEMORY_DB` > `<PRTS_DATA_ROOT>/memory.sqlite`。
 */
import { join } from 'node:path'
import { MemoryStore } from '../memory/index.ts'

const USAGE = `usage:
  prts memory stats      [--db <path>]
  prts memory consolidate [--db <path>]
  prts memory retire     [--db <path>] [--limit N] [--floor F] [--min-age-days D] [--apply]
  prts memory restore <factId...> [--db <path>]`

/** 与 `prts.ts` 同构的最小参数解析：带值 flag 取下一个元素，不做 `--k=v` 形式。 */
function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function numArg(args: string[], name: string): number | undefined {
  const raw = arg(args, name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** 位置参数：排除所有 `--flag` 及其取值（`--db` 单独处理，它的值不是 factId）。 */
function positional(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a.startsWith('--')) {
      // 带值 flag：跳过它的值。这里只列本命令会出现的带值 flag；
      // 新增带值 flag 时同步加进来，否则它的值会被当成 factId。
      if (a === '--db' || a === '--limit' || a === '--floor' || a === '--min-age-days') i++
      continue
    }
    out.push(a)
  }
  return out
}

function resolveDbPath(args: string[]): string | undefined {
  const explicit = arg(args, '--db')
  if (explicit !== undefined) return explicit
  if (process.env.PRTS_MEMORY_DB !== undefined && process.env.PRTS_MEMORY_DB !== '') {
    return process.env.PRTS_MEMORY_DB
  }
  const dataRoot = process.env.PRTS_DATA_ROOT
  if (dataRoot === undefined || dataRoot === '') return undefined
  return join(dataRoot, 'memory.sqlite')
}

function stats(store: MemoryStore): number {
  const life = store.lifecycleStats()
  const cons = store.consolidationStats()
  const lines = [
    `live=${life.live}`,
    `retired=${life.retired}`,
    `deleted=${life.deleted}`,
    `permanent_live=${life.permanentLive}`,
    `consolidation_cursor=${cons.cursor}`,
    `consolidation_max_rowid=${cons.maxRowid}`,
    `entities=${cons.entities}`,
    `links=${cons.links}`,
    `topics=${cons.topics}`,
    `mentions=${cons.mentions}`,
    `profiles=${store.countProfiles()}`,
    `summaries=${store.countSummaries()}`,
  ]
  if (life.nearestCandidate !== null) {
    const c = life.nearestCandidate
    lines.push(`nearest_candidate=${c.factId} effective=${c.effective.toFixed(4)} age_days=${c.ageDays.toFixed(1)}`)
  }
  console.log(lines.join('\n'))
  return 0
}

function consolidate(store: MemoryStore): number {
  // 不跟 `--limit`：ConsolidateOptions 的预算语义由库内决定（分批 + 可取消），
  // CLI 只负责触发一轮。要跑全库就重复调用，直到输出里的 stop 不再是 budget。
  const result = store.consolidateRules()
  console.log(JSON.stringify(result))
  return 0
}

function retire(store: MemoryStore, args: string[]): number {
  const apply = args.includes('--apply')
  const limit = numArg(args, '--limit')
  const floor = numArg(args, '--floor')
  const minAgeDays = numArg(args, '--min-age-days')
  const result = store.retireFacts({
    ...(limit === undefined ? {} : { limit }),
    ...(floor === undefined ? {} : { floor }),
    ...(minAgeDays === undefined ? {} : { minAgeDays }),
    dryRun: !apply,
  })
  console.log(`scanned=${result.scanned} candidates=${result.candidates.length} retired=${result.retired.length}${apply ? '' : ' (dry-run，加 --apply 才写库)'}`)
  for (const c of result.candidates.slice(0, 5)) {
    console.log(`  ${c.factId} effective=${c.effective.toFixed(4)} age_days=${c.ageDays.toFixed(1)}`)
  }
  if (result.candidates.length > 5) console.log(`  …其余 ${result.candidates.length - 5} 条省略`)
  return 0
}

function restore(store: MemoryStore, args: string[]): number {
  // 跳过 args[0]（子命令名本身），否则它会被当成一个 factId，
  // 症状是「没有给 id」时也返回 0。
  const ids = positional(args.slice(1))
  if (ids.length === 0) {
    console.error('prts memory restore: 需要至少一个 factId')
    console.error(USAGE)
    return 2
  }
  const n = store.restoreFacts({ actor: 'owner', factIds: ids, reason: 'cli-restore' })
  console.log(`restored=${n} requested=${ids.length}`)
  return 0
}

/**
 * 子命令入口。返回退出码而不调用 `process.exit`——测试要能直接调它，
 * 退出码由 `prts.ts` 的顶层统一处理（与 `upgrade` 同构）。
 */
export function memoryCommand(args: string[]): number {
  const sub = args[0]
  if (sub === undefined) {
    console.error(USAGE)
    return 2
  }
  const dbPath = resolveDbPath(args)
  if (dbPath === undefined) {
    console.error('prts memory: 无法确定记忆库路径——传 --db，或设置 PRTS_MEMORY_DB / PRTS_DATA_ROOT')
    return 2
  }

  let store: MemoryStore | undefined
  try {
    store = MemoryStore.open(dbPath)
    switch (sub) {
      case 'stats': return stats(store)
      case 'consolidate': return consolidate(store)
      case 'retire': return retire(store, args)
      case 'restore': return restore(store, args)
      default:
        console.error(`prts memory: 未知子命令 ${sub}`)
        console.error(USAGE)
        return 2
    }
  } catch (e) {
    console.error(`prts memory ${sub} 失败: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    store?.close()
  }
}
