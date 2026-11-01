/** 记忆模块入口。设计见 `docs/design-memory-v1.md`。 */
export { MemoryStore, escapeLike } from './store.ts'
export { SCHEMA, openMemoryDb } from './schema.ts'
export { applyMemoryEvent } from './fold.ts'
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
