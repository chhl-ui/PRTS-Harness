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
import { MemoryStore, findForOwner, forgetFlow, correctFlow, type VectorOwnerKind } from '../memory/index.ts'
import { AuditLog } from '../audit/audit.ts'
import { OllamaEmbedder } from '../memory/embedding.ts'
import { OllamaGenerator } from '../memory/generate.ts'

const USAGE = `usage:
  prts memory stats      [--db <path>]
  prts memory consolidate [--db <path>]
  prts memory retire     [--db <path>] [--limit N] [--floor F] [--min-age-days D] [--apply]
  prts memory restore <factId...> [--db <path>]
  prts memory find --query <text> [--db <path>]
  prts memory forget --id <id,...> [--yes] [--db <path>]
  prts memory correct --fact <id> --object <text> [--db <path>]
  prts memory extract-facts [--db <path>] [--limit N] [--batch N] [--model M] [--ollama URL] --apply
  prts memory embed        [--db <path>] [--kinds turn,fact,profile] [--limit N] [--model M] [--ollama URL] --apply`

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
 * 模型层事实抽取：把 live turn 抽成 mem_facts。
 *
 * 单独导出而不是塞进 `memoryCommand`：它要调模型（异步），而其余子命令是同步的。
 * 为了让同步入口保持同步（既有的 6 个 CLI 测试因此不用改成 async），在 `prts.ts`
 * 的顶层按子命令名分流到本函数。
 *
 * 默认**不调用模型**：只报「将要处理多少条」。抽一条 turn 就要一次推理，
 * 让人在知道规模之后再显式加 `--apply`，比默认开跑更省事。
 */
export async function memoryExtractFacts(args: string[]): Promise<number> {
  const dbPath = resolveDbPath(args)
  if (dbPath === undefined) {
    console.error('prts memory: 无法确定记忆库路径——传 --db，或设置 PRTS_MEMORY_DB / PRTS_DATA_ROOT')
    return 2
  }
  const apply = args.includes('--apply')
  const limit = numArg(args, '--limit') ?? 200
  const batchSize = numArg(args, '--batch') ?? 20
  const model = arg(args, '--model')
  const baseUrl = arg(args, '--ollama')

  let store: MemoryStore | undefined
  try {
    store = MemoryStore.open(dbPath)
    if (!apply) {
      console.log(`将处理最多 ${limit} 条 live turn（每批 ${batchSize} 条一次推理），模型 ${model ?? 'q38-gsq-iq3s'}`)
      console.log('加 --apply 才会真正调用模型并写库。本地 Ollama 零 API 成本，但每条 turn 都要推理时间。')
      return 0
    }
    const generator = new OllamaGenerator({
      ...(model === undefined ? {} : { model }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    })
    const result = await store.consolidateFacts({ generator, limit, batchSize })
    console.log(JSON.stringify(result))
    return 0
  } catch (e) {
    console.error(`prts memory extract-facts 失败: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    store?.close()
  }
}

/**
 * 子命令入口。返回退出码而不调用 `process.exit`——测试要能直接调它，
 * 退出码由 `prts.ts` 的顶层统一处理（与 `upgrade` 同构）。
 *
 * `extract-facts` 不在这个 switch 里：它要调模型（异步），由 `memoryExtractFacts`
 * 承担，`prts.ts` 按子命令名分流。
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
      case 'find': return find(store, args)
      case 'forget': return forget(store, args)
      case 'correct': return correct(store, args)
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

/**
 * 子命令 embed：给记忆补向量。
 *
 * 与 `extract-facts` 同构——默认只报计划，`--apply` 才真跑。区别是默认 kinds 是 `turn`：
 * turn 是 24.6 万级主检索对象（约 44 分钟本地推理），必须由人显式发起，不能挂在启动路径
 * 或例行巩固上。分片规模用 `--limit` 控制；幂等（已补齐的不会被重选），可断点续跑。
 */
export async function memoryEmbedVectors(args: string[]): Promise<number> {
  const dbPath = resolveDbPath(args)
  if (dbPath === undefined) {
    console.error('prts memory: 无法确定记忆库路径——传 --db，或设置 PRTS_MEMORY_DB / PRTS_DATA_ROOT')
    return 2
  }
  const apply = args.includes('--apply')
  const limit = numArg(args, '--limit') ?? 200
  const model = arg(args, '--model')
  const baseUrl = arg(args, '--ollama')
  const kindsArg = arg(args, '--kinds') ?? 'turn'
  const valid: VectorOwnerKind[] = ['fact', 'profile', 'turn']
  const kinds = kindsArg.split(',').map((s) => s.trim()).filter((s) => s !== '') as VectorOwnerKind[]
  if (kinds.length === 0 || kinds.some((k) => !valid.includes(k))) {
    console.error(`prts memory embed: --kinds 只接受 ${valid.join(',')}，收到 "${kindsArg}"`)
    return 2
  }

  let store: MemoryStore | undefined
  try {
    store = MemoryStore.open(dbPath)
    const embedder = new OllamaEmbedder({
      ...(model === undefined ? {} : { model }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    })
    if (!apply) {
      console.log(`将给最多 ${limit} 条 ${kinds.join(',')} 补向量，模型 ${embedder.model}`)
      console.log('加 --apply 才会真正调用 embedder 并写库。')
      console.log('提示：turn 全量约 24.6 万条、本地 bge-m3 约 44 分钟；分片跑用 --limit 控制单次规模。')
      return 0
    }
    const result = await store.embedPending({ embedder, limit, kinds })
    console.log(JSON.stringify(result))
    return 0
  } catch (e) {
    console.error(`prts memory embed 失败: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    store?.close()
  }
}


/** 所有者找回：带退役行（找回「淡忘的东西」）。 */
function find(store: MemoryStore, args: string[]): number {
  const q = arg(args, '--query')
  if (q === undefined) { console.error('prts memory find: 需要 --query <text>'); return 2 }
  const hits = findForOwner(store, q)
  if (hits.length === 0) { console.log('无命中'); return 0 }
  for (const h of hits) console.log(`${h.id}	${h.kind}	${h.time ?? '时间未知'}	${h.text}`)
  return 0
}

/** 所有者删除：--yes 才执行；K4 记账需要 PRTS_DATA_ROOT。 */
function forget(store: MemoryStore, args: string[]): number {
  const raw = arg(args, '--id')
  if (raw === undefined) { console.error('prts memory forget: 需要 --id <id,...>'); return 2 }
  const ids = raw.split(',').map(s => s.trim()).filter(s => s !== '')
  const yes = args.includes('--yes')
  const dataRoot = process.env.PRTS_DATA_ROOT
  let audit: AuditLog | undefined
  if (yes) {
    if (dataRoot === undefined) {
      console.error('prts memory forget --yes: 需要 PRTS_DATA_ROOT（定位 core.sqlite 与会话日志）')
      return 2
    }
    audit = AuditLog.open(process.env.PRTS_DB ?? join(dataRoot, 'core.sqlite'))
  }
  try {
    const r = forgetFlow({
      store, audit,
      sessionsRoot: dataRoot === undefined ? undefined : join(dataRoot, 'dsh-home', 'sessions'),
      ids, confirm: yes,
    })
    console.log(r.message)
    return r.ok ? (yes ? 0 : 2) : 2
  } finally { audit?.close() }
}

/** 所有者纠正：新值顶替旧值，旧值可逆找回。 */
function correct(store: MemoryStore, args: string[]): number {
  const id = arg(args, '--fact'); const obj = arg(args, '--object')
  if (id === undefined || obj === undefined) { console.error('prts memory correct: 需要 --fact <id> --object <text>'); return 2 }
  const r = correctFlow({ store, factId: id, object: obj })
  console.log(r.message)
  return r.ok ? 0 : 2
}
