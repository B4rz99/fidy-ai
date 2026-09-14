import { pairingExpiryQueue } from "~/shell/email-authentication/pairing-email-execution";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported browser-pairing expiry queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: pairingExpiryQueue.definition,
  identityFields: ["workflowId"],
  userFields: ["userId"],
});
