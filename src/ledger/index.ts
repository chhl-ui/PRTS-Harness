/**
 * K1 任务账本公共入口。
 *
 * ## 固定 actor 通道契约
 *
 * 以下方法的 actor 由库内固定（不接受调用方传入），属于所有者/系统通道：
 * `verify`（system/verifier）、`ownerAccept` / `ownerReject`（owner）、
 * `setBudget`（owner）、`stopByOwner`（system/stop）、`resumeFromStop`（owner）、
 * `chargeUsage`（system/budget）、`recoverOnStartup`（system/recovery）。
 *
 * 面向模型的工具适配层（K2）必须：
 *   1. 把传入的 actor 固定为 `{ kind: 'model', sessionId }`；
 *   2. 不暴露上述固定 actor 方法——它们不是模型可表达的路径。
 *
 * 本库按声明的 actor 执行权限矩阵，不验证 actor 的真实来源；
 * 来源真实性由宿主通道的不可伪造性保证。
 */
export { Ledger } from './ledger.ts'
export { LedgerError } from './errors.ts'
export { canonicalJson, eventHash, sha256hex, ZERO_HASH } from './canonical.ts'
export { applyEvent, usageExceeded } from './fold.ts'
export type { BudgetShape, UsageShape } from './fold.ts'
export type { LedgerErrorCode } from './errors.ts'
export type {
  Actor,
  AcceptanceSpec,
  BeginStepResult,
  Budget,
  CheckSpec,
  EvidenceRecord,
  LedgerEventRow,
  LedgerExportDoc,
  StepRecord,
  StepStatus,
  TaskId,
  TaskPhase,
  TaskRef,
  TaskSnapshot,
  Usage,
  VerifyChainResult,
} from './types.ts'
