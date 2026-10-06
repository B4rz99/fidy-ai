import type { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { memoryOperationIds } from "../../../src/shell/memory/contract";

/** Memory owns capacity counting; other canonical owners never acquire hosted inference. */
export const canonicalOperationRequiresInference = (operation: CanonicalOperationId): boolean =>
  memoryOperationIds.some((declared) => declared === operation);
