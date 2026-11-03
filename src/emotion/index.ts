/** 情感模块（架构需求 §7 V1-05）：模块入口。 */
export { EmotionStore, DEFAULT_HALF_LIFE_MS } from './store.ts'
export type { EmotionStoreOptions } from './store.ts'
export { applyEmotionEvent } from './fold.ts'
export type { EmotionEventInput } from './fold.ts'
export { openEmotionDb } from './schema.ts'
export type {
  EmotionActor,
  EmotionEventKind,
  EmotionEventRow,
  EmotionState,
  EmotionUpdateInput,
} from './types.ts'
