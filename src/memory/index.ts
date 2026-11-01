/** 记忆模块入口。设计见 `docs/design-memory-v1.md`。 */
export { MemoryStore, escapeLike } from './store.ts'
export { SCHEMA, openMemoryDb } from './schema.ts'
export { applyMemoryEvent } from './fold.ts'
export { parseTime } from './time.ts'
export { tokenize } from './tokenize.ts'
export {
  OllamaEmbedder, cosineSimilarity, decodeVector, encodeVector, type Embedder,
} from './embedding.ts'
export { extractEntities, normalizeKey, type EntityKind, type ExtractedEntity } from './extract.ts'
export {
  consolidationStats, readConsolidationCursor, runConsolidation,
  type ConsolidateOptions, type ConsolidateResult,
} from './consolidate.ts'
export type {
  ActorKind,
  AssertFactInput,
  ConfirmationBasis,
  MemoryEventKind,
  MemoryEventRow,
  MemoryHit,
  MemoryQuery,
  Origin,
  Provenance,
  RecallPath,
  RetentionClass,
} from './types.ts'
