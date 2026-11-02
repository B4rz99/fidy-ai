import { Effect } from "effect";
import { HostedInference } from "../../../src/shell/hosted-inference/operations";
import type { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { memoryOperationIds } from "../../../src/shell/memory/contract";

/** Memory owns capacity counting; other canonical owners never acquire hosted inference. */
export const canonicalOperationRequiresInference = (operation: CanonicalOperationId): boolean =>
  memoryOperationIds.some((declared) => declared === operation);

export const unreachableHostedInference = HostedInference.of({
  countText: () => Effect.die("Hosted inference reached without Memory work"),
  countTranscript: () => Effect.die("Hosted inference reached without Memory work"),
  prepareText: () => Effect.die("Hosted inference reached without Memory work"),
  validateText: () => Effect.die("Hosted inference reached without Memory work"),
  prepareStructured: () => Effect.die("Hosted inference reached without Memory work"),
});
