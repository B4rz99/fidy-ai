import { pairingStartQueue } from "~/shell/email-authentication/pairing-email-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported browser-pairing start queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: pairingStartQueue.definition,
  identityFields: ["requestId"],
  userFields: [],
});
