/**
 * 模型后端 profile：桌面端在「DeepSeek 官方（1M）」与「本地 Strata（256K）」之间选。
 *
 * 为什么是「切 profile + 重启」而不是热切：`dsh-llm-deepseek-api-key` 把 provider id
 * 硬编码为 `deepseek-official`（`lib/index.js:47`），同一进程注册两个会互相覆盖；
 * 上下文窗口也是启动期求值（`config/prts.yml:20` + `start.ts:1027`，`agentOptions`
 * 里没有该字段）。所以这里只负责「选中哪个预设」与「预设怎么变 env」，不碰运行时。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ModelProfileId = 'deepseek' | 'strata'

export interface ModelProfile {
  id: ModelProfileId
  label: string
  /** `''` = 用适配器内置的官方端点（不设 `DEEPSEEK_BASE_URL`）。 */
  baseUrl: string
  /** `''` = 不覆盖模型名（适配器默认）。 */
  model: string
  contextWindow: number
  /** 相对 dataRoot 的 key 文件；`''` 表示只走凭据管理器/环境变量。 */
  keyFile: string
  /** 本地后端不校验真 key，写一个占位值即可；`''` 表示不设。 */
  placeholderKey: string
}

/**
 * 两个预设。
 *
 * **Strata 的 262144 来自博士口述（「256 上下文」按 256K 理解）**，而
 * `docs/v1-02-second-provider-strata-2026-11-05.md` 的实测用的是 `DSH_CONTEXT_WINDOW=32768`。
 * 两者不一致：若本地模型真实窗口小于 262144，装配会按 256K 算预算、再被上游静默截断
 * （`HANDOFF-202605-session-g` 记过这个坑）。所以 profile 文件可覆盖该值——
 * 以实测为准，不要把这个默认值当成已知事实。
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方（1M 上下文）',
    baseUrl: '',
    model: '',
    contextWindow: 1_000_000,
    keyFile: 'secrets/deepseek.key',
    placeholderKey: '',
  },
  {
    id: 'strata',
    label: '本地 Strata（256K 上下文）',
    baseUrl: 'http://127.0.0.1:8080',
    model: 'qwen3.8-flash-next-iq3_xxs',
    contextWindow: 262_144,
    keyFile: '',
    placeholderKey: 'strata-local',
  },
]

export const DEFAULT_PROFILE_ID: ModelProfileId = 'deepseek'

/** 文件名（写在数据根下，与 `terminal.endpoint` 同级）。 */
export const MODEL_PROFILE_FILE = 'model-profile.json'

/** 磁盘上的形状；只存 id 与被覆盖的字段，预设本体仍在代码里。 */
interface StoredProfile {
  profile?: unknown
  contextWindow?: unknown
}

export function listProfiles(): readonly ModelProfile[] {
  return MODEL_PROFILES
}

/** 按 id 取预设；未知/非字符串一律回落默认，不抛。 */
export function resolveProfile(id: unknown): ModelProfile {
  const hit = MODEL_PROFILES.find((p) => p.id === id)
  return hit ?? (MODEL_PROFILES.find((p) => p.id === DEFAULT_PROFILE_ID) as ModelProfile)
}

/**
 * 读当前选择。文件不存在、坏 JSON、未知 id **一律回落默认**——
 * 一个选错的 profile 不该让系统起不来。
 */
export function readProfile(dataRoot: string): ModelProfile {
  let stored: StoredProfile
  try {
    stored = JSON.parse(readFileSync(join(dataRoot, MODEL_PROFILE_FILE), 'utf8')) as StoredProfile
  } catch {
    return resolveProfile(DEFAULT_PROFILE_ID)
  }
  const base = resolveProfile(stored.profile)
  const window = stored.contextWindow
  // 只在合法正整数的前提下覆盖；非法值忽略而不是回落成 0（0 会让装配预算归零）。
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
    return { ...base, contextWindow: Math.floor(window) }
  }
  return base
}

/**
 * 只在 profile 文件**存在**时返回选择；不存在返回 `undefined`。
 *
 * 与 `readProfile` 的分工：后者回答「该用哪个预设」（总是有答案，供桌面端展示），
 * 前者回答「该不该接管环境变量」。没有这个区分的话，手动启动（不写 profile 文件、
 * 直接用 `DEEPSEEK_BASE_URL` 等环境变量）会被默默按默认预设覆盖，把本地调试打穿。
 */
export function readProfileIfPresent(dataRoot: string): ModelProfile | undefined {
  try {
    readFileSync(join(dataRoot, MODEL_PROFILE_FILE), 'utf8')
  } catch {
    return undefined
  }
  return readProfile(dataRoot)
}

/** 写入选择（原子：写 .tmp 再 rename）。非法 id 抛错——写入路径要大声失败。 */
export function writeProfile(dataRoot: string, id: unknown, contextWindow?: number): ModelProfile {
  if (typeof id !== 'string' || !MODEL_PROFILES.some((p) => p.id === id)) {
    throw new Error(`未知的模型预设：${String(id)}`)
  }
  const profile = resolveProfile(id)
  const next: StoredProfile = { profile: profile.id }
  if (contextWindow !== undefined) {
    if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
      throw new Error(`上下文窗口必须是正整数：${String(contextWindow)}`)
    }
    next.contextWindow = Math.floor(contextWindow)
  }
  mkdirSync(dataRoot, { recursive: true })
  const target = join(dataRoot, MODEL_PROFILE_FILE)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, target)
  return readProfile(dataRoot)
}

/**
 * 把预设翻译成环境变量变更。**返回值是纯数据**——调用方决定怎么应用，
 * 测试也就不需要动 `process.env`。
 *
 * 两种「没有」要分开：
 * - 值为 `undefined` = 明确要求**清掉**该变量（切回官方时 baseURL / 模型名必须清，
 *   否则会残留上一套本地端点，把请求发到已经关掉的本地服务）；
 * - 键**不出现** = 不要动它（`DEEPSEEK_API_KEY` 属于这类：官方走凭据管理器，
 *   但用户手动 export 的 key 不该被一个预设选择清掉）。
 */
export function profileEnv(p: ModelProfile): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    DEEPSEEK_BASE_URL: p.baseUrl === '' ? undefined : p.baseUrl,
    PRTS_LLM_MODEL: p.model === '' ? undefined : p.model,
    DSH_CONTEXT_WINDOW: String(p.contextWindow),
  }
  if (p.placeholderKey !== '') env.DEEPSEEK_API_KEY = p.placeholderKey
  return env
}
