/** Published canonical catalog and access decision shared by Worker routing and agent execution. */
export { operationCatalog } from "./api";
export { decideOperationAccess } from "~/shell/_shared/operation-policy";
export type { CatalogOperation } from "~/shell/_shared/operation-catalog";
export { CanonicalCapability, CanonicalOperationId } from "~/core/canonical-operations/contract";
export { patScopeCapability } from "~/shell/_shared/operation-policy";
export { grantsRequiredTier } from "~/shell/_shared/suggested-operations";
export { ErrorCode } from "~/shell/public-http/contract";
export {
  AtomicBatchCallId,
  AtomicBatchRejected,
  atomicBatchChildOperations,
  atomicBatchOperation,
  decodeAtomicBatchResult,
  getAtomicBatchCallSchema,
  getAtomicBatchChildIds,
  maximumAtomicBatchCalls,
} from "~/shell/operations/operations";
export type { AtomicBatchCall } from "~/shell/operations/operations";
/** Canonical input codecs stay owned by the operation module that declares them. */
export {
  CreateTransactionCanonicalInput,
  LinkTransactionsCanonicalInput,
  UnlinkTransactionsCanonicalInput,
  UpdateTransactionCanonicalInput,
} from "~/shell/transactions/operations";
export { SubmitForExtractionCanonicalInput } from "~/shell/ingestion/operations";
