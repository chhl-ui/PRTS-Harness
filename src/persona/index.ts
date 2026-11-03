/** 人格模块（架构需求 §7 V1-09 / V1-04 / V1-05 的底座）：模块入口。 */
export { PersonaStore } from './store.ts'
export { applyPersonaEvent } from './fold.ts'
export type { PersonaEventInput } from './fold.ts'
export { openPersonaDb } from './schema.ts'
export type {
  PersonaActor,
  PersonaCoreChange,
  PersonaDefineInput,
  PersonaEventKind,
  PersonaEventRow,
  PersonaPreset,
  PersonaRef,
} from './types.ts'
