/** Published canonical catalog and access decision shared by Worker routing and agent execution. */
export { operationCatalog } from "./api";
export { decideOperationAccess } from "~/shell/_shared/operation-policy";
export type { CatalogOperation } from "~/shell/_shared/operation-catalog";
export { CanonicalCapability, CanonicalOperationId } from "~/core/canonical-operations/contract";
export { patScopeCapability } from "~/shell/_shared/operation-policy";
export { grantsRequiredTier } from "~/shell/_shared/suggested-operations";
export {
  AtomicBatchRejected,
  atomicBatchOperation,
  decodeAtomicBatchResult,
  getAtomicBatchInputSchema,
  maximumAtomicBatchCalls,
} from "~/shell/operations/operations";
export type { AtomicBatchCall } from "~/shell/operations/operations";
