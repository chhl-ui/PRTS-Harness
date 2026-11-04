/** V1-07 主动回忆入口。设计见 `docs/` 下的 V1-07 条目与 `src/proactive/store.ts` 头部。 */
export { openProactiveStore, DEFAULT_COOLDOWN_MS } from './store.ts'
export type {
  ProactiveKind,
  ProactiveListQuery,
  ProactiveMention,
  ProactiveRecordInput,
  ProactiveStore,
} from './types.ts'
