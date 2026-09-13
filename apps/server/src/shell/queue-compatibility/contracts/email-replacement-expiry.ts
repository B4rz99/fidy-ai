import { replacementExpiryQueue } from "~/shell/email-authentication/replacement-protocol";
import { defineQueueCompatibilityContract } from "~/shell/queue-compatibility/contracts";

/** Oldest supported email-replacement expiry queue encoding. */
export const queueCompatibilityContract = defineQueueCompatibilityContract({
  definition: replacementExpiryQueue.definition,
  identityFields: ["workflowId"],
  userFields: ["userId"],
});
